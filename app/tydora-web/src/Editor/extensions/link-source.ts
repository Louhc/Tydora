/**
 * 链接字面量节点：让**超链接与注音使用同一套「光标贴近就展开、离开就收起」的逻辑**。
 *
 * ## 为什么不能照抄注音的「纯文本字面量」
 *
 * 注音能安心地在「节点 ↔ 纯文本」之间来回切，是因为 `{{Ruby|漢字|かんじ}}` 作为
 * 纯文本序列化出来与节点输出**逐字节相同**（花括号不在 prosemirror-markdown 的
 * 转义集里）。
 *
 * 链接则不然：`[文字](地址)` 里的方括号**在转义集里** —— 作为纯文本会被写成
 * `\[文字\](地址)`（显示难看，而且自动保存会把这个转义版写进磁盘；CLAUDE.md
 * 里记着这条隐患，旧实现正因如此才只敢用 Alt+点击手动进入编辑态）。
 *
 * 所以这里给字面量一个**自己的行内节点** `linkSource`：
 *   - 内容就是字面量原文（`content: "text*"`），光标可以直接进去改字；
 *   - markdown 序列化器**原样输出、不转义**（见下方 addStorage）；
 *   - 于是「渲染态」与「编辑态」序列化出的 Markdown 依然逐字节相同 ——
 *     展开/收起不动文件、也不会把 `[` `]` 变成 `\[` `\]`。
 *
 * ## 规则（与 ruby.ts 严格同构）
 *
 *   - **展开**：光标为折叠态且正好贴在链接**两端**（左端 `from` / 右端 `to`）时，
 *     把带 link mark 的文本换成 `linkSource`；光标按原来所在的一侧落进字面量内部。
 *     光标停在链接**文字中间**不展开 —— 那是「改链接文字」的正常编辑状态。
 *   - **收起**：光标越出字面量的**闭区间** `[from, to]`（两端仍算在内）时，
 *     用 `[文字](地址)` 解析回去；**解析失败就保持 linkSource**（原样输出，
 *     绝不退化成纯文本，因此永远不会出现被转义的方括号）。
 *   - 刻意**不是 atom**：光标必须能进入节点内部编辑（与注音节点同理）。
 *   - 展开/收起都打上 LINK_TOGGLE_META：它们是程序化改写、序列化结果不变，
 *     不该被当成用户编辑（否则 App 会清掉搜索高亮 / 误标已修改）。
 */
import { Node } from "@tiptap/core";
import { Plugin, TextSelection } from "prosemirror-state";
import { findLinkRangeAt } from "../link-source";
import { splitLiteral } from "./link-literal"; // 规则层（纯函数）✓

/** 标记「链接字面量展开 / 收起」这类**程序化**改写事务（语义同 ruby.ts 的 RUBY_TOGGLE_META） */
export const LINK_TOGGLE_META = "tydoraLinkToggle";

/**
 * `[文字](地址)`。
 * 文字至少 1 个字符、地址非空且不含空白/右括号 —— 不满足就**不解析**，
 * 保持字面量原样（宁可保持编辑态，也不要把用户半成品变成别的东西）。
 */
const LINK_SOURCE_RE = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/**
 * 解析 `[文字](地址)` 字面量；不是合法字面量则返回 null。
 *
 * 除了本模块自己用，也导出给编辑器：链接展开成字面量后，Ctrl/Cmd+点击要从
 * 字面量文本里还原出地址来打开（那时 DOM 已经是 `<span data-link-source>`，
 * 不再是 `<a>`，拿不到 href）。
 */
export function parseLinkSourceText(text: string): { text: string; href: string } | null {
  const m = LINK_SOURCE_RE.exec(text);
  if (!m) return null;
  return { text: m[1], href: m[2] };
}

/** 本会话是否展开过字面量（用完不清：保证收起在标志被误清时依然有效，理由同 ruby.ts） */
let sawLiteralExpand = false;
/** 当前文档里是否还有字面量（便宜的快路径；不确定时以全量扫描为准） */
let hasLiteral = false;

