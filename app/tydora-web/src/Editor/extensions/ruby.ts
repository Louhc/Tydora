// src/Editor/extensions/ruby.ts
//
// 平假名注音（ruby / furigana）。
//
// 语法：`{{Ruby|漢字|かんじ}}`（MediaWiki 写法，你的首选）。
//
//   表格问题及解决：`|` 是 GFM 表格的单元格分隔符，而表格切分发生在块级阶段、
//   早于 inline 规则 —— 直接写会在表格里被切成三格。本扩展用一个**等长占位符**在
//   块级阶段（`table` 规则之前）把 `{{Ruby|…}}` 内部的竖线换掉：等长所以不影响任何
//   偏移（含 markdown→PM 位置映射），不含竖线所以表格不会被切开，inline 阶段再还原。
//   另外也接受 `{{Ruby:漢字:かんじ}}`（无竖线写法）作为备用。
//
// 存储：`.md` 里写 `{{Ruby|漢字|かんじ}}`（想让文件在 GitHub/Obsidian 里直接渲染成注音，
//       把 serialize 那一行改成输出 `<ruby>` 即可）。
// 兼容：同时能解析裸 HTML `<ruby>漢字<rt>かんじ</rt></ruby>`，方便从别处粘贴。
// 渲染：输出 `<ruby>漢字<rt>かんじ</rt></ruby>`，样式见 Editor/theme.css 的 .md-ruby。
//
// 实现范式与 extensions/tag.ts 完全一致：
//   - addInputRules：输入 `{{Ruby|…}}` 即时转成节点；
//   - addStorage().markdown.serialize：存盘写回简写；
//   - addStorage().markdown.parse.setup：解析时先把简写替换成 ruby 标签，
//     再由 parseHTML 还原成节点（否则打开已有文件不显示注音）。

import { InputRule, Node } from "@tiptap/core";
import { Plugin } from "prosemirror-state";
import { installMarkdownRuleOnce } from "./markdown-setup";
import { openRubyEditor } from "./ruby-edit-popover";

