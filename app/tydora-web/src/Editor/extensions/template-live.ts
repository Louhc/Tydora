import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state";
import { DOMParser as PMDOMParser, Fragment } from "@tiptap/pm/model";
import { Mapping } from "@tiptap/pm/transform";
import {
  matchTemplateAt,
  renderRegisteredTemplate,
  rewriteTemplates,
  templateErrorEndAt,
  templateErrorHtml,
} from "../markdown-templates";
import { RUBY_TOGGLE_META, suppressRubyAutoExpandOnce } from "./ruby";

/** 不做即时转换的块 / 父节点：源码类块与注音本体、错误块源码 */
const SKIP_BLOCK_TYPES = new Set(["codeBlock", "code_block", "frontmatter", "templateError"]);
const SKIP_TEXT_PARENTS = new Set(["ruby", "templateError"]);

interface Replacement {
  from: number;
  to: number;
  frag: Fragment;
}

/**
 * 模板「输入 / 粘贴即时渲染」。
 *
 * 为什么需要它（用户实测）：只有 input rule 不够 ——
 *   ① input rule 只走 `handleTextInput`，**中文输入法合成插入不触发**，
 *      于是 `{{Wavy|…|文字}}` 打完最后一个 `}` 也不转换；
 *   ② Font / Color / Hilite 的模板写法根本没有 input rule；
 *   ③ 普通 Ctrl+V 的纯文本剪贴板走 `insertText` / `insertContent`（绕开 PM 粘贴解析），
 *      字面量原样进文档，要等刷新重解析才渲染。
 * 这里在 `appendTransaction` 里扫描**本次改动涉及的文本块**，把已配平且可渲染的
 * `{{…}}` 字面量就地换成 mark / 注音节点 —— 与 Markdown 解析共用注册渲染器，
 * 转换结果与刷新后完全一致。
 *
 * 安全性：
 * - 只扫改动块，且跳过代码块 / 行内 code / frontmatter / 错误块 / 注音本体；
 * - 纯文本粘贴（Ctrl+Shift+V / 右键「粘贴为纯文本」）**同样转换模板**：
 *   「纯」只指不解析 Markdown 格式 / 不带 HTML 结构；模板是 Tydora 自己的行内语法，
 *   与逐字输入等价，故亦即时渲染（用户实测要求）；
 * - 嵌套（Font 里套 Ruby 等）在**片段层递归**转换，一次交易内完成，不依赖回扫轮次；
 * - 新建注音贴着光标会触发"邻接自动展开"，用 suppressRubyAutoExpandOnce 吃掉。
 */
