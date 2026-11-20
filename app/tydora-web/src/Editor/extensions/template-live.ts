import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
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
          if (!trs.some((tr) => tr.docChanged)) return null;
          // 注音自己的展开/收起交易不参与即时转换（展开出的字面量是编辑态，非新输入）
          if (trs.some((tr) => tr.getMeta(RUBY_TOGGLE_META))) return null;

          // 改动区间（累积映射到最终 state）→ 涉及的文本块
          const mapping = new Mapping();
          const invert = new Mapping();
          const ranges: Array<[number, number]> = [];
          for (const tr of trs) {
            for (const step of tr.steps) {
              const s = step as any;
              if (typeof s.from !== "number") continue;
              ranges.push([mapping.map(s.from), mapping.map(s.to ?? s.from)]);
            }
            mapping.appendMapping(tr.mapping);
            invert.appendMapping(tr.mapping.invert());
          }
          if (ranges.length === 0) return null;

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
          for (const [from, to] of ranges) {
            const lo = Math.max(0, from - 1);
            const hi = Math.min(newState.doc.content.size, to + 1);
            newState.doc.nodesBetween(lo, hi, (node: any, pos: number) => {
              if (node.isTextblock && !SKIP_BLOCK_TYPES.has(node.type.name)) blocks.set(pos, node);
            });
          }

          const replacements: Replacement[] = [];
          let madeRuby = false;
          for (const [blockPos, block] of blocks) {
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
          if (replacements.length === 0) return null;

          let tr = newState.tr;
          for (const r of replacements.sort((a, b) => b.from - a.from)) {
            tr = tr.replaceWith(r.from, r.to, r.frag);
          }
          if (madeRuby) suppressRubyAutoExpandOnce();
          return tr;
        },
      }),
    ];
  },
});

export default TemplateLive;
