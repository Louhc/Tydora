import { Mark, mergeAttributes, getStyleProperty } from "@tiptap/core";

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
