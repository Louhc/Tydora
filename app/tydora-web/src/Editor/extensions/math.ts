import { Extension } from "@tiptap/core";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import type MarkdownIt from "markdown-it";

// ============================================================================
// markdown-it 数学插件
// 解析行内 $...$ 与块级 $$...$$（支持跨行），渲染为 Tydora 数学节点 DOM
// （span[data-type="inline-math"] / div[data-type="block-math"]），
// 再由 ProseMirror DOMParser 还原为 inlineMath / blockMath 节点。
// 分隔符校验规则借鉴 markdown-it-mathjax3，可避免误判货币、价格等场景。
// ============================================================================

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // 换行转字符引用：HTML 解析器会把属性值中的字面换行规范化为空格，导致多行公式丢失换行
    .replace(/\n/g, "&#10;");
}

/** 判断 $ 是否为合法分隔符（前后空格 / 后跟数字均不合法） */
function isValidDelim(state: any, pos: number) {
  const max = state.posMax;
  let canOpen = true;
  let canClose = true;
  const prevChar = pos > 0 ? state.src.charCodeAt(pos - 1) : -1;
  const nextChar = pos + 1 <= max ? state.src.charCodeAt(pos + 1) : -1;
  // 前一位是空格/制表符，或后一位是数字时，不能作为闭合符（避免把「价格 $5」误判为数学）
  if (prevChar === 32 || prevChar === 9 || (nextChar >= 48 && nextChar <= 57)) {
    canClose = false;
  }
  // 后一位是空格/制表符时，不能作为开始符
  if (nextChar === 32 || nextChar === 9) {
    canOpen = false;
  }
  return { canOpen, canClose };
}

/** 行内 $...$ */
function mathInline(state: any, silent: boolean) {
  if (state.src[state.pos] !== "$") return false;
  // `$$` 一律块级（哪怕写在同一行），行内规则不得接手（用户要求）：
  // 既跳过「左 $ 的右邻是 $」，也跳过「右 $ 的左邻是 $」（否则 $$x$$ 会被拆出 $x$）
  if (state.src[state.pos + 1] === "$") return false;
  if (state.pos > 0 && state.src[state.pos - 1] === "$") return false;

  const res = isValidDelim(state, state.pos);
  if (!res.canOpen) {
    if (!silent) state.pending += "$";
    state.pos += 1;
    return true;
  }

  const start = state.pos + 1;
  let match = start;
  while ((match = state.src.indexOf("$", match)) !== -1) {
    // 找到闭合 $（前面不能是奇数个反斜杠，即转义过的 $）
    let pos = match - 1;
    while (state.src[pos] === "\\") pos -= 1;
    if ((match - pos) % 2 === 1) break;
    match += 1;
  }

  if (match === -1) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }
  if (match - start === 0) {
    if (!silent) state.pending += "$$";
    state.pos = start + 1;
    return true;
  }

  const resClose = isValidDelim(state, match);
  if (!resClose.canClose) {
    if (!silent) state.pending += "$";
    state.pos = start;
    return true;
  }

  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.markup = "$";
    token.content = state.src.slice(start, match);
  }
  state.pos = match + 1;
  return true;
}

/** 块级 $$...$$（支持跨行） */
function mathBlock(state: any, start: number, end: number, silent: boolean) {
  let next = start;
  let lastPos = 0;
  let found = false;
  let pos = state.bMarks[start] + state.tShift[start];
  let max = state.eMarks[start];
  let lastLine = "";

  if (pos + 2 > max) return false;
  if (state.src.slice(pos, pos + 2) !== "$$") return false;

  pos += 2;
  let firstLine = state.src.slice(pos, max);

  // 起始行直接闭合：$$...$$（单行形态，content 不补换行，序列化逐字节还原）
  let singleLine = false;
  if (firstLine.trim().slice(-2) === "$$") {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
    singleLine = true;
  }

  while (!found) {
    next++;
    if (next >= end) break;
    pos = state.bMarks[next] + state.tShift[next];
    max = state.eMarks[next];
    if (pos < max && state.tShift[next] < state.blkIndent) break;
    // 以 $$ 结尾的行作为闭合行
    if (state.src.slice(pos, max).trim().slice(-2) === "$$") {
      lastPos = state.src.slice(0, max).lastIndexOf("$$");
      lastLine = state.src.slice(pos, lastPos);
      found = true;
    }
  }

  // 未找到闭合 $$ → 不是块级公式（孤立的左 $$ 留给即时转换/回车弹窗处理）
  if (!found) return false;
  if (silent) return true;

  state.line = next + 1;
  const token = state.push("math_block", "math", 0);
  token.block = true;
  token.content =
    (firstLine && firstLine.trim() ? firstLine + (singleLine ? "" : "\n") : "") +
    state.getLines(start + 1, next, state.tShift[start], true) +
    (lastLine && lastLine.trim() ? lastLine : "");
  token.map = [start, state.line];
  token.markup = "$$";
  return true;
}

export interface MathMarkdownItRenderer {
  inline?: (latex: string) => string;
  block?: (latex: string) => string;
}

/**
 * markdown-it 数学插件
 * 默认输出 Tydora 数学节点 DOM；传入 renderer 可自定义输出（如 KaTeX HTML）
 */
