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
import { Plugin, TextSelection } from "prosemirror-state";
import { installMarkdownRuleOnce } from "./markdown-setup";

/** 转义 HTML 文本/属性里的特殊字符 */
function esc(s: string): string {  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 光标是否紧邻注音（**同一文本块内**，即视觉上的"左右两侧"）→ 是则返回展开位置 */
function adjacentRuby(view: any): number | null {
  const { selection } = view.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  const before = $from.nodeBefore;
  if (before && before.type.name === "ruby") return selection.from - before.nodeSize;
  const after = $from.nodeAfter;
  if (after && after.type.name === "ruby") return selection.from;
  return null;
}

/** 展开：注音节点 → 源码字面量 `{{Ruby|本体|读音}}`，光标保持原本所在的那一侧 */
function expandRubyAt(view: any, pos: number): boolean {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== "ruby") return false;
  const base = (node.attrs.base ?? "").trim();
  const rt = (node.attrs.rt ?? "").trim();
  if (!base || !rt) return false;
  const literal = `{{Ruby|${base}|${rt}}}`;
  const wasBefore = view.state.selection.from <= pos;
  const tr = view.state.tr.replaceWith(pos, pos + node.nodeSize, view.state.schema.text(literal));
  tr.setSelection(TextSelection.create(tr.doc, wasBefore ? pos : pos + literal.length));
  pendingLiteral = true;
  sawLiteralExpand = true; // 记住"本会话展开过"，此后收起不再依赖 pendingLiteral
  suppressAutoExpandOnce = true; // 展开动作自身引起的那次更新不参与判断
  view.dispatch(tr);
  return true;
}

/**
 * 把不在"编辑范围"内的字面量渲染回节点。
 *
 * **边界规则（用户明确定义）**：字面量区间 `[from, to]` 是**闭区间** ——
 * 光标停在**右端**（`}}` 之后那个位置，即 `to`）仍算在编辑中，**不收起**；
 * 只有越出这个区间（`to + 1`，即越过紧跟其后的字符，例如「：」）才收起。
 * 用开区间会让"停在右端"误判为已离开 → 收起 → 光标重映射到紧邻节点 → 又展开 → 抖动。
 *
 * `range` 给出时只扫该区间（打字时扫光标所在块，避免每次敲键遍历全文档）。
 * 返回是否还有"正在编辑中"（被跳过）的字面量。
 */
function convertLiterals(view: any, range?: { from: number; to: number }): boolean {
  const { state } = view;
  const sel = state.selection;
  const re = /\{\{Ruby\s*[|:]\s*([^|{}:]+?)\s*[|:]\s*([^|{}:]+?)\s*\}\}/g;
  const hits: { from: number; to: number; base: string; rt: string }[] = [];
  let skipped = 0;
  state.doc.nodesBetween(
    range ? range.from : 0,
    range ? range.to : state.doc.content.size,
    (node: any, pos: number) => {
      if (!node.isText || !node.text) return;
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(node.text))) {
        const from = pos + m.index;
        const to = from + m[0].length;
        // 闭区间：在字面量内、或贴着左右两端（含右端 to）→ 保持展开
        if (sel.from <= to && sel.to >= from) {
          skipped++;
          continue;
        }
        hits.push({ from, to, base: m[1].trim(), rt: m[2].trim() });
      }
    },
  );
  if (hits.length === 0) {
    /**
     * ⚠️ 只有**全文档扫描**（未给 range）才能改写"是否还有字面量"这个全局判断。
     * 块内扫描看不到别的块里的字面量，若也改写，就会把标志误清 —— 紧接着光标移到
     * 另一段时全文档扫描不再执行，那段字面量就永远收不起来
     *（实测："按方向键离开 Ruby 区不收起，除非撞到另一个 Ruby"）。
     */
    if (!range) pendingLiteral = skipped > 0;
    else if (skipped > 0) pendingLiteral = true;
    return pendingLiteral;
  }
  const tr = state.tr;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    const rubyType = state.schema.nodes.ruby;
    if (!rubyType) continue;
    tr.replaceWith(h.from, h.to, rubyType.create({ base: h.base, rt: h.rt }));
  }
  if (tr.docChanged) {
    suppressAutoExpandOnce = true; // 收起是我们自己造成的，那一次不参与判断
    view.dispatch(tr);
  }
  /**
   * 结束后的标志：**只有全文档扫描**才允许把它清零。
   * 块内扫描若发现"本块还有被跳过的字面量"，则保持它为真（提示别处也可能有）。
   */
  if (!range) pendingLiteral = skipped > 0;
  else if (skipped > 0) pendingLiteral = true;
  return pendingLiteral;
}