/**
 * 组字状态自跟踪（与 ruby.ts 同一套理由）：
 * 有的输入法提交后不发 compositionend，只信 view.composing 会卡死；
 * 这里自己记一份，且任何非组字 keydown / 鼠标 / 失焦都视为已提交。
 */
let composingHere = false;

interface AdjacentLink {
  from: number;
  to: number;
  href: string;
  /** 光标贴在链接的哪一侧：`left` = 贴右端（链接在光标左侧），`right` = 贴左端 */
  side: "left" | "right";
}

/** 文本节点是否带有与 href 相同的 link mark */
function hasLinkMark(node: any, href: string): boolean {
  if (!node || !node.isText) return false;
  return (node.marks ?? []).some(
    (m: any) => m.type.name === "link" && String(m.attrs?.href ?? "") === href,
  );
}

/**
 * 把单个文本节点的区间扩成**整段链接**的区间。
 *
 * 一个链接的文字可能被拆成多个文本节点（链接里嵌了粗体/斜体等，或与相邻 mark 交错），
 * 只替换其中一个节点会把链接劈成两半，所以向两侧把同 href 的连续文本一并纳入。
 */
function extendRun(doc: any, from: number, to: number, href: string): { from: number; to: number } {
  let start = from;
  let end = to;
  for (;;) {
    const $p = doc.resolve(start);
    if (!hasLinkMark($p.nodeBefore, href)) break;
    start -= $p.nodeBefore.nodeSize;
  }
  for (;;) {
    const $p = doc.resolve(end);
    if (!hasLinkMark($p.nodeAfter, href)) break;
    end += $p.nodeAfter.nodeSize;
  }
  return { from: start, to: end };
}

/** 区间内是否只有 link mark（没有粗体/斜体等其它格式） */
function onlyLinkMarks(doc: any, from: number, to: number): boolean {
  let ok = true;
  doc.nodesBetween(from, to, (node: any) => {
    if (node.isText && (node.marks ?? []).some((m: any) => m.type.name !== "link")) {
      ok = false;
      return false;
    }
    return true;
  });
  return ok;
}

/**
 * 正文里会被 prosemirror-markdown 的 `esc()` 转义的字符。
 *
 * 链接文字里若含这些字符，**渲染态**写出来本就是带转义的
 *（例如文字 `a [b] *c*` → `[a \[b\] \*c\*](url)`，那才是能被重新解析的正确写法）。
 * 展开成字面量必然要么改变 Markdown、要么让 `\[` 出现在编辑器里，
 * 所以这类链接**不展开** —— 改地址走 Ctrl+K 对话框。
 */
