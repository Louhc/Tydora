import { Mark, mergeAttributes, getStyleProperty } from "@tiptap/core";
import {
  collectMarkRunText,
  decodeFontParam,
  fontHtmlTags,
  fontTemplateHtml,
  installTemplateRuleOnce,
  registerTemplateRenderer,
  splitFirstParam,
  templateUnsafeReason,
} from "../markdown-templates";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    fontFamily: {
      /** 给选区（或之后输入的文字）设置字体族，传 CSS font-family 值（如 `KaiTi`、`"Segoe UI", sans-serif`）。 */
      setFontFamily: (family: string) => ReturnType;
      /** 清除字体族，回到主题默认字体。 */
      unsetFontFamily: () => ReturnType;
    };
  }
}

/**
 * 字体族标记：渲染成 `<span style="font-family: …">`，语法 `{{Font|FontFamily|Text}}`。
 *
 * 与 `text-color.ts` 同一套模板约定（见 markdown-templates.ts）：
 * - **写入**：`{{Font|KaiTi|文字}}`；内容含模板外 `|` / 不配平花括号时退回内联 HTML
 *   `<span data-font="…">`（parseHTML 照旧认它，往返无损）。
 * - **读取**：markdown-it 规则把 `{{Font|…}}` 重写成 `<span data-font="…">`，
 *   旧文件 / 外部粘贴的内联 HTML（style font-family）也照旧解析。
 * - `data-font` 与 style 双写：浏览器会规范化行内 style（引号 / 空格 / 大小写），
 *   只读 style 会让每次打开都改写一遍写法；解析优先读 `data-font` 保证逐字节往返。
 * - 参数白名单见 `decodeFontParam`：拒绝 `;` `:` `{}` `()` 等，防止拼进 style 时注入。
 *
 * 嵌套：mark 同类型唯一（自嵌套天然"最内层胜"）；与 Color / Hilite / 下划线可任意叠加，
 * 与 Ruby 叠加时沿用"Ruby 本体是模板 → 翻转"的公共规则（Font 在外、Ruby 最内）。
 */
export const FontFamily = Mark.create({
  name: "fontFamily",

  addAttributes() {
    return {
      family: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-font")
          || getStyleProperty(element, "font-family")
          || element.style?.fontFamily
          || null,
        renderHTML: (attributes) => {
          if (!attributes.family) return {};
          return {
            "data-font": attributes.family,
            style: `font-family: ${attributes.family}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span",
        // 只有真的带字体族时才认这个 span（与 textColor 的判据互不干扰：
        // 同时带 color 与 font-family 的 span 会各自解析出两个 mark）。
        getAttrs: (element) => {
          const el = element as HTMLElement;
          const family =
            el.getAttribute("data-font")
            || getStyleProperty(el, "font-family")
            || el.style?.fontFamily;
          return family ? null : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setFontFamily:
        (family: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { family }),
      unsetFontFamily:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state: any, mark: any, parent: any, index: number) {
            const run = collectMarkRunText(parent, index, mark, 1);
            const family = mark.attrs.family ? String(mark.attrs.family) : "";
            // 参数自身也要安全（命令路径可能塞进含 | 的值）→ 否则退回 HTML
            if (!family || templateUnsafeReason(run) || templateUnsafeReason(family)) {
              return fontHtmlTags(family || null)[0];
            }
            return `{{Font|${family}|`;
          },
          close(_state: any, mark: any, parent: any, index: number) {
            const run = collectMarkRunText(parent, index, mark, -1);
            const family = mark.attrs.family ? String(mark.attrs.family) : "";
            if (!family || templateUnsafeReason(run) || templateUnsafeReason(family)) {
              return fontHtmlTags(family || null)[1];
            }
            return "}}";
          },
        },
        parse: {
          setup(markdownit: any) {
            registerTemplateRenderer("Font", (_match, inner) => {
              const { param, content } = splitFirstParam(inner);
              const family = decodeFontParam(param);
              // 参数不合法 / 内容为空 → 原样留作文本（不吞内容，序列化逐字节一致）
              if (!family || !content) return null;
              return fontTemplateHtml(family, content);
            });
            installTemplateRuleOnce(markdownit);
          },
        },
      },
    };
  },
});

export default FontFamily;
