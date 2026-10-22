/**
 * 应用版高亮（`Highlight`）扩展。
 *
 * 从 TipTapEditor 的内联 `Highlight.extend({...})` 抽出来，原因有二：
 *   1. **可测**：模板序列化（`{{Hilite|yellow|…}}`）写在 `addStorage` 里，
 *      内联的话 harness 拿不到这份实现，只能复制一份假的来测 —— 那就等于没测；
 *   2. TipTapEditor 已经很大，扩展定义放各自文件更清楚。
 */
import { markInputRule } from "@tiptap/core";
import Highlight from "@tiptap/extension-highlight";
import { HIGHLIGHT_COLORS } from "../highlighter";
import {
  collectMarkRunText,
  decodeColorParam,
  encodeColorParam,
  hiliteTemplateHtml,
  installTemplateRuleOnce,
  hiliteHtmlTags,
  registerTemplateRenderer,
  splitFirstParam,
  templateUnsafeReason,
} from "../markdown-templates";

/**
 * 把调色板颜色变成**半透明**版本 ✓（高亮底色淡一点 ✓，但文字颜色不受影响 ✓）。
 *
 * 不用 `opacity`：那会把文字一起变淡 ✗；这里只给背景色加 alpha ✓。
 */
function toTranslucentColor(color: string, alpha = 0.38): string {
  const c = color.trim();
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (m) {
    const hex = m[1].length === 3 ? m[1].split("").map((ch) => ch + ch).join("") : m[1];
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  // 非 hex（rgb()/hsl() 等）→ 交给 color-mix 兜底（新 Chromium 支持 ✓）
  return `color-mix(in srgb, ${c} ${Math.round(alpha * 100)}%, transparent)`;
}
/**
 * 高亮时把 mark **也加到行内节点上**（注音等）✓。
 *
 * 为什么需要：ProseMirror 的 `addMark`/`setMark` 只给**文本**加 mark ✗ —— 注音是
 * 「带文本内容的行内节点」✓，节点本身的 `marks` 不会被更新 ✗。
 * 结果就是：选中包含注音的一段、点高亮，注音**没有**被高亮（用户实测 ✓），
 * 序列化出来也是 `{{Hilite|…|前}}{{Ruby|馴|な}}{{Hilite|…|れ後}}`（注音夹在中间 ✗）。
 *
 * 这里按当前选区把所有**非文本的行内节点**的 marks 补上（或去掉）✓。
 */
export function applyMarkToInlineNodes(
  editor: { state: any; view: any },
  markName: string,
  attrs: Record<string, any> | null,
): boolean {
  try {
    const { state } = editor;
    const type = state.schema.marks[markName];
    if (!type) return false;
    const { from, to } = state.selection;
    const tr = state.tr;
    let changed = false;
    state.doc.nodesBetween(from, to, (node: any, pos: number) => {
      if (!node.isInline || node.isText) return true; // 只看行内**节点**（注音/图片等）
      if (!node.type.allowsMarkType(type)) return true;
      const mark = attrs ? type.create(attrs) : null;
      const next = mark ? mark.addToSet(node.marks) : node.marks.filter((m: any) => m.type !== type);
      const same =
        next.length === node.marks.length && next.every((m: any, i: number) => m.eq(node.marks[i]));
      if (same) return true;
      tr.setNodeMarkup(pos, undefined, node.attrs, next);
      /**
       * ⚠️ 同时去掉**节点内部文本**上的同一个 mark ✓。
       *
       * 否则会出现"两层高亮"✗：内层文本有 mark（`setMark` 加的 ✓）+ 外层节点也有 mark
       *（本函数加的 ✓）→ DOM 变成 `<mark><span class="md-ruby"><mark>控</mark></span></mark>`
       * → 两层半透明叠加，看起来明显更深 ✗（用户实测："控"字似乎有两层高亮 ✓）。
       * 序列化只有一层 ✓（会合并），所以这个现象只出现在渲染层 ✓。
       */
      const innerFrom = pos + 1;
      const innerTo = pos + node.nodeSize - 1;
      if (innerTo > innerFrom) {
        tr.removeMark(innerFrom, innerTo, type);
        changed = true;
      }
      return true;
    });
    if (changed) editor.view.dispatch(tr);
    return changed;
  } catch {
    return false;
  }
}
export const TydoraHighlight = Highlight.extend({
  // 高亮（==text==）去掉默认的「行首或空白」前缀限制，支持行中即时渲染
  addInputRules() {
    return [markInputRule({ find: /(==(?!\s+==)((?:[^=]+))==(?!\s+==))$/, type: this.type })];
  },
  // ⚠️ 底色要**半透明** ✓、文字颜色**继承** ✓（用户要求：淡一点、不要改文字颜色 ✓）。
  // 底色仍由行内 style 给出（调色板颜色 + alpha ✓）；行内**只写 background-color**，
  // 不写 color ✓ —— 文字颜色交给 CSS 的 `color: inherit` ✓。
  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Record<string, any>;
    if (!parent.color) return parent;
    return {
      ...parent,
      color: {
        ...parent.color,
        renderHTML: (attributes: Record<string, any>) =>
          attributes.color
            ? {
                "data-color": attributes.color,
                style: `background-color: ${toTranslucentColor(attributes.color)}`,
              }
            : {},
      },
    };
  },
  /**
   * Markdown 序列化 / 解析：`{{Hilite|yellow|文字}}`，与 `{{Color|…}}` / `{{Ruby|…}}`
   * 同一套约定（详见 Editor/markdown-templates.ts）。
   *
   * 两种情形**退回内联 HTML**：
   *   ① 没有颜色（`==文字==` 输入规则产生的高亮）—— 模板要求参数，空参数写成
   *      `{{Hilite||…}}` 很难看，也没有意义；
   *   ② 内容里含 `|` / `}}` 这类无法无歧义表达的字符（HTML 能吃下任意文本）。
   *
   * 自嵌套（`{{Hilite|yellow|{{Hilite|blue|x}}}}`）无需特殊代码：mark 同类型唯一，
   * 解析时天然"最内层胜"；写入时按 run 各自包链，不会产生自嵌套。
   */
  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state: any, mark: any, parent: any, index: number) {
            const run = collectMarkRunText(parent, index, mark, 1);
            const color = mark.attrs.color ? encodeColorParam(mark.attrs.color, HIGHLIGHT_COLORS) : "";
            if (!color || templateUnsafeReason(run)) return hiliteHtmlTags(color || null, HIGHLIGHT_COLORS)[0];
            return `{{Hilite|${color}|`;
          },
          close(_state: any, mark: any, parent: any, index: number) {
            const run = collectMarkRunText(parent, index, mark, -1);
            const color = mark.attrs.color ? encodeColorParam(mark.attrs.color, HIGHLIGHT_COLORS) : "";
            if (!color || templateUnsafeReason(run)) return hiliteHtmlTags(color || null, HIGHLIGHT_COLORS)[1];
            return "}}";
          },
        },
        parse: {
          setup(markdownit: any) {
            registerTemplateRenderer("Hilite", (_match, inner) => {
              const { param, content } = splitFirstParam(inner);
              const color = decodeColorParam(param, HIGHLIGHT_COLORS);
              if (!color) return null; // 颜色不合法 → 原样留作文本
              return hiliteTemplateHtml(color, content);
            });
            installTemplateRuleOnce(markdownit);
          },
        },
      },
    };
  },
}).configure({ multicolor: true });