export const TemplateLive = Extension.create({
  name: "templateLive",

  addProseMirrorPlugins() {
    const schema = this.editor.schema;

    const mergeMarks = (outer: readonly any[], inner: readonly any[]): readonly any[] =>
      outer.reduce((set: readonly any[], mk: any) => mk.addToSet(set), inner);

    /** 渲染器产出的行内 HTML → PM 片段（保留 HTML 自带的 mark，不做递归） */
    const parseHtmlFragment = (html: string): Fragment | null => {
      try {
        const wrapper = document.createElement("p");
        wrapper.innerHTML = html;
        const doc = PMDOMParser.fromSchema(schema).parse(wrapper, { preserveWhitespace: "full" });
        return doc.firstChild ? doc.firstChild.content : null;
      } catch {
        return null;
      }
    };

    const rubyFragment = (inner: string, outerMarks: readonly any[]): Fragment | null => {
      const m = /^([^|{}:\n]+?)\s*[|:]\s*([^|{}:\n]+?)$/.exec(inner.trim());
      if (!m) return null;
      const base = m[1].trim();
      const rt = m[2].trim();
      if (!base || !rt) return null;
      try {
        return Fragment.from(schema.nodes.ruby.create({ rt }, [schema.text(base)], outerMarks as any));
      } catch {
        return null;
      }
    };

    /** 递归：片段里的文本子节点继续做字面量转换（嵌套模板一次交易内收敛） */
    const convertFragment = (frag: Fragment, outerMarks: readonly any[]): Fragment => {
      const nodes: any[] = [];
      frag.forEach((child: any) => {
        const merged = mergeMarks(outerMarks, child.marks);
        if (child.isText) {
          const conv = convertText(child.text, merged);
          if (conv) for (const n of conv.frag.content as any[]) nodes.push(n);
          else nodes.push(child.mark(merged));
        } else {
          nodes.push(child.mark(merged));
        }
      });
      return Fragment.fromArray(nodes);
    };

    /**
     * 扫描一段纯文本，把其中可渲染的模板字面量换成 mark / 注音节点。
     * 没有任何转换时返回 null（调用方保留原文本节点）。
     */
    /** $$ 收拢时略去本体外层的 \[ \] 包裹（用户要求）；无包裹者原样保留（含首尾空行，逐字节一致） */
    const cleanMathLatex = (latex: string): string => {
      const t = latex.trim();
      if (t.startsWith("\\[") && t.endsWith("\\]") && t.length > 4) return t.slice(2, -2).trim();
      // 裸 [ ] 包裹仅认跨行形（存盘再读反斜杠被转义吃掉）；同行 $$[x]$$ 之括號或为本体，不动
      if (t.includes("\n") && t.startsWith("[") && t.endsWith("]") && t.length > 2) return t.slice(1, -1).trim();
      return latex;
    };

    /** 行内 $...$ 字面量（$$ 归块级，不在此处理）；分隔符校验与 markdown-it 同口径 */
    const matchInlineMathAt = (s: string, i: number): { end: number; latex: string } | null => {
      if (s[i] !== "$" || s[i + 1] === "$") return null;
      if (i > 0 && (s[i - 1] === "\\" || s[i - 1] === "$")) return null;
      const next = s.charCodeAt(i + 1);
      if (next === 32 || next === 9) return null; // 开头后随空格 → 非数学
      const m = /^\$([^$\n]+?)\$/.exec(s.slice(i));
      if (!m) return null;
      const end = i + m[0].length;
      if (s[end] === "$") return null; // 紧跟 $ → 属 $$ 块级
      const prev = s.charCodeAt(end - 2);
      if (prev === 32 || prev === 9) return null; // 闭合前是空格 → 非数学
      // 闭合 $ 前是奇数个反斜杠 = 转义过的 $ → 非数学
      let p = end - 2;
      while (p >= 0 && s[p] === "\\") p -= 1;
      if ((end - 2 - p) % 2 === 1) return null;
      return { end, latex: m[1] };
    };

    const convertText = (
      s: string,
      outerMarks: readonly any[],
      /** 顶层扫描才给：判断某 Ruby 字面量是否处于「展开编辑中」，是则跳过不收 */
      rubyEditing?: (start: number, end: number) => boolean,
    ): { frag: Fragment; ruby: boolean } | null => {
      const pieces: any[] = [];
      let plainStart = 0;
      let changed = false;
      let ruby = false;
      let i = 0;
      while (i < s.length) {
        // 行内数学 $...$：任意时刻配平即收起（先打左 $ 或先打右 $ 皆可；
        // 数学编辑走 MathDialog，不依赖源码态，故光标在内部也收）
        const mm = matchInlineMathAt(s, i);
        if (mm) {
          if (i > plainStart) pieces.push(schema.text(s.slice(plainStart, i), outerMarks as any));
          pieces.push(schema.nodes.inlineMath.create({ latex: mm.latex }, null, outerMarks as any));
          changed = true;
          plainStart = mm.end;
          i = mm.end;
          continue;
        }
        const m = matchTemplateAt(s, i);
        if (!m) {
          // 坏模板开头 → 整段跳过（内部嵌套不单独转换，与刷新后判据一致）
          const errEnd = templateErrorEndAt(s, i);
          i = errEnd ?? i + 1;
          continue;
        }
        const raw = s.slice(m.start, m.end);
        let frag: Fragment | null = null;
        if (m.name === "Ruby") {
          // 展开编辑中的字面量（光标闭区间贴着/在里面，且旧文档已有同文）不收，
          // 否则「光标移到边上自动展开」会被本插件立刻收回去（用户实测失效）
          if (rubyEditing && rubyEditing(m.start, m.end)) {
            i = m.end;
            continue;
          }
          frag = rubyFragment(m.inner, outerMarks);
          if (frag) ruby = true;
        }
        if (!frag) {
          const rendered = renderRegisteredTemplate(
            m,
            rewriteTemplates(m.inner, (mm, ii) => renderRegisteredTemplate(mm, ii)),
          );
          if (rendered && rendered !== raw) {
            const parsed = parseHtmlFragment(rendered);
            if (parsed) frag = convertFragment(parsed, outerMarks);
          } else if (m.inner.includes("{{")) {
            // 配平但渲染不了（如注音本体里塞模板）→ 错误块，与刷新后一致
            const parsed = parseHtmlFragment(templateErrorHtml(raw, m.name));
            if (parsed) frag = convertFragment(parsed, outerMarks);
          }
        }
        if (frag && frag.size > 0) {
          if (m.start > plainStart) pieces.push(schema.text(s.slice(plainStart, m.start), outerMarks as any));
          // pieces 必须是**节点**数组：把片段摊平（其子节点已是转换完成的节点）
          for (const child of frag.content as any[]) pieces.push(child);
          changed = true;
          plainStart = m.end;
        }
        i = m.end;
      }
      if (!changed) return null;
      if (plainStart < s.length) pieces.push(schema.text(s.slice(plainStart), outerMarks as any));
      return { frag: Fragment.fromArray(pieces), ruby };
    };

    return [
      new Plugin({
        key: new PluginKey("tydoraTemplateLive"),
        appendTransaction: (trs, oldState, newState) => {
          const docChanged = trs.some((tr) => tr.docChanged);
          // 任意时刻（文档改动或光标移动）只要满足配平条件就收起 → 全文扫描。
          // 普通笔记上是亚毫秒级正则遍历（与 ruby 的全文扫描同量级）。
          const scanAll = docChanged || trs.some((tr) => tr.selectionSet);
          if (!scanAll) return null;
          // 注音自己的展开/收起交易不参与即时转换（展开出的字面量是编辑态，非新输入）
          if (trs.some((tr) => tr.getMeta(RUBY_TOGGLE_META))) return null;

          // 新→旧映射：供 Ruby「展开编辑态」判定回看旧文档
          const invert = new Mapping();
          for (const tr of trs) invert.appendMapping(tr.mapping.invert());

          /** Ruby 字面量是否「展开编辑中」：光标闭区间贴/含它，且旧文档同位置已是同文 */
          const rubyEditingAt = (from: number, to: number): boolean => {
            const sel = newState.selection;
            const touched = sel.empty
              ? sel.head >= from && sel.head <= to
              : sel.from <= to && sel.to >= from;
            if (!touched) return false;
            const of = invert.map(from);
            const ot = invert.map(to);
            if (of < 0 || ot > oldState.doc.content.size || of >= ot) return false;
            // 旧文档同位置是 ruby 节点 = 本次正是「展开」交易；或已是完整 Ruby 字面量
            // = 展开编辑态（含编辑中改字）。二者皆不收。
            // 新输入/粘贴的半成品或全新字面量旧位置既非节点也非完整字面量 → 仍即时转换
            const oldNode = oldState.doc.nodeAt(of);
            if (oldNode && oldNode.type.name === "ruby" && of + oldNode.nodeSize === ot) return true;
            const oldRaw = oldState.doc.textBetween(of, ot);
            const om = matchTemplateAt(oldRaw, 0);
            return !!om && om.name === "Ruby" && om.end === oldRaw.length;
          };

          const blocks = new Map<number, any>();
          newState.doc.descendants((node: any, pos: number) => {
            if (node.isTextblock && !SKIP_BLOCK_TYPES.has(node.type.name)) blocks.set(pos, node);
          });

          // 跨段形态：独占一段的左 $$ … 独占一段的右 $$（中间若干段为公式本体）→ 块级公式。
          // 粘贴/源码切回常见此形态；段间空行以 "\n\n" 进 latex，序列化逐字节还原。
          const onlyTextish = (n: any): boolean => {
            let ok = true;
            n.content.forEach((c: any) => {
              if (!c.isText && c.type.name !== "hardBreak") ok = false;
            });
            return ok;
          };
          const crossBlocks: Array<{ from: number; to: number; latex: string }> = [];
          const ordered = [...blocks.entries()];
          for (let i = 0; i < ordered.length; i++) {
            const [openPos, openNode] = ordered[i];
            if (openNode.type.name !== "paragraph" || (openNode.textContent as string).trim() !== "$$") continue;
            if (!onlyTextish(openNode)) continue;
            let j = i + 1;
            const inner: string[] = [];
            let closePos = -1;
            let closeSize = 0;
            for (; j < ordered.length; j++) {
              const [p, n] = ordered[j];
              if (n.type.name !== "paragraph" || !onlyTextish(n)) break;
              const t = n.textContent as string;
              if (t.trim() === "$$") {
                closePos = p;
                closeSize = n.nodeSize;
                break;
              }
              if (t.includes("$$")) break; // 本体里另有 $$ → 不配对，免误收
              inner.push(t);
            }
            if (closePos < 0 || inner.length === 0) continue;
            // 与 markdown-it mathBlock 跨行解析出的 content 同形（getLines 自带尾换行）：
            // 首补一个 \n（分隔符后空行）、尾补两个 \n（本体后空行 + 行尾），往返逐字节一致
            crossBlocks.push({
              from: openPos,
              to: closePos + closeSize,
              latex: cleanMathLatex("\n" + inner.join("\n\n") + "\n\n"),
            });
            for (let k = i; k <= j; k++) blocks.delete(ordered[k][0]);
            i = j;
          }

          // 块级 $$...$$：哪怕写在同一行/段中，也必须是块级公式（用户要求）。
          // 任意时刻配平即收（先打左 $$ 或先打右 $$ 皆可），整块重建为 [段, blockMath, 段…]。
          const blockSplits: Array<{ blockPos: number; lits: Array<{ from: number; to: number; latex: string }> }> = [];
          for (const [blockPos, block] of blocks) {
            const text = block.textContent as string;
            const lits: Array<{ from: number; to: number; latex: string }> = [];
            const re = /\$\$([^$]+?)\$\$/g;
            let m: RegExpExecArray | null;
            while ((m = re.exec(text)) !== null) {
              const from = blockPos + 1 + m.index;
              const to = from + m[0].length;
              lits.push({ from, to, latex: m[1] });
            }
            if (lits.length > 0) blockSplits.push({ blockPos, lits });
          }

          const replacements: Replacement[] = [];
          let madeRuby = false;
          const splitBlocks = new Set(blockSplits.map((b) => b.blockPos));
          for (const [blockPos, block] of blocks) {
            // 本 pass 先做块级拆分；拆出的前后文本块下一 pass 再做行内转换
            if (splitBlocks.has(blockPos)) continue;
            newState.doc.nodesBetween(
              blockPos,
              blockPos + block.nodeSize,
              (node: any, pos: number, parent: any) => {
                if (!node.isText) return;
                if (parent && SKIP_TEXT_PARENTS.has(parent.type.name)) return;
                if (node.marks.some((mk: any) => mk.type.name === "code")) return;
                const conv = convertText(node.text, node.marks, (start, end) =>
                  rubyEditingAt(pos + start, pos + end),
                );
                if (!conv) return;
                madeRuby = madeRuby || conv.ruby;
                replacements.push({ from: pos, to: pos + node.text.length, frag: conv.frag });
              },
            );
          }
          if (replacements.length === 0 && blockSplits.length === 0 && crossBlocks.length === 0) return null;

          let tr = newState.tr;
          for (const r of replacements.sort((a, b) => b.from - a.from)) {
            tr = tr.replaceWith(r.from, r.to, r.frag);
          }
          // 块级拆分：整块重建为 [段, blockMath, 段, …]（自右向左，位置不漂移）。
          // 不用 split/insert：空段会多序列化出空行，且光标映射不可控；
          // 这里按段累加 nodeSize 手动重定位光标，确定性强。
          for (const bs of blockSplits.sort((a, b) => b.blockPos - a.blockPos)) {
            const block = blocks.get(bs.blockPos);
            if (!block) continue;
            // 前面的行内替换可能已漂移位置 → 经 tr.mapping 映射
            const blockPos = tr.mapping.map(bs.blockPos);
            const lits = bs.lits
              .map((l) => ({ ...l, from: tr.mapping.map(l.from), to: tr.mapping.map(l.to) }))
              .sort((a, b) => a.from - b.from);
            const nodes: any[] = [];
            let newPos: number | null = null;
            const headOffset = newState.selection.empty
              ? newState.selection.head - (bs.blockPos + 1)
              : -1;
            let acc = blockPos;
            // 按子节点遍历重建（而非 textContent 切片）：保留 marks 与行内节点
            // （inlineMath/ruby 等），否则段中已有公式会被切片丢掉
            let seg: any[] = [];
            let segTextLen = 0;
            let textOffset = 0;
            const flushSeg = () => {
              if (seg.length === 0) return;
              const para = block.type.create(block.attrs, Fragment.fromArray(seg));
              nodes.push(para);
              acc += para.nodeSize;
              seg = [];
              segTextLen = 0;
            };
            const pushPiece = (pieceText: string, marks: readonly any[]) => {
              const len = pieceText.length;
              if (headOffset >= textOffset && headOffset <= textOffset + len) {
                newPos = acc + 1 + segTextLen + (headOffset - textOffset);
              }
              const conv = convertText(pieceText, marks);
              if (conv) {
                for (const child of conv.frag.content as any[]) seg.push(child);
              } else if (len > 0) {
                seg.push(schema.text(pieceText, marks as any));
              }
              segTextLen += len;
              textOffset += len;
            };
            block.content.forEach((child: any) => {
              if (!child.isText) {
                seg.push(child);
                return;
              }
              const nodeStart = textOffset;
              let local = 0;
              for (const lit of lits) {
                const ls = lit.from - (blockPos + 1);
                const le = lit.to - (blockPos + 1);
                // 字面量须完整落在本文本节点内才拆（跨 marks 边界的保守跳过）
                if (ls < nodeStart + local || le > nodeStart + child.text.length) continue;
                if (ls > nodeStart + local) pushPiece(child.text.slice(local, ls - nodeStart), child.marks);
                flushSeg();
                const latex = cleanMathLatex(lit.latex);
                const node = schema.nodes.blockMath.create({
                  latex,
                  multiline: /\n/.test(latex),
                });
                nodes.push(node);
                acc += node.nodeSize;
                // 光标落在字面量内/边界（含先打右 $$ 再补左 $$ 的情形）→ 落到公式之后续输
                if (headOffset >= ls && headOffset <= le) newPos = acc;
                textOffset = le;
                local = le - nodeStart;
              }
              if (local < child.text.length) pushPiece(child.text.slice(local), child.marks);
            });
            flushSeg();
            if (nodes.length === 0) continue;
            tr = tr.replaceWith(blockPos, blockPos + block.nodeSize, Fragment.fromArray(nodes));
            if (newPos != null) {
              // 不 clamp 进 atom 内部（clamp 到 size-1 会落进 blockMath atom，续输会删节点）；
              // 块末 gap 位置合法（续输由 PM 自动成段）；near 会落回前段/原子，反失续输位
              tr = tr.setSelection(TextSelection.create(tr.doc, newPos));
            }
          }
          // 跨段 $$ 收拢：整段区间替换为单个 blockMath（自右向左）
          for (const cb of crossBlocks.sort((a, b) => b.from - a.from)) {
            const node = schema.nodes.blockMath.create({ latex: cb.latex, multiline: /\n/.test(cb.latex) });
            const head = newState.selection.head;
            const from = tr.mapping.map(cb.from);
            const to = tr.mapping.map(cb.to);
            tr = tr.replaceWith(from, to, Fragment.from(node));
            if (newState.selection.empty && head >= cb.from && head <= cb.to) {
              tr = tr.setSelection(TextSelection.create(tr.doc, from + node.nodeSize));
            }
          }
          if (madeRuby) suppressRubyAutoExpandOnce();
          return tr;
        },
      }),
    ];
  },
});

export default TemplateLive;
