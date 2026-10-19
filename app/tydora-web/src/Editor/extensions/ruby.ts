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
import { Fragment } from "@tiptap/pm/model";
/**
 * 估算一段文字的显示宽度（单位：em，按**本体字号**）。
 *
 * 为什么需要估算：注音的读音是 `::after` 绝对定位画上去的，**不参与布局** —— 读音比本体长时
 * 会向两侧溢出，压到相邻注音。CSS 拿不到文字宽度，只能在渲染时按字符类别估一个值，
 * 交给样式去"向两侧让出 (读音宽 − 本体宽) / 2"。
 *
 * 字符宽度约定：全角（CJK / 假名 / 全角标点）≈ 1em；半角（拉丁字母、数字、半角标点、
 * 空格）≈ 0.5em。`scale` 用于小字号：读音是 0.5em 字号，所以传 0.5 ✓。
 *
 * ⚠️ 早期版本把"每个字符都按 1em 算本体、0.5em 算读音"，只对 CJK 成立；英文读音的实际宽度
 * 只有假设值的一半 → 留白被高估一倍，本体左右多出大片空白（用户实测反馈 ✗）。
 */
const WIDE_CHAR_RE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/;

/**
 * 估算宽度（仅作**实测前**的兜底默认值）。
 *
 * 真正的宽度由 Editor/ruby-measure.ts 在渲染后用 Range / canvas **实测**覆盖 —— 非等宽字体下
 * 按字符估算必然不准（i 与 W 差几倍），这里只保证"实测还没跑的那一帧"不会完全没有留白 ✓。
 */
function rubyWidthEm(text: string, scale: number): string {
  let width = 0;
  for (const ch of text) width += WIDE_CHAR_RE.test(ch) ? 1 : 0.5;
  return (width * scale).toFixed(2);
}
import { Plugin, TextSelection } from "prosemirror-state";
import {
  installMarkdownRuleOnce,
  installWordMarkCleanup,
  WORD_MARK_END,
  WORD_MARK_START,
} from "./markdown-setup";

/** 转义 HTML 文本/属性里的特殊字符 */
function esc(s: string): string {  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 标记「注音展开 / 收起」这类**程序化**改写事务。
 *
 * 为什么需要：展开/收起会改文档（节点 ↔ 字面量文本），于是触发 TipTap 的 update，
 * 编辑器再回调 App 的 onChange —— 而 App 在「用户编辑」时会清掉搜索高亮。
 * 表现就是：**搜索跳行 → 命中处的注音自动展开 → 刚跳过去的高亮被清掉**
 *（实测日志：点击后 500ms，`storage.searchHighlight.query` 变成了空字符串）。
 *
 * 而这两次改写序列化出的 Markdown 与改写前**完全一样**（都是 `{{Ruby|…}}`），
 * 本来就不该算用户编辑 —— 打上这个标记，onUpdate 跳过 onChange（字数统计照常走）。
 */
export const RUBY_TOGGLE_META = "tydoraRubyToggle";

/** 光标是否紧邻注音（**同一文本块内**，即视觉上的"左右两侧"）→ 是则返回展开位置 */
function adjacentRuby(view: any): number | null {
  const { selection } = view.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  /**
   * ⚠️ 方案 A 之后注音**有文本内容** —— 光标常常直接落在它**内部**
   *（$from.parent 就是 ruby 节点 ✓，此时既没有 nodeBefore 也没有 nodeAfter ✗）。
   * 不单独处理这一种，点击/把光标移进注音就再也不会展开（实测回归 ✓）。
   */
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === "ruby") return $from.before(d);
  }
  const before = $from.nodeBefore;
  if (before && before.type.name === "ruby") return selection.from - before.nodeSize;
  const after = $from.nodeAfter;
  if (after && after.type.name === "ruby") return selection.from;
  return null;
}