export function mathMarkdownItPlugin(md: MarkdownIt, renderer?: MathMarkdownItRenderer) {
  md.inline.ruler.after("escape", "math_inline", mathInline as any);
  md.block.ruler.after("blockquote", "math_block", mathBlock as any, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });
  md.renderer.rules.math_inline = (tokens: any, idx: number) =>
    renderer?.inline?.(tokens[idx].content) ??
    `<span data-type="inline-math" data-latex="${escapeHtml(tokens[idx].content)}"></span>`;
  md.renderer.rules.math_block = (tokens: any, idx: number) => {
    if (renderer?.block) return renderer.block(tokens[idx].content);
    // 跨行源码记 multiline，序列化时还原多行形态（单行 $$x$$ 保持单行，逐字节一致）
    const map = tokens[idx].map;
    const multiline = Array.isArray(map) && map[1] - map[0] > 1;
    return `<div data-type="block-math" data-latex="${escapeHtml(tokens[idx].content)}"${multiline ? ' data-multiline="1"' : ""}></div>`;
  };
}

// ============================================================================
// Math 扩展：行内数学 + 块级数学（KaTeX 渲染）
// ============================================================================

export interface MathOptions {
  /** 点击公式时回调（node, pos） */
  onClick?: (node: any, pos: number) => void;
  /** KaTeX 渲染选项 */
  katexOptions?: Record<string, unknown>;
}

export const Math = Extension.create<MathOptions>({
  name: "math",
  addOptions() {
    return { onClick: undefined, katexOptions: undefined };
  },
  addKeyboardShortcuts() {
    return {
      /**
       * 打出左 `$$`（或先打的右 `$$`，字符相同）按回车 → 直接弹块级公式编辑框；
       * 左 `$` 按回车 → 弹行内公式编辑框。回车被吞掉，不成换行；
       * 分隔符留在原处，弹窗确认时由 TipTapEditor 删除并替换为公式节点（取消则还原）。
       */
      Enter: () => {
        const editor = this.editor;
        const { state } = editor;
        const sel = state.selection;
        if (!sel.empty) return false;
        const $from = sel.$from;
        const parent = $from.parent;
        if (!parent.isTextblock || parent.type.spec.code) return false;
        const before = parent.textBetween(0, $from.parentOffset, undefined, "￼");
        let delimLen = 0;
        let block = false;
        if (before.endsWith("$$") && before[before.length - 3] !== "$" && before[before.length - 3] !== "\\") {
          delimLen = 2;
          block = true;
        } else if (before.endsWith("$") && before[before.length - 2] !== "$" && before[before.length - 2] !== "\\") {
          delimLen = 1;
          block = false;
        }
        if (delimLen === 0) return false;
        window.dispatchEvent(
          new CustomEvent("math-dialog-open", {
            detail: {
              latex: "",
              block,
              replaceFrom: sel.from - delimLen,
              replaceTo: sel.from,
            },
          }),
        );
        return true;
      },
    };
  },
  addExtensions() {
    const { onClick, katexOptions } = this.options;
    return [
      InlineMath.extend({
        addOptions() {
          return { onClick, katexOptions };
        },
        // 内置 input rule 会把同一行的 $$x$$ 抢成行内公式 ✗；即时转换统一由
        // template-live 插件负责（$..$ 行内、$$..$$ 块级），此处禁用内置规则
        addInputRules() {
          return [];
        },
        addStorage() {
          return {
            markdown: {
              parse: {
                // 解析规则在此统一注册（含行内与块级），BlockMath 无需重复注册
                setup: mathMarkdownItPlugin,
                updateDOM() {},
              },
              serialize(state: any, node: any) {
                const latex = (node.attrs.latex as string) || "";
                state.write("$" + latex + "$");
              },
            },
          };
        },
      }),
      BlockMath.extend({
        addOptions() {
          return { onClick, katexOptions };
        },
        // 同 InlineMath：禁用内置 $$$ input rule，即时转换交给 template-live
        addInputRules() {
          return [];
        },
        addAttributes() {
          return {
            // extend 的 addAttributes 会整体覆盖父级 → latex 须在此重声明
            latex: {
              default: "",
              parseHTML: (el: HTMLElement) => el.getAttribute("data-latex"),
              renderHTML: (attrs: any) => ({ "data-latex": attrs.latex }),
            },
            // 源码是否跨行：单行 $$x$$ 序列化回单行，跨行还原多行（逐字节一致）
            multiline: {
              default: false,
              parseHTML: (el: HTMLElement) => el.getAttribute("data-multiline") === "1",
              renderHTML: (attrs: any) => (attrs.multiline ? { "data-multiline": "1" } : {}),
            },
          };
        },
        addStorage() {
          return {
            markdown: {
              parse: {
                setup() {},
                updateDOM() {},
              },
              serialize(state: any, node: any) {
                const latex = (node.attrs.latex as string) || "";
                state.ensureNewLine();
                if (node.attrs.multiline) {
                  // latex 逐字节写回（getLines 产物自带尾换行/空行）；仅兜底补一个尾换行免闭合 glued
                  const body = latex.endsWith("\n") ? latex : latex + "\n";
                  state.write("$$\n");
                  state.text(body, false);
                  state.write("$$");
                } else {
                  state.write("$$" + latex + "$$");
                }
                state.closeBlock(node);
              },
            },
          };
        },
      }),
    ];
  },
});
