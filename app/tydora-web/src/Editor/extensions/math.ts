import { Extension, type CommandProps } from "@tiptap/core";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { Fragment } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";
import type MarkdownIt from "markdown-it";

// ============================================================================
// \[ ... \] 显式转换（右键「插入 → 公式块」触发，不做自动解析）
// 序列化会把字面方括号转义成 \[ \]，自动认 \[ 为公式必误伤旧笔记；
// 故仅在用户主动唤出公式块时，识别选区/光标所及的 \[...\] 并忽略分隔符。
// ============================================================================

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    math: {
      /** 把 \[...\] / 回车分隔符区间替换为 blockMath（保留前后文字与 marks） */
      replaceRangeWithBlockMath: (opts: { from: number; to: number; latex: string }) => ReturnType;
    };
  }
}

/**
 * 粘贴文本预处理：把 \[...\] 包裹之公式块改写为 $$...$$（用户要求粘贴即转）。
 * 跨段形（独占行的 \[ / \]，含裸形）与同行转义形皆改；代码围栏内不动；
 * 同行裸 [x] 或为散文括號，不动。改写发生在 markdown 解析之前，故反斜杠尚在。
 */
export function rewriteBracketMathInText(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inFence = false;
  let fenceChar = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trim = line.trim();
    const fence = /^(```+|~~~+)/.exec(trim);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceChar = fence[1][0];
      } else if (fence[1][0] === fenceChar && trim.replace(/[`~]/g, "") === "") {
        inFence = false;
      }
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (trim === "\\[" || trim === "[") {
      let j = i + 1;
      let close = -1;
      const inner: string[] = [];
      for (; j < lines.length; j++) {
        const t2 = lines[j].trim();
        if (t2 === "\\]" || t2 === "]") {
          close = j;
          break;
        }
        if (t2 === "\\[" || t2 === "[" || /^(```|~~~)/.test(t2)) break;
        inner.push(lines[j]);
      }
      if (close >= 0 && inner.some((s) => s.trim() !== "")) {
        const indent = line.slice(0, line.length - trim.length);
        const cline = lines[close];
        out.push(indent + "$$");
        out.push(...inner);
        out.push(cline.slice(0, cline.length - cline.trim().length) + "$$");
        i = close;
        continue;
      }
    }
    out.push(line.replace(/\\\[([^\]\n]+?)\\\]/g, (_m, inner: string) => "$$" + inner + "$$"));
  }
  return out.join("\n");
}

/**
 * 粘贴 HTML 预处理：把 \[...\] 包裹之公式块改写为 $$...$$（网页复制走 HTML 通道，
 * 不经 transformPastedText，故须在此改）。跨段形按「叶块」序配对（独占块之 \[ / \]，含裸形）；
 * 同行转义形逐文本节点改；pre/code 内不动。改写后交 PM 解析，$$ 再由 template-live 收拢。
 */
export function rewriteBracketMathInHtml(html: string): string {
  if (!html.includes("[") && !html.includes("data-math-source")) return html;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inCode = (el: Element | null): boolean => {
    let p = el;
    while (p) {
      if (p.tagName === "PRE" || p.tagName === "CODE") return true;
      p = p.parentElement;
    }
    return false;
  };
  // 块级 latex 拆成 $$ / 本体逐行 / $$ 三段（文本节点不能含换行，PM 解析会折叠）；
  // 单行则 $$latex$$ 一段，交 template-live 收拢
  const blockHtml = (latex: string): string => {
    const lines = latex.split("\n");
    if (lines.length === 1) return `<p>$$${esc(latex)}$$</p>`;
    return `<p>$$</p>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}<p>$$</p>`;
  };
  // ChatGPT 等网页复制带 data-math-source（权威纯 latex）→ 直接取之，免解析分隔符
  for (const el of Array.from(parsed.body.querySelectorAll("[data-math-source]"))) {
    if (inCode(el)) continue;
    const latex = el.getAttribute("data-math-source") || "";
    if (!latex.trim()) continue;
    const display = el.getAttribute("data-math-display") !== "false";
    if (display) {
      el.insertAdjacentHTML("afterend", blockHtml(latex));
      el.remove();
    } else {
      // 行内：原地换文本节点，保住所在段落之上下文
      el.replaceWith(parsed.createTextNode("$" + latex + "$"));
    }
  }
  const BLOCK = "p,div,li,h1,h2,h3,h4,h5,h6,blockquote";
  const leaves = Array.from(parsed.body.querySelectorAll(BLOCK)).filter(
    (el) => !el.querySelector(BLOCK),
  );
  let open = -1;
  for (let i = 0; i < leaves.length; i++) {
    const t = (leaves[i].textContent || "").trim();
    // 单个文本节点内跨行之 \[...\]（ChatGPT 之 div>span 即此形，无 data-math-source 时亦收）
    const wrapped =
      (t.startsWith("\\[") && t.endsWith("\\]") && t.length > 4) ||
      (t.startsWith("[") && t.endsWith("]") && t.length > 2);
    if (wrapped && t.includes("\n") && !inCode(leaves[i])) {
      const inner = t.slice(t.startsWith("\\[") ? 2 : 1, t.endsWith("\\]") ? -2 : -1).trim();
      if (inner) {
        leaves[i].insertAdjacentHTML("afterend", blockHtml(inner));
        leaves[i].remove();
        open = -1;
        continue;
      }
    }
    if (t === "\\[" || t === "[") {
      open = i;
    } else if ((t === "\\]" || t === "]") && open >= 0) {
      const inner = leaves.slice(open + 1, i);
      if (inner.length > 0 && inner.some((el) => (el.textContent || "").trim() !== "")) {
        leaves[open].textContent = "$$";
        leaves[i].textContent = "$$";
      }
      open = -1;
    }
  }
  // 4 = NodeFilter.SHOW_TEXT（jsdom 全局无 NodeFilter，用字面量免 ReferenceError）
  const walker = parsed.createTreeWalker(parsed.body, 4);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  for (const tn of texts) {
    if (inCode(tn.parentElement)) continue;
    const v = tn.nodeValue || "";
    if (v.includes("\\[")) tn.nodeValue = v.replace(/\\\[([^\]\n]+?)\\\]/g, (_m, inner: string) => "$$" + inner + "$$");
  }
  return parsed.body.innerHTML;
}

/** 削掉latex外层包裹的分隔符（\[ \] / [ ] / $$ / $）：旧版误插的节点自带分隔符，编辑时须还原纯本体 */
export function stripMathDelimiters(latex: string): string {
  let s = latex.trim();
  if (s.startsWith("\\[") && s.endsWith("\\]") && s.length > 4) s = s.slice(2, -2);
  else if (s.startsWith("[") && s.endsWith("]") && s.length > 2) s = s.slice(1, -1);
  else if (s.startsWith("$$") && s.endsWith("$$") && s.length > 4) s = s.slice(2, -2);
  else if (s.startsWith("$") && s.endsWith("$") && s.length > 2) s = s.slice(1, -1);
  return s.trim();
}

export interface BracketMathRange {
  from: number;
  to: number;
  latex: string;
  multiline: boolean;
}

const BRACKET_SKIP_BLOCKS = new Set(["codeBlock", "code_block", "frontmatter"]);

/** 找选区/光标所及的 \[...\]（选区自带、选区为本体两侧贴分隔符、同段、跨段四形） */
export function findBracketMathRange(state: any, from: number, to: number): BracketMathRange | null {
  const doc = state.doc;
  // 光标贴着/落在「latex 自带分隔符」的旧误插节点上 → 整节点替换为干净公式
  if (from === to) {
    const $f = doc.resolve(from);
    const nb = $f.nodeBefore;
    const na = $f.nodeAfter;
    const node = nb && (nb.type.name === "blockMath" || nb.type.name === "inlineMath") ? nb : na && (na.type.name === "blockMath" || na.type.name === "inlineMath") ? na : null;
    if (node) {
      const raw = (node.attrs.latex as string) || "";
      const clean = stripMathDelimiters(raw);
      if (clean !== raw.trim()) {
        const nodePos = node === nb ? from - node.nodeSize : from;
        return { from: nodePos, to: nodePos + node.nodeSize, latex: clean, multiline: /\n/.test(clean) };
      }
    }
  }
  const selText = from < to ? doc.textBetween(from, to, "\n", "￼") : "";
  // 选区自带分隔符：\[...\] 或裸 [...]（存盘再读时反斜杠被 CommonMark 转义吃掉，
  // 显式选区即意图，裸形也收）
  const openLen = selText.startsWith("\\[") ? 2 : selText.startsWith("[") ? 1 : 0;
  const closeLen = selText.endsWith("\\]") ? 2 : selText.endsWith("]") ? 1 : 0;
  if (openLen > 0 && closeLen > 0 && selText.length > openLen + closeLen) {
    const latex = selText.slice(openLen, selText.length - closeLen);
    return { from, to, latex, multiline: /\n/.test(latex) };
  }
  if (from < to) {
    // 注意：本模块导出名为 Math 的扩展，模块内 Math 已被遮蔽 → 用 globalThis.Math
    const b2 = doc.textBetween(globalThis.Math.max(0, from - 2), from);
    const a2 = doc.textBetween(to, globalThis.Math.min(doc.content.size, to + 2));
    const ob = b2 === "\\[" ? 2 : b2.endsWith("[") ? 1 : 0;
    const cb = a2 === "\\]" ? 2 : a2.startsWith("]") ? 1 : 0;
    if (ob > 0 && cb > 0) {
      return { from: from - ob, to: to + cb, latex: selText, multiline: /\n/.test(selText) };
    }
  }
  const textish = (n: any): boolean => {
    let ok = true;
    n.content.forEach((c: any) => {
      if (!c.isText && c.type.name !== "hardBreak") ok = false;
    });
    return ok;
  };
  const blocks: Array<[number, any]> = [];
  doc.descendants((n: any, pos: number) => {
    if (n.isTextblock && !BRACKET_SKIP_BLOCKS.has(n.type.name)) blocks.push([pos, n]);
  });
  const cands: BracketMathRange[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const [pos, n] = blocks[i];
    const t = n.textContent as string;
    const isOpen = t.trim() === "\\[" || t.trim() === "[";
    if (n.type.name === "paragraph" && isOpen && textish(n)) {
      const inner: string[] = [];
      let close = -1;
      let closeSize = 0;
      let j = i + 1;
      for (; j < blocks.length; j++) {
        const [p, m] = blocks[j];
        if (m.type.name !== "paragraph" || !textish(m)) break;
        const mt = m.textContent as string;
        if (mt.trim() === "\\]" || mt.trim() === "]") {
          close = p;
          closeSize = m.nodeSize;
          break;
        }
        if (mt.includes("\\[") || mt.trim() === "[") break;
        inner.push(mt);
      }
      if (close >= 0 && inner.length > 0) {
        cands.push({ from: pos, to: close + closeSize, latex: "\n" + inner.join("\n\n") + "\n\n", multiline: true });
        i = j;
        continue;
      }
    }
    const re = /\\\[([^\]\n]+?)\\\]/g;
    let m2: RegExpExecArray | null;
    while ((m2 = re.exec(t)) !== null) {
      const f = pos + 1 + m2.index;
      const $f = doc.resolve(f);
      if ($f.marks().some((mk: any) => mk.type.name === "code")) continue;
      cands.push({ from: f, to: f + m2[0].length, latex: m2[1], multiline: false });
    }
  }
  for (const c of cands) {
    const touched = from < to ? c.from <= to && c.to >= from : c.from <= from && c.to >= from;
    if (touched) return c;
  }
  return null;
}

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
  addCommands() {
    return {
      /**
       * 把区间（\[...\] 字面量或回车留下的 $ / $$）替换为 blockMath：
       * 跨块区间直接整段替换；同段中段者重建为 [段, blockMath, 段]，
       * 保留前后 marks 与行内节点；光标落到公式之后续输。
       */
      replaceRangeWithBlockMath:
        ({ from, to, latex }: { from: number; to: number; latex: string }) =>
        ({ tr, dispatch }: CommandProps) => {
          const schema = this.editor.schema;
          const node = schema.nodes.blockMath.create({ latex, multiline: /\n/.test(latex) });
          tr.delete(from, to);
          let nodePos = from;
          const $p = tr.doc.resolve(from);
          const parent = $p.parent;
          if (!parent.isTextblock) {
            tr.insert(from, node);
          } else {
            const off = $p.parentOffset;
            const before = parent.content.cut(0, off);
            const after = parent.content.cut(off, parent.content.size);
            const pPos = $p.before();
            if (before.size === 0 && after.size === 0) {
              tr.replaceWith(pPos, pPos + parent.nodeSize, node);
              nodePos = pPos;
            } else {
              const nodes: any[] = [];
              if (before.size > 0) {
                const para = parent.type.create(parent.attrs, before);
                nodes.push(para);
                nodePos = pPos + para.nodeSize;
              } else {
                nodePos = pPos;
              }
              nodes.push(node);
              if (after.size > 0) nodes.push(parent.type.create(parent.attrs, after));
              tr.replaceWith(pPos, pPos + parent.nodeSize, Fragment.fromArray(nodes));
            }
          }
          // 公式后可能是块末 gap（无文本块）：gap 光标合法，续输由 PM 自动成段
          tr.setSelection(TextSelection.create(tr.doc, nodePos + node.nodeSize));
          if (dispatch) dispatch(tr);
          return true;
        },
    };
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
