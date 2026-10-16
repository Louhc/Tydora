import { Mark, mergeAttributes, getStyleProperty } from "@tiptap/core";
import {
  collectMarkRunText,
  colorTemplateHtml,
  decodeColorParam,
  encodeColorParam,
  installTemplateRuleOnce,
  colorHtmlTags,
  registerTemplateRenderer,
  splitFirstParam,
  templateUnsafeReason,
} from "../markdown-templates";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    textColor: {
      /** 给选区（或之后输入的文字）设置颜色，传 CSS 颜色值。 */
      setTextColor: (color: string) => ReturnType;
      /** 清除文字颜色，回到主题默认前景色。 */
      unsetTextColor: () => ReturnType;
    };
  }
}

/**
 * 文字颜色标记：渲染成 `<span style="color: …">`。
 *
 * 为什么自己写而不是用 @tiptap/extension-text-style + extension-color：
 * 这两个包本项目没装；而且自己写能精确控制 Markdown 往返 —— 文字颜色没有对应的
 * Markdown 语法，tiptap-markdown 对没有 markdown spec 的 mark 会退化成内联 HTML
 * （走 renderHTML 的 getMarkTags），正好保留颜色。
 *
 * `data-color` 同时写入，用来做无损往返：浏览器会把行内 style 里的 `#e5484d`
 * 规范化成 `rgb(229, 72, 77)`，只读 style 的话每次打开都会把颜色写法改一遍。
 * 解析时优先读 `data-color`，读不到再退回行内 style（兼容外部粘贴进来的内容）。
 */
export const TextColor = Mark.create({
  name: "textColor",

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (element) =>
          element.getAttribute("data-color")
          || getStyleProperty(element, "color")
          || element.style?.color
          || null,
        renderHTML: (attributes) => {
          if (!attributes.color) return {};
          return {
            "data-color": attributes.color,
            style: `color: ${attributes.color}`,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span",
        // 只有真的带文字颜色时才认这个 span。
        // 不能只写 `span[style*='color']`：`background-color` 也包含 "color" 子串，
        // 会把仅有背景色（或其它行内样式）的 span 也吃成一个空颜色的 mark，
        // 保存时白白多出一对 `<span>`。
        getAttrs: (element) => {
          const el = element as HTMLElement;
          const color =
            el.getAttribute("data-color")
            || getStyleProperty(el, "color")
            || el.style?.color;
          return color ? null : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", mergeAttributes(HTMLAttributes), 0];
  },

  addCommands() {
    return {
      setTextColor:
        (color: string) =>
        ({ commands }) =>
          commands.setMark(this.name, { color }),
      unsetTextColor:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },

  /**
   * Markdown 序列化 / 解析（tiptap-markdown 的扩展点，见 Editor/markdown-templates.ts）。
   *
   * - **写入**：`{{Color|red|文字}}`，与 `{{Ruby|…}}` 同一套约定；命中调色板写 id、
   *   否则写原样 CSS 值。内容里含 `|` / `}}` 这类无法无歧义表达的字符时**退回内联 HTML**
   *   （HTML 能吃下任意文本，而且原有的 parseHTML 照旧认它）。
   * - **读取**：由 markdown-it 规则把 `{{Color|…}}` 重写成同样的
   *   `<span data-color="…">`，所以这里的 parseHTML 一行都不用改；
   *   旧文件里的内联 HTML 也照旧解析（向后兼容）。
   *
   * 自嵌套（`{{Color|…|{{Color|…|x}}}}`）不需要特殊代码：ProseMirror 的 mark 同类型唯一，
   * 解析时天然"最内层胜"；写入时按 run 各自包链，不会产生自嵌套。
   */
  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state: any, mark: any, parent: any, index: number) {
            const run = collectMarkRunText(parent, index, mark, 1);
            const color = mark.attrs.color ? encodeColorParam(mark.attrs.color, TEXT_COLORS) : "";
            if (!color || templateUnsafeReason(run)) return colorHtmlTags(color || null, TEXT_COLORS)[0];
            return `{{Color|${color}|`;
          },
          close(_state: any, mark: any, parent: any, index: number) {
            const run = collectMarkRunText(parent, index, mark, -1);
            const color = mark.attrs.color ? encodeColorParam(mark.attrs.color, TEXT_COLORS) : "";
            if (!color || templateUnsafeReason(run)) return colorHtmlTags(color || null, TEXT_COLORS)[1];
            return "}}";
          },
        },
        parse: {
          setup(markdownit: any) {
            registerTemplateRenderer("Color", (_match, inner) => {
              // 注意：`inner` 是"参数 + 内容"的整体（如 `red|文字`），必须切掉参数那一段再包 HTML
              const { param, content } = splitFirstParam(inner);
              const color = decodeColorParam(param, TEXT_COLORS);
              if (!color) return null; // 颜色不合法 → 原样留作文本（不吞内容）
              return colorTemplateHtml(color, content);
            });
            installTemplateRuleOnce(markdownit);
          },
        },
      },
    };
  },
});

export default TextColor;

export interface TextColorOption {
  id: string;
  /** 写入 mark 的 CSS 颜色（color + data-color） */
  color: string;
  /** i18n key：editor.textColor.<id> */
  labelKey: string;
}

/**
 * 文字颜色调色板。
 *
 * 刻意取**中间调**的饱和色：文字颜色要压在主题背景上，浅色主题下太浅看不见、
 * 深色主题下太深看不见，中间调是两边都能读的折中。
 * （高亮底色用浅色 + 深墨前景是另一套逻辑，见 Editor/highlighter.ts。）
 */
export const TEXT_COLORS: TextColorOption[] = [
  { id: "red", color: "#e03131", labelKey: "editor.textColor.red" },
  { id: "orange", color: "#e8590c", labelKey: "editor.textColor.orange" },
  { id: "green", color: "#2f9e44", labelKey: "editor.textColor.green" },
  { id: "blue", color: "#1c7ed6", labelKey: "editor.textColor.blue" },
  { id: "violet", color: "#7048e8", labelKey: "editor.textColor.violet" },
  { id: "pink", color: "#d6336c", labelKey: "editor.textColor.pink" },
];