const MD_ESCAPE_IN_TEXT = /[`*_\[\]~\\]/;

/** 链接正好位于块首时，行首字符还有额外转义规则（`#` `>` `-` `+` `=` `!` `|` 与 `1.` / `1)`） */
const MD_ESCAPE_AT_BLOCK_START = /^(?:[#>\-=+!|]|\d+[.)])/;

/**
 * 是否值得展开：文字既不含需要转义的字符，块首也没有额外转义规则。
 */
function isLiteralSafe(doc: any, from: number, to: number): boolean {
  const text = doc.textBetween(from, to);
  if (!text) return false;
  if (MD_ESCAPE_IN_TEXT.test(text)) return false;
  const atBlockStart = doc.resolve(from).parentOffset === 0;
  if (atBlockStart && MD_ESCAPE_AT_BLOCK_START.test(text)) return false;
  return true;
}

/**
 * 光标是否紧贴某个链接（折叠态、同一文本块内）。
 *
 * 链接是 **mark**（不是节点），所以「贴边」= 光标正好落在链接文字的首/尾：
 *   - 左端：从 `pos` 开始就是链接文字（`findLinkRangeAt(doc, pos)` 命中且 from === pos）；
 *   - 右端：`pos - 1` 是链接文字的最后一个字符（命中且 to === pos）。
 *
 * 带别的格式（粗体等）、或文字里含需要转义字符的链接**不展开** —— 展开会把那些 mark 抹平
 * 成纯文本字面量、或让 Markdown 变形（正是"方括号被转义"那类问题的来源），
 * 等于静默改内容。这类链接改地址仍走 Ctrl+K 对话框。
 */
function adjacentLink(state: any): AdjacentLink | null {
  const { selection } = state;
  if (!selection.empty) return null;
  const pos = selection.from;
  const doc = state.doc;

  const right = findLinkRangeAt(doc, pos, 1);
  if (right && right.from === pos) {
    const run = extendRun(doc, right.from, right.to, right.href);
    if (onlyLinkMarks(doc, run.from, run.to) && isLiteralSafe(doc, run.from, run.to)) {
      return { ...run, href: right.href, side: "right" };
    }
  }
  const left = pos > 0 ? findLinkRangeAt(doc, pos - 1, 1) : null;
  if (left && left.to === pos) {
    const run = extendRun(doc, left.from, left.to, left.href);
    if (onlyLinkMarks(doc, run.from, run.to) && isLiteralSafe(doc, run.from, run.to)) {
      return { ...run, href: left.href, side: "left" };
    }
  }
  return null;
}

/**
 * 展开：链接文本 → `linkSource`（内容为 `[文字](地址)`）。
 *
 * `caretInText` 给出时，光标落在字面量里**对应的第几个字符**处（单击展开用：
 * 点在哪就落在哪）；不给则按 `run.side` 落在字面量的首/尾（光标贴边触发的那种）。
 */
function expandLinkAt(view: any, run: { from: number; to: number; href: string; side: "left" | "right" }, caretInText?: number): boolean {
  const { state } = view;
  const linkSource = state.schema.nodes.linkSource;
  if (!linkSource) return false;
  const text = state.doc.textBetween(run.from, run.to);
  if (!text) return false;

  const literal = `[${text}](${run.href})`;
  const tr = state.tr.replaceWith(
    run.from,
    run.to,
    linkSource.create(null, state.schema.text(literal)),
  );
  // 节点内容从 from + 1 开始，到 from + 1 + literal.length 结束
  const caret =
    caretInText === undefined
      ? run.side === "right"
        ? run.from + 1
        : run.from + 1 + literal.length
      : run.from + 1 + Math.max(0, Math.min(text.length, caretInText));
  tr.setSelection(TextSelection.create(tr.doc, caret));
  tr.setMeta(LINK_TOGGLE_META, true);

  hasLiteral = true;
  sawLiteralExpand = true;
  view.dispatch(tr);
  return true;
}

/**
 * 收起：字面量解析回「文本 + link mark」。
 *
 * 给出 `range` 时只扫该区间（打字时扫光标所在块，便宜）；不给则全文档扫描。
 * 光标仍在某个字面量的**闭区间**内（含两端）时那个字面量保持展开。
 */
function collapseLiterals(view: any, range?: { from: number; to: number }, force?: boolean): void {
  const { state } = view;
  const linkSource = state.schema.nodes.linkSource;
  if (!linkSource) return;

  const sel = state.selection;
  const size = state.doc.content.size;
  const scanFrom = range ? Math.max(0, range.from - 1) : 0;
  const scanTo = range ? Math.min(size, range.to + 1) : size;

  const hits: Array<{ from: number; to: number; text: string }> = [];
  state.doc.nodesBetween(scanFrom, scanTo, (node: any, pos: number) => {
    if (node.type !== linkSource) return true;
    const inside = sel.from >= pos && sel.to <= pos + node.nodeSize;
    if (force || !inside) hits.push({ from: pos, to: pos + node.nodeSize, text: node.textContent });
    return false;
  });

  if (!hits.length) {
    if (!range) hasLiteral = false;
    return;
  }

  const linkMark = state.schema.marks.link;
  const tr = state.tr;
  let kept = 0;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i];
    /**
     * R1：字面量**必须**能解析出链接 ✓；解析出的链接前后若还有文字 ✓，
     * 就把它拆成「普通文本 + link mark + 普通文本」✓（不丢字 ✓、不留非法字面量 ✗）。
     */
    const parts = splitLiteral(h.text);
    if (!parts) {
      // 真的解析不出链接 → 整块降级成纯文本 ✓（旧实现是"原样保留非法字面量"✗，
      // 会让非法状态永久存在 ✓；降级后至少能继续编辑 ✓，序列化也不会坏 ✓）
      tr.replaceWith(h.from, h.to, state.schema.text(h.text));
      continue;
    }
    const pieces: any[] = [];
    if (parts.before) pieces.push(state.schema.text(parts.before));
    pieces.push(
      linkMark ? state.schema.text(parts.label, [linkMark.create({ href: parts.href })]) : state.schema.text(`[${parts.label}](${parts.href})`),
    );
    if (parts.after) pieces.push(state.schema.text(parts.after));
    const replacement = pieces.length === 1 ? pieces[0] : pieces;
    tr.replaceWith(h.from, h.to, replacement);
  }

  if (tr.docChanged) {
    tr.setMeta(LINK_TOGGLE_META, true);
    view.dispatch(tr);
  }
  if (!range) hasLiteral = kept > 0;
}

export const LinkSource = Node.create({
  name: "linkSource",
  group: "inline",
  inline: true,
  content: "text*",
  /** 内容里不允许别的 mark：字面量就是原文，格式交给解析回链接之后处理 */
  marks: "",
  /**
   * 刻意**不是** atom（与注音节点同理）：光标要能进到字面量内部直接编辑。
   */
  parseHTML() {
    return [{ tag: "span[data-link-source]" }];
  },
  renderHTML() {
    return ["span", { "data-link-source": "" }, 0];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleDOMEvents: {
            compositionstart: () => {
              composingHere = true;
              return false;
            },
            compositionend: () => {
              composingHere = false;
              return false;
            },
            keydown: (view, event) => {
              const ke = event as KeyboardEvent;
              if (ke.isComposing === false) composingHere = false;
              /**
               * R3：**F2** 显式展开光标旁边的链接 ✓（替代原来的"光标贴近自动展开"✗）。
               * 这样展开是用户意图 ✓，不会再和"收起"打架 ✓。
               */
              if (ke.key === "F2" && !ke.shiftKey && !ke.ctrlKey && !ke.metaKey && !ke.altKey) {
                const run = adjacentLink(view.state);
                if (run && expandLinkAt(view, run)) {
                  ke.preventDefault();
                  return true;
                }
              }
              return false;
            },
            blur: () => {
              composingHere = false;
              return false;
            },
            /**
             * 左键单击链接 → 展开成字面量（与注音一致：点一下就能改源码，
             * 不必先把光标挪到链接边缘）。
             *
             * 光标按**点击位置**落进字面量：`[文字](地址)` 的文字从第 1 个字符开始，
             * 所以"点了文字里第 n 个字符"→ 字面量里第 1 + n 个位置。
             *
             * 门槛与自动展开完全一样（只带 link mark、文字里没有需转义的字符），
             * 不满足就不抢这一下点击，交给 ProseMirror 正常放光标。
             * Ctrl / Cmd / Alt + 点击一律放行：那是"打开链接"与别的快捷键。
             */
            mousedown: (view, event) => {
              const me = event as MouseEvent;
              composingHere = false;
              if (me.button !== 0 || me.ctrlKey || me.metaKey || me.altKey) return false;
              /**
               * 点击**已展开**的字面量 → 收起成链接 ✓（用户要求：再点一次收起来 ✓）。
               *
               * 展开态渲染成 `<span data-link-source>` ✓（不是 `<a>` ✗），所以要在
               * 上面那条"点链接展开"的逻辑**之前**处理 ✓。
               */
              const literalEl = (me.target as HTMLElement | null)?.closest?.("[data-link-source]") as HTMLElement | null;
              if (literalEl) {
                let litPos = -1;
                try {
                  litPos = view.posAtDOM(literalEl, 0);
                } catch {
                  litPos = -1;
                }
                if (litPos >= 0) {
                  /**
                   * ⚠️ `posAtDOM` 返回的是字面量**内部**的位置 ✓，`doc.nodeAt()` 会拿到里面的
                   * 文本节点 ✗（不是 `linkSource` ✗）→ 早期判断永远不成立 ✓ → 点了没反应 ✗（实测 ✓）。
                   * 正确做法：解析出 `$pos` 后**逐层向上**找 `linkSource` 祖先 ✓。
                   */
                  const $pos = view.state.doc.resolve(litPos);
                  let litDepth = -1;
                  for (let d = $pos.depth; d > 0; d--) {
                    if ($pos.node(d).type.name === "linkSource") {
                      litDepth = d;
                      break;
                    }
                  }
                  if (litDepth > 0) {
                    const from = $pos.before(litDepth);
                    const to = $pos.after(litDepth);
                    // 光标先落到字面量之后 ✓，再强制收起 ✓（收起后位置由 ProseMirror 映射 ✓）
                    const tr = view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(to)));
                    view.dispatch(tr);
                    collapseLiterals(view, { from, to }, true);
                    me.preventDefault();
                    return true;
                  }
                }
              }

              const anchor = (me.target as HTMLElement | null)?.closest?.("a") as HTMLAnchorElement | null;
              if (!anchor || anchor.classList.contains("wiki-link")) return false;
              const href = anchor.getAttribute("href");
              if (!href || href === "#") return false;

              let pos: number;
              try {
                pos = view.posAtDOM(anchor, 0);
              } catch {
                return false;
              }
              const seeded = findLinkRangeAt(
                view.state.doc,
                pos,
                (anchor.textContent ?? "").length || 1,
              );
              if (!seeded) return false;
              const run = extendRun(view.state.doc, seeded.from, seeded.to, seeded.href);
              if (
                !onlyLinkMarks(view.state.doc, run.from, run.to) ||
                !isLiteralSafe(view.state.doc, run.from, run.to)
              ) {
                return false;
              }
              // 点击位置 → 字面量里的字符偏移。posAtCoords 依赖布局，视图未就绪等情况下
              // 可能抛（jsdom 里就没有 elementFromPoint）—— 拿不到就退回 0（落在字面量开头）。
              let offset = 0;
              try {
                const at = view.posAtCoords({ left: me.clientX, top: me.clientY });
                if (at) offset = at.pos - run.from;
              } catch {
                offset = 0;
              }
              if (!expandLinkAt(view, { ...run, href: seeded.href, side: "right" }, offset)) {
                return false;
              }
              me.preventDefault();
              return true;
            },
          },
        },
        /**
         * 自动展开 / 收起（结构照抄 ruby.ts 的 view.update）：
         * 邻近判断放在所有早退之前，所以每次更新都判断 —— 这就是「光标到边上就展开」。
         */
        view: () => ({
          update: (view: any, prevState: any) => {
            if (composingHere) return;

            const docChanged = !view.state.doc.eq(prevState.doc);
            const selChanged = !view.state.selection.eq(prevState.selection);
            // 清掉"刚收起"的一次性标记 ✓（R3 之后不再需要它来抑制自动展开 ✓，仅保持状态干净 ✓）

            /**
             * R3：**不再"光标贴近就自动展开"** ✗。
             *
             * 旧实现只要光标停在链接边缘就展开 ✓，而收起之后光标往往**仍在边缘** ✓
             * → 收起的下一条事务立刻又把它展开 ✗ → 表现成"收不起来"✓（实测 ✓）。
             * 现在只允许**显式**展开：单击链接 ✓ / F2 ✓（见 keydown ✓）。
             */

            if (!docChanged && !selChanged && !hasLiteral) return;

            // ② 文档变化：只扫光标所在块
            if (docChanged) {
              const $from = view.state.selection.$from;
              collapseLiterals(view, { from: $from.start(), to: $from.end() });
            }

            // ③ 全文档扫描（收起）
            if (hasLiteral || sawLiteralExpand) collapseLiterals(view);
          },
        }),
      }),
    ];
  },
}).extend({
  addStorage() {
    return {
      markdown: {
        /**
         * **原样输出**，不转义。
         *
         * 这是整个方案的关键：纯文本字面量会被 prosemirror-markdown 的 esc() 写成
         * `\[文字\](地址)`，而这里走 state.write —— 序列化结果与渲染态完全一致，
         * 于是展开/收起不改文件、也不会出现被转义的方括号。
         */
        serialize(state: any, node: any) {
          state.write(node.textContent);
        },
      },
    };
  },
});