/** 转义 HTML 文本/属性里的特殊字符 */
function esc(s: string): string {  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const Ruby = Node.create({
  name: "ruby",

  inline: true,
  group: "inline",
  /**
   * ⚠️ 不要设 atom: true。
   *
   * ProseMirror 里 `atom` 的语义是"连文本选区都不会包含它"（inline 图片那种行为）——
   * 于是**拖选经过注音时会被跳过**，从右往左划永远划不进去，高亮/文字颜色这类基于
   * 选区的 mark 也就无法作用于它（实测踩了两次）。
   *
   * 这个节点本来就没有 content（base/rt 放在 attrs 里、由 renderHTML 输出），
   * 所以不带 atom 也依然是"叶子、内部进不去"，但**可以被文本选区正常覆盖**。
   */


  addAttributes() {
    return {
      base: { default: null },
      rt: { default: null },
    };
  },

  parseHTML() {
    return [
      // 主形式：本节点自己输出的 DOM（单元素 + 单文本节点，注音在 data-rt 里）
      {
        tag: "span.md-ruby",
        getAttrs: (element) => {
          const el = element as HTMLElement;
          const base = (el.textContent ?? "").trim();
          const rt = (el.getAttribute("data-rt") ?? "").trim();
          if (!base || !rt) return false;
          return { base, rt };
        },
      },
      // 兼容：从别处粘贴的裸 HTML <ruby>…<rt>…</rt></ruby>
      {
        tag: "ruby",
        getAttrs: (element) => {
          const el = element as HTMLElement;
          const rt = (el.querySelector("rt")?.textContent ?? "").trim();
          const clone = el.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
          const base = (clone.textContent ?? "").trim();
          if (!base || !rt) return false;
          return { base, rt };
        },
      },
    ];
  },

  renderHTML({ node }) {
    /**
     * ⚠️ DOM 里**只能有一个文本节点**：节点本身输出一个 `<span>`，内容就是 base；
     * 注音 rt 放在 data-rt 属性里，由 CSS 的 ::after 画到文字上方（见 theme.css 的 .md-ruby）。
     *
     * 为什么必须这样：ProseMirror 按"一个文档节点 ↔ 一个 DOM 节点、其文本即节点文本"
     * 映射位置。之前用 <ruby>+<span>+<rt> 的嵌套结构时，叶子节点里出现了多个子元素，
     * 边界位置解析不稳定 —— 表现为**拖选时选区不断闪烁**、且注音无法作为选区边界。
     */
    return ["span", { class: "md-ruby", "data-rt": node.attrs.rt ?? "" }, node.attrs.base ?? ""];
  },

  /**
   * 就地编辑（方案 B）：**双击**节点弹出两行小浮层（上行注音 rt、下行本体 base）。
   *
   * 这里刻意**不用 NodeView**：NodeView 必须用 stopEvent 吞掉 mousedown 才能拿到点击，
   * 而那样 ProseMirror 就收不到点击、节点**永远无法被选中** —— 高亮、文字颜色等 mark
   * 就都用不了（实测踩过）。改用 DOM 事件插件：单击保持正常选中，双击才进编辑。
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            dblclick: (view, event) => {
              const target = event.target as HTMLElement | null;
              const rubyEl = target?.closest?.("ruby.md-ruby") as HTMLElement | null;
              if (!rubyEl) return false;
              let pos: number;
              try {
                // posAtDOM(el, 0) = 该节点在文档中的起始位置（这里正好是 atom 节点自身的位置）
                pos = view.posAtDOM(rubyEl, 0);
              } catch {
                return false;
              }
              event.preventDefault();
              openRubyEditor({ editor: this.editor, getPos: () => pos, anchor: rubyEl });
              return true;
            },
          },
        },
      }),
    ];
  },

  addInputRules() {
    return [
      // 输入 {{Ruby|漢字|かんじ}} / {{Ruby | 漢字 | かんじ}}（空格可选）→ 立即转成注音节点。
      // 输入阶段不涉及表格切分（那只在解析 Markdown 时发生），所以竖线写法在这里没问题。
      new InputRule({
        find: /\{\{Ruby\s*[|:]\s*([^|{}:]+?)\s*[|:]\s*([^|{}:]+?)\}\}$/,
        handler: ({ range, match, commands }) => {
          const base = match[1]?.trim();
          const rt = match[2]?.trim();
          if (!base || !rt) return;
          commands.insertContentAt(range, { type: "ruby", attrs: { base, rt } });
        },
      }),
    ];
  },
}).extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const base = node.attrs.base ?? "";
          const rt = node.attrs.rt ?? "";
          if (!base || !rt) return;
          // 写回竖线写法（你的首选写法，且表格内已由 md_ruby_pipe_guard 保护）。
          // 想让文件在 GitHub/Obsidian 里直接渲染成注音，把这里改成输出
          // <ruby>base<rt>rt</rt></ruby> 即可。
          state.write(`{{Ruby|${base}|${rt}}}`);
        },
        parse: {
          setup(markdownit: any) {
            if (!installMarkdownRuleOnce(markdownit, "md_ruby")) return;
            /**
             * 通用表格保护：**必须在 `table` 规则之前**跑。
             *
             * 凡是 `{{…}}` 内部含竖线的写法，在表格里都会被 GFM 的单元格切分破坏
             *（如 `{{Ruby|浮|う}}` → `{{Ruby` / `浮` / `う}}`）。这里把 `{{…}}` 内部的竖线
             * 换成**等长**占位符 U+0001：
             *   - 等长 → 行标记与各种偏移（含 markdown→PM 位置映射）完全不变；
             *   - 不含竖线 → 表格不再切开它，inline 阶段再按命令还原。
             * 用通用 `{{…}}` 而不是写死 Ruby，是为了以后扩展语法时这里不用再动。
             */
            markdownit.block.ruler.before("table", "md_wrapper_pipe_guard", (mdState: any) => {
              const src: string = mdState.src ?? "";
              if (!src.includes("{{")) return false;
              const guarded = src
                .split("\n")
                .map((line: string) =>
                  /^\s*\|.*\|\s*$/.test(line)
                    ? line.replace(
                        /\{\{([^{}]*)\}\}/g,
                        (_m: string, inner: string) => `{{${inner.replace(/\|/g, "\u0001")}}}`,
                      )
                    : line,
                )
                .join("\n");
              if (guarded !== src) mdState.src = guarded;
              return false; // 只改写源，不自己产出 token
            });

            // 通用外壳解析：先匹配 `{{…}}`，再按内部命令分派（目前只有 Ruby）。
            // 以后加新语法（例如 {{注|…}}、{{拼音|…}}）只需在这里加分支。
            const RUBY_INNER = /^Ruby\s*[|:\u0001]\s*([^|:\u0001]*?)\s*[|:\u0001]\s*([^|:\u0001]*?)$/;
            markdownit.core.ruler.before("inline", "md_wrapper", (mdState: any) => {
              mdState.tokens.forEach((token: any) => {
                if (token.type !== "inline" || !token.content || !token.content.includes("{{")) return;
                token.content = token.content.replace(
                  /\{\{\s*([^{}]+?)\s*\}\}/g,
                  (whole: string, inner: string) => {
                    const m = RUBY_INNER.exec(inner);
                    // 未知命令：把表格保护用的占位符还原成竖线后原样保留，
                    // 免得 \u0001 这种控制字符漏进正文（以后扩展语法时这里也不用改）。
                    if (!m) return whole.replace(/\u0001/g, "|");
                    const base = m[1].trim();
                    const rt = m[2].trim();
                    if (!base || !rt) return whole.replace(/\u0001/g, "|");
                    // 输出与 renderHTML 一致的**单元素 + data-rt** 结构：
                    // 不要产出 <ruby>+<rt> 的嵌套结构，那样会让叶子节点里出现多个子元素，
                    // 导致 ProseMirror 的选区边界解析不稳定（拖选闪烁、无法以它为边界）。
                    return `<span class="md-ruby" data-rt="${esc(rt)}">${esc(base)}</span>`;
                  },
                );
              });
            });
          },
        },
      },
    };
  },
});