/** 还有字面量待收起 */
let pendingLiteral = false;
/** 一次性抑制：由我们自己的展开/收起引起的那次更新不参与邻近判断 */
let suppressAutoExpandOnce = false;
/** 自跟踪的组字状态（见 handleDOMEvents 的说明：不能只信 view.composing） */
let composingHere = false;
/**
 * 本次会话是否展开过注音（一经展开就置位，不再清除）。
 *
 * 为什么需要它：`pendingLiteral` 会被块内扫描/空扫描等路径清掉，日志实测它在
 * "输入法提交后按上键"那一刻是 false → 全文档扫描不执行 → 字面量收不起来。
 * 与其让"收起"依赖一个随时可能被清掉的标志，不如记住"本次会话出现过字面量"，
 * 之后每次光标移动都全文档扫一遍（扫描是正则遍历文本节点，普通笔记上是亚毫秒级）。
 */
let sawLiteralExpand = false;

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
     * `contenteditable="false"` 是消除闪烁的关键（行内原子节点的标准做法，同 @提及/行内图片）：
     * 没有它时，节点 DOM 里的文本对**浏览器**而言是"可放光标的普通文本"，
     * 原生选区会把光标放进 span 内部，而 ProseMirror 要求落在外侧 ——
     * 两者每帧互相纠正，表现为**拖选时不断闪烁**（方向性：从左往右尤甚）。
     * 加上之后浏览器把它当不可拆分的整体单元，内外一致，不再闪烁。
     */
    return [
      "span",
      {
        class: "md-ruby",
        "data-rt": node.attrs.rt ?? "",
        /**
         * 读音与本体各自的字符数，供 CSS 估算"读音是否比本体宽"。
         * 读音是绝对定位画上去的（不占布局），太长就会向两侧溢出压到相邻注音；
         * CSS 测不出文字宽度，所以用内联 CSS 变量把长度交给样式（内联变量最可靠，
         * 不依赖 attr() 的新语法）。
         */
        style: `--ruby-rt-len:${(node.attrs.rt ?? "").length};--ruby-base-len:${(node.attrs.base ?? "").length}`,
        contenteditable: "false",
      },
      node.attrs.base ?? "",
    ];
  },

  /**
   * 让注音的**本体**参与纯文本投影。
   *
   * 注音是 atom 节点、文字存在属性里，因此对"基于文本"的功能（查找、匹配计数、
   * textBetween 等）完全不可见 —— 这正是"Ctrl+F 搜不到 Ruby"的原因。
   * ProseMirror 的 leafText 正是声明"叶子节点贡献给 textBetween/textContent 的文本"。
   * TipTap 的 NodeConfig 不直接暴露该字段，所以用 extendNodeSchema 注入原始 NodeSpec。
   *
   * 只投影**本体**（base），不含读音（rt）：读音若也进入投影，会与 markdown 的
   * 位置映射（markdown-position-map）及序列化产生偏差，得不偿失。
   */
  extendNodeSchema() {
    return {
      leafText: (node: any) => node.attrs.base ?? "",
    };
  },

  /**
   * 就地编辑：**点击**注音或光标**移动到它左右两侧**即展开成源码字面量，直接改本体与读音；
   * 光标**越出字面量**（含停在其右端之后一格）就渲染回注音节点。
   *
   * 刻意不用 NodeView：NodeView 必须用 stopEvent 吞掉 mousedown 才能拿到点击，那样
   * ProseMirror 收不到点击、节点无法被选中，高亮等 mark 就都用不了（实测踩过）。
   */
  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            /**
             * 自跟踪组字状态（不能只信 view.composing）。
             *
             * 背景：PM 的 view.composing 靠 compositionend 事件复位，而某些输入法
             *（搜狗在"标点内联提交"等情况下）**不发这个事件** → 标志卡死为 true →
             * 守卫永久跳过 → 输完冒号后怎么移动光标都不收起（实测如此）。
             * 所以这里自己记一份，并且：
             *   - compositionstart/end 更新它；
             *   - 任何 keydown 若浏览器标注 isComposing === false，就认定已不在组字
             *    （方向键、Esc 等若真在组字中会被输入法吃掉，能到编辑器就说明已提交）。
             * 最终判定要求**两个标志同时为真**才跳过 —— 任一信号说"没在组字"就放行。
             */
            compositionstart: () => {
              composingHere = true;
              return false;
            },
            compositionend: () => {
              composingHere = false;
              return false;
            },
            keydown: (_view, event) => {
              const ke = event as KeyboardEvent;
              if (ke.isComposing === false) composingHere = false;
              return false;
            },
            /** 失焦同样说明输入告一段落 */
            blur: () => {
              composingHere = false;
              return false;
            },
            /**
             * 左键单击注音 → 展开。光标按点击落在左半/右半决定（左半 → 左端，右半 → 右端）。
             */
            mousedown: (view, event) => {
              const me = event as MouseEvent;
              // 鼠标操作必然不在组字中：有的输入法提交后不发 compositionend，
              // 靠这里（以及 keydown/blur）兜底解除组字标志，否则守卫会一直卡住。
              composingHere = false;
              if (me.button !== 0) return false;
              const rubyEl = (me.target as HTMLElement | null)?.closest?.(
                "span.md-ruby",
              ) as HTMLElement | null;
              if (!rubyEl) return false;
              let pos: number;
              try {
                pos = view.posAtDOM(rubyEl, 0);
              } catch {
                return false;
              }
              if (!expandRubyAt(view, pos)) return false;
              me.preventDefault();
              return true;
            },
          },
        },
        /**
         * 自动展开 / 收起：
         *
         * - **邻近判断放在所有早退之前**，所以每次更新都会执行（空闲更新也算）——
         *   这正是"光标在注音左右两侧就展开"。
         * - 文档变化时只扫**光标所在的文本块**，覆盖"把 `}}` 提前打出来"等输入规则未命中的情况。
         * - 光标越出字面量的闭区间即收起（右端仍算在内，见 convertLiterals 的说明）。
         * - `view.composing` 期间绝不动文档：否则输入法组字被打断会重复出字。
         */
        view: () => ({
          update: (view: any, prevState: any) => {
            /**
             * ⚠️ 只用**自己跟踪**的组字标志，不与 view.composing 取"与"。
             *
             * 取"与"看似更安全，实际会造成卡死：有的输入法（Sogou / Google 日语输入法都遇到过）
             * 提交后**不发 compositionend**，于是两个标志里总有一个残留为真，守卫永不解除 →
             * 输完标点后怎么移动光标都不收起。
             * 自己的标志有多个可靠的解除信号（compositionend / 非组字 keydown / 鼠标 / 失焦），
             * 所以以它为准。
             *
             * 组字期间不动文档的原因：此时 dispatch（展开/收起）会打断输入法的组合并重新提交 →
             * 表现为"字符重复出现"（打一个「：」出现两个）。
             */
            if (composingHere) return;

            const docChanged = !view.state.doc.eq(prevState.doc);
            const selChanged = !view.state.selection.eq(prevState.selection);
            const internal = suppressAutoExpandOnce;
            suppressAutoExpandOnce = false;

            // ① 自动展开：每次更新都判断
            if (!internal) {
              const near = adjacentRuby(view);
              if (near !== null && expandRubyAt(view, near)) return;
            }

            if (!docChanged && !selChanged && !pendingLiteral) return;

            // ② 文档变化：只扫光标所在块（便宜）
            if (docChanged) {
              const $from = view.state.selection.$from;
              convertLiterals(view, { from: $from.start(), to: $from.end() });
            }

            /**
             * ③ 全文档扫描（收起）。
             * 条件是"还有字面量"**或**"本次会话展开过注音" —— 后者保证标志被误清时
             * 收起依然有效（日志实测：输入法提交那一刻 pending 为 false，导致不收起）。
             */
            if (pendingLiteral || sawLiteralExpand) convertLiterals(view);
          },
        }),
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