/** 展开：注音节点 → 源码字面量 `{{Ruby|本体|读音}}`，光标保持原本所在的那一侧 */
function expandRubyAt(view: any, pos: number): boolean {
  /**
   * ⚠️ pos 通常来自 `view.posAtDOM(el, 0)`，而注音是 `contenteditable="false"` 的行内
   * **原子叶子**：这个调用可能返回"节点**之后**"的位置（off-by-one ✓ 实测会让单击
   * 完全没反应 ✗，因为 nodeAt(pos) 拿到的是后面的文本 ✗）。
   * 所以在 pos / pos-1 / pos+1 三个候选里找真正的 ruby ✓，找到后统一用 `at`。
   */
  let at = pos;
  let node = view.state.doc.nodeAt(at);
  if (!node || node.type.name !== "ruby") {
    for (const cand of [pos - 1, pos + 1]) {
      if (cand < 0) continue;
      const n = view.state.doc.nodeAt(cand);
      if (n && n.type.name === "ruby") {
        at = cand;
        node = n;
        break;
      }
    }
  }

  if (!node || node.type.name !== "ruby") return false;
  const base = (node.textContent ?? "").trim();
  const rt = (node.attrs.rt ?? "").trim();
  if (!base || !rt) return false;
  const literal = `{{Ruby|${base}|${rt}}}`;
  /**
   * ⚠️ 不能只用 `selection.from <= at` 判断"在左边还是右边"。
   *
   * 注音现在**有文本内容**（方案 A），所以点在**左边界**时光标会落在它**内部**
   *（`from === at + 1` ✗，比 `at` 大一）—— 用旧判断就成了"在右边" ✗ →
   * 展开后光标跑到**右边界**（用户实测 ✓）。
   * 改成：落在起点、或落在注音**前半** → 展开后放**前面** ✓；后半 → 放后面 ✓
   *（与"按点击落在左半/右半决定"的原始设计一致 ✓）。
   */
  const nodeEnd = at + node.nodeSize;
  const selFrom = view.state.selection.from;
  const wasBefore = selFrom <= at || (selFrom < nodeEnd && selFrom - at <= node.nodeSize / 2);
  /**
   * ⚠️ 只把**合法 Mark 实例**带过去。
   *
   * 实测报错：`mark.type.spec.toDOM is not a function` ✗ —— 说明 `node.marks` 里混进了
   * 不是真正 Mark 的东西（例如从输入规则/粘贴路径带回来的裸 `{type, attrs}` 对象）。
   * 这里过滤掉非法项（并记日志），既保住高亮/颜色，也不会因为一条脏数据整条路径崩掉 ✓。
   */
  const rawMarks: any[] = (node.marks ?? []) as any[];
  const safeMarks = rawMarks.filter(
    (m: any) => m && typeof m === "object" && typeof m.type?.create === "function" && typeof m.type?.spec?.toDOM === "function",
  );
  if (safeMarks.length !== rawMarks.length) {
  }
  const tr = view.state.tr.replaceWith(at, at + node.nodeSize, view.state.schema.text(literal, safeMarks));
  tr.setSelection(TextSelection.create(tr.doc, wasBefore ? at : at + literal.length));
  tr.setMeta(RUBY_TOGGLE_META, true);
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
  // marks 必须一并带走：字面量上的高亮/颜色等 mark 收起后要落到 ruby 节点上，否则丢失
  const hits: { from: number; to: number; base: string; rt: string; marks: any[] }[] = [];
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
        hits.push({ from, to, base: m[1].trim(), rt: m[2].trim(), marks: node.marks ?? [] });
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
    // 第三个参数：把字面量上的 marks 带到 ruby 节点上（高亮/文字颜色等，切换模式后不再丢）
    /**
     * 本体是子文本 ✓；marks 作为**节点**的 marks（高亮/颜色等，切换模式后不再丢）✓。
     *
     * ⚠️ `NodeType.create(attrs, content, marks)` 只有**三个**参数 ✓ ——
     * 多写一个参数不会报错，但会把 content 当成 null、把真正的 content 当成 marks ✗：
     * 结果是"空注音 + marks 里混进一个 TextNode" ✓，渲染时报
     * `mark.type.spec.toDOM is not a function` ✗（实测就是这么来的）。
     */
    tr.replaceWith(h.from, h.to, rubyType.create({ rt: h.rt }, [state.schema.text(h.base)], h.marks));
  }
  if (tr.docChanged) {
    suppressAutoExpandOnce = true; // 收起是我们自己造成的，那一次不参与判断
    tr.setMeta(RUBY_TOGGLE_META, true);
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
/**
 * 鼠标是否按下（左键）。
 *
 * 用途：**按住鼠标拖选时**不触发「光标邻近注音就展开」的自动逻辑 —— 否则从注音边界
 * 按下开始拖选的瞬间，ruby 就被展开成字面量 ✗，拖选变成在选字面量（用户实测反馈）。
 */
let mouseDown = false;



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
   * **本体文字是真正的子文本**（方案 A）。
   *
   * 以前本体放在 `attrs.base` 里、节点是**叶子**：ProseMirror 无法寻址"注音内部"的位置，
   * 浏览器把选区端点放进去时会被丢弃 → PM 认为选区折叠 ✗ → 浏览器下一次 mousemove 又扩张
   * → 每帧拉锯 = **选中区不停闪** ✗；松手时还容易被当成单击而**吞掉选区** ✗（均有日志实证）。
   * 改成带文本内容后，PM 能正常寻址内部位置 → 拖选（含右→左）稳定 ✓。
   * 读音仍在 `attrs.rt` 里，由 CSS 的 ::after 画在上方（见 theme.css）✓。
   */
  content: "text*",
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
    // 本体已经变成节点的**文本内容**（见 content），不再需要 base 属性 ✓
    return {
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
          const rt = (el.getAttribute("data-rt") ?? "").trim();
          if (!rt) return false;
          // 本体就是元素里的文字 → 交给 ProseMirror 按子内容解析 ✓
          return { rt };
        },

      },
      // 兼容：从别处粘贴的裸 HTML <ruby>…<rt>…</rt></ruby>
      {
        tag: "ruby",
        getAttrs: (element) => {
          const el = element as HTMLElement;
          const rt = (el.querySelector("rt")?.textContent ?? "").trim();
          if (!rt) return false;
          return { rt };
        },
        /**
         * 裸 `<ruby>base<rt>rt</rt></ruby>`：内容**不能**默认解析（会把 rt 也吃进本体 ✗）——
         * 这里显式返回"去掉 rt/rp 之后的文字"作为节点的文本内容 ✓。
         */
        getContent: (node: any, schema: any) => {
          const el = node as HTMLElement;
          const clone = el.cloneNode(true) as HTMLElement;
          clone.querySelectorAll("rt, rp").forEach((n) => n.remove());
          const base = (clone.textContent ?? "").trim();
          return Fragment.from(schema.text(base || " "));
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
         * 读音与本体各自的**估算宽度**（em），供 CSS 决定"向两侧让出多少空间"。
         * 读音是绝对定位画上去的（不占布局），太长就会向两侧溢出压到相邻注音；
         * CSS 测不出文字宽度，只能用估算（见 rubyWidthEm 的说明：按全角/半角分别算，
         * 早期"每个字都按 1em"的写法会让英文读音的留白多出一倍 ✗）。
         */
        style: `--ruby-rt-w:${rubyWidthEm(node.attrs.rt ?? "", 0.5)}em;--ruby-base-w:${rubyWidthEm(node.textContent ?? "", 1)}em`,
        /**
         * ⚠️ 暂不设 contenteditable="false"（实验）。
         *
         * 它是"原子叶子"的标准做法，能防旧的选区不稳定；但**拖选经过注音时** Chromium 会在
         * 两种边界间反复吸附 → 选中区不停闪 ✗（实测：拖动期间我们这边零 dispatch ✓，
         * 所以闪来自浏览器对该原子的选区处理 ✓）。
         * 去掉后注音内部可能被光标进入，但 PM 把它当叶子节点，输入仍会被移出边界 ✓。
         * 若出现别的问题，恢复这一行即可（备份在 %TEMP%）。
         */
      },
      // 0 = 内容孔：本体文字作为节点的子内容渲染 ✓
      0,
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
  // 本体已经是真实文本内容，textBetween / 查找天然可见 ✓ —— 不再需要 leafText 投影

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
            /**
             * 按下：**什么都不做**（不展开、不 preventDefault）——
             * 只置"鼠标按下"标记，供 view.update 里暂停"邻近自动展开" ✓。
             *
             * 不 preventDefault 是必须的：否则浏览器建立不了选区，拖选 / Shift 扩展全废 ✗
             *（注音的「整块选中」已由 CSS 的 user-select: all 保证 ✓）。
             */
            /**
             * 按下只做两件事：清组字标志、标记"鼠标按住中"（供 view.update 暂停邻近自动展开 ✓）。
             * **不展开**、也不 preventDefault（后者会让浏览器建不了选区，拖选/Shift 扩展全废 ✗）。
             */
            mousedown: (_view, event) => {
              const me = event as MouseEvent;
              composingHere = false;
              if (me.button !== 0) return false;
              mouseDown = true;
              return false;
            },            /**
             * 松开鼠标：**按光标实际落点**决定是否展开（不看点了哪个元素 ✓）。
             *
             * 为什么这样判断：点读音（::after）或点空白时，事件目标可能是 <p>，靠 target
             * 永远判断不准 ✗；而浏览器已经把光标放在了"用户想放的位置" ✓ —— 只要光标
             * **贴着某个注音的边界**（或整块选中了某个注音），就把它展开成源码字面量 ✓。
             *
             * 拖选（选区是一段文本）不展开 ✓；用 rAF 等 PM 把选区更新完 ✓。
             */
            mouseup: (view) => {
              mouseDown = false;
              requestAnimationFrame(() => {
                const v = view as any;
                if (v.isDestroyed) return;
                const sel = v.state.selection;
                /**
                 * ⚠️ 只在**折叠光标**（= 单击）时展开。
                 *
                 * 曾经把"选区恰好等于一个注音"也当成单击 ✗ —— 但用户从注音边界开始拖动、
                 * 正好把它整块选中时，那个条件同样成立 ✗ → 拖选结果被替换成字面量，
                 * 松开后**什么都没选中**（实测：最后一个 selectionchange 的 pm 是 82..82 ✗）。
                 * 拖选一律不展开、也不收敛字面量（收起交给常规的 view.update ✓）。
                 */
                /**
                 * ⚠️ 还要看 **DOM 选区**，不能只看 PM 的。
                 *
                 * PM 在"焦点落在注音 span 内部"时会**丢弃**浏览器给出的范围（叶子节点没有可寻址
                 * 的内部位置 ✗），于是 PM 认为选区折叠（实测：PM 280..280 而 DOM collapsed=false ✗）。
                 * 此时若按"折叠 = 单击"去展开，就会把用户刚拖出来的选中**吞掉** ✗。
                 */
                const domSel = window.getSelection();
                const domRange = !!domSel && domSel.rangeCount > 0 && !domSel.isCollapsed;
                if (!sel.empty || domRange) return;
                const target = adjacentRuby(v);
                if (target !== null) {
                  expandRubyAt(v, target);
                  return;
                }
                /**
                 * 光标落点不在任何注音旁 → 说明用户点到了别处 ✓ ——
                 * 此时必须**主动跑一次收起**：点击带来的那次 `view.update` 发生在
                 * `mouseDown === true` 期间，被「拖选期间暂停判定」的守卫整体跳过了 ✗，
                 * 于是"点别处离开注音"不会收起（实测：字面量留在原地 ✗）。
                 */
                convertLiterals(v);
              });
              return false;
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
            /**
             * 按住鼠标（拖选中）不做邻近自动展开：从注音边界按下开始拖选时，
             * 光标最初恰好落在注音旁边，会自动展开成字面量 ✗ → 拖选就变成选字面量了。
             */
            if (mouseDown) return;

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
        handler: ({ range, match, commands, state }) => {
          const base = match[1]?.trim();
          const rt = match[2]?.trim();
          if (!base || !rt) return;
          /**
           * 关键：把**被替换字面量上的 marks 一并交给 ruby 节点**。
           *
           * 否则「给已高亮的文字创建注音」会丢掉高亮 —— 高亮是 mark，ruby 是节点，
           * 新建节点时不带 marks 就等于把高亮删了。带上之后序列化结果正是
           * `{{Hilite|yellow|{{Ruby|漢字|かんじ}}}}`（Hilite 在外、Ruby 在内）。
           */
          const pos = Math.min(range.from + 1, state.doc.content.size);
          const marks = state.doc.resolve(pos).marks().map((m: any) => ({ type: m.type.name, attrs: m.attrs }));
          commands.insertContentAt(range, {
            type: "ruby",
            attrs: { rt },
            content: [{ type: "text", text: base }],
            ...(marks.length ? { marks } : {}),
          });
        },
      }),
    ];
  },
}).extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          const base = node.textContent ?? "";
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
            // 解析期词边界标记的清理（见 markdown-setup.ts）。与图片扩展共用同一条规则。
            installWordMarkCleanup(markdownit);
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
                    // 两端的 U+E000 / U+E001 是"词边界"标记，见 markdown-setup.ts。
                    // 与 renderHTML 保持同一套宽度变量，避免展开/收起时左右留白跳动 ✓
    const widthStyle =
      `--ruby-rt-w:${rubyWidthEm(rt, 0.5)}em;--ruby-base-w:${rubyWidthEm(base, 1)}em`;
    return `${WORD_MARK_START}<span class="md-ruby" data-rt="${esc(rt)}" style="${widthStyle}">${esc(base)}</span>${WORD_MARK_END}`;
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
