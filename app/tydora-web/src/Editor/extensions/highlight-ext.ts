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

export const TydoraHighlight = Highlight.extend({
  // 高亮（==text==）去掉默认的「行首或空白」前缀限制，支持行中即时渲染
  addInputRules() {
    return [markInputRule({ find: /(==(?!\s+==)((?:[^=]+))==(?!\s+==))$/, type: this.type })];
  },
  // 去掉默认 renderHTML 里的 `color: inherit`：荧光笔底色是浅色，
  // 前景统一交给 theme.css 的深墨色（否则深色主题下会变成浅字浅底，
  // 而行内 style 优先级高于样式表，改不动）。
  addAttributes() {
    const parent = (this.parent?.() ?? {}) as Record<string, any>;
    if (!parent.color) return parent;
    return {
      ...parent,
      color: {
        ...parent.color,
        renderHTML: (attributes: Record<string, any>) =>
          attributes.color
            ? { "data-color": attributes.color, style: `background-color: ${attributes.color}` }
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
