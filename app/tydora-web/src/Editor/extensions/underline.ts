// 下划线（五种样式）—— 行内 mark。
//
// 语法（与 `{{Ruby|…}}` / `{{Color|…}}` / `{{Hilite|…}}` 同一套模板约定）：
//   {{Straight|颜色|粗细|文本}}   直线
//   {{Wavy|颜色|粗细|文本}}       波浪
//   {{Double|颜色|粗细|文本}}     双线
//   {{Dashed|颜色|粗细|文本}}     虚线
//   {{Dotted|颜色|粗细|文本}}     圆点
//
// - 颜色留空 → `var(--accent)`（主题强调色）；粗细留空 → 默认 2px。
//   留空就是空字段：`{{Wavy|||這段話}}`。
// - 内容里含**模板外**的 `|`、表格占位符、或花括号不配平时，退回内联 HTML
//   （与 Color / Hilite 一致）：`<span class="md-underline" data-style="wavy" …>`。
// - 直线/虚线/圆点/双线用 `border-bottom` 画（`text-decoration` 不会画在注音的
//   `padding-inline` 上，长读音会断线）；波浪线只能用 `text-decoration: wavy`。
// - 为什么是 mark 而不是节点：下划线是字级装饰，可以跨行、可以和
//   Hilite / Color / Ruby 叠加；Ruby 那种"本体是文本内容"的节点模型不适用。
import { Mark, mergeAttributes, InputRule } from "@tiptap/core";
import {
  collectMarkRunText,
  decodeColorParam,
  encodeColorParam,
  installTemplateRuleOnce,
  normalizePaletteColor,
  registerTemplateRenderer,
  splitParams,
  templateUnsafeReason,
  underlineHtmlTags,
  underlineTemplateHtml,
  type UnderlineStyle,
} from "../markdown-templates";
import { TEXT_COLORS } from "./text-color";

/** 模板名 ↔ 内部样式值 */
const NAME_BY_STYLE: Record<UnderlineStyle, string> = {
  straight: "Straight",
  wavy: "Wavy",
  double: "Double",
  dashed: "Dashed",
  dotted: "Dotted",
};
const STYLE_BY_NAME: Record<string, UnderlineStyle> = Object.fromEntries(
  Object.entries(NAME_BY_STYLE).map(([style, name]) => [name, style as UnderlineStyle]),
);
const STYLES = Object.keys(NAME_BY_STYLE) as UnderlineStyle[];

/** 粗细参数：纯数字按 px；也接受 px / em / rem 长度 */
const WIDTH_RE = /^\d+(?:\.\d+)?(?:px|em|rem)?$/;

/** 只认五种样式，其余按直线处理 */
function normalizeStyle(value: unknown): UnderlineStyle {
  return STYLES.includes(value as UnderlineStyle) ? (value as UnderlineStyle) : "straight";
}

/** 默认粗细：双线至少要 3px 才看得出两条 */
function defaultWidth(_style: UnderlineStyle): string {
  // 双线也用 2px：Chromium 下 3px 会糊成一根粗条（用户反馈"双下划线太粗"），
  // 2px 才看得出是两条细线；想更细可以显式写 {{Double||1|…}}。
  return "2px";
}

/** 粗细 → 边框宽度 / 波浪线粗细 的值 */
function widthToCss(width: string | null | undefined, style: UnderlineStyle): string {
  const w = String(width ?? "").trim();
  if (!w) return defaultWidth(style);
  if (/^\d+(?:\.\d+)?$/.test(w)) return `${w}px`;
  return WIDTH_RE.test(w) ? w : defaultWidth(style);
}


/** 五种样式的行内 CSS。
 *
 * ⚠️ 除了波浪线，其余四种都用 **border-bottom** 而不是 `text-decoration`：
 *
 * 注音为长读音预留了 `padding-inline`（见 theme.css 的 `.md-ruby`），而 Chrome 的
 * `text-decoration` **不会画在行内元素的 padding 区域** —— 于是
 * `{{Straight|||**{{Ruby|育|はぐく}}む**}}`（读音远长于本体）会在注音两侧的留白处**断线**
 * （用户实测："注音太长，下划线中间断开"）。
 * 边框是画在行内盒的边界上的，会把 padding 一起包进去 → 连续 ✓。
 *
 * 波浪线没有对应的 border-style，只能用 `text-decoration: wavy`（长注音时仍会有一小段缺口，
 * 这是 text-decoration 的固有行为，要彻底解决得改注音的留白策略）。
 */
function underlineCss(style: UnderlineStyle, color: string, width: string | null | undefined): string {
  if (style === "wavy") {
    return [
      "text-decoration-line: underline",
      "text-decoration-style: wavy",
      `text-decoration-color: ${color}`,
      `text-decoration-thickness: ${widthToCss(width, style)}`,
      "text-underline-offset: .18em",
      "text-decoration-skip-ink: none",
    ].join("; ");
  }
  const t = widthToCss(width, style);
  /**
   * double 用 `max(3px, 粗细)`：Chromium 下 border-style: double 至少要 3px
   * 才画得出两条线（2px 会退化成一个实心条）。
   */
  const borderWidth = style === "double" ? `max(3px, ${t})` : t;
  const borderStyle = style === "straight" ? "solid" : style; // solid / dashed / dotted / double
  return [
    `border-bottom: ${borderWidth} ${borderStyle} ${color}`,
    // 近似原来的 text-underline-offset: .18em（边框贴着内容盒底部，用 padding 顶开）
    "padding-bottom: .12em",
  ].join("; ");
}

/** 颜色值：空 → 主题强调色；有值 → 调色板归一化成 hex
 *  ⚠️ 读的是 `data-color`：renderHTML 拿到的 HTMLAttributes 里只有各属性 renderHTML 的输出，
 *  原始 `color` 那个 key 已经变成 `data-color` 了（写成 attrs.color 会永远落到 var(--accent)）。
 */
function resolveColor(attrs: Record<string, any>): string {
  const raw = (attrs["data-color"] ?? attrs.color) as string | undefined;
  return raw ? normalizePaletteColor(raw, TEXT_COLORS) : "var(--accent)";
}

export const Underline = Mark.create({
  name: "underline",

  /** 同一段文字只能有一种下划线样式（换一种就是替换，不是叠加） */
  excludes: "underline",

  addAttributes() {
    return {
      style: {
        default: "straight",
        parseHTML: (element) => normalizeStyle(element.getAttribute("data-style")),
        renderHTML: (attributes) => ({ "data-style": normalizeStyle(attributes.style) }),
      },
      color: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-color") || null,
        renderHTML: (attributes) => (attributes.color ? { "data-color": attributes.color } : {}),
      },
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute("data-width") || null,
        renderHTML: (attributes) => (attributes.width ? { "data-width": attributes.width } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "span.md-underline",
        getAttrs: (element) => {
          const style = (element as HTMLElement).getAttribute("data-style");
          // 没有合法 data-style 的 span 不认，避免把别的行内 span 吃成下划线
          return STYLES.includes(style as UnderlineStyle) ? { style } : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    const style = normalizeStyle(HTMLAttributes["data-style"]);
    const css = underlineCss(style, resolveColor(HTMLAttributes), HTMLAttributes["data-width"] as string);
    /**
     * ⚠️ 这里可以写行内 style（DOM 由 TipTap 生成，不经过 markdown 解析），
     * 但**退回 HTML 模板**时不能带 style —— 见 markdown-templates 里 colorHtmlTags 的说明
     *（`style="… #hex"` 里的空格+`#` 会被 `#标签` 规则劈开）。
     */
    return ["span", mergeAttributes(HTMLAttributes, { class: "md-underline", style: css }), 0];
  },

  addInputRules() {
    return [
      new InputRule({
        // 输入 {{Wavy|颜色|粗细|文字}}（参数可空）→ 立即转成下划线
        find: /\{\{(Straight|Wavy|Double|Dashed|Dotted)\|([^|{}]*)\|([^|{}]*)\|([^|{}]*)\}\}$/,
        handler: ({ range, match, commands }) => {
          const style = STYLE_BY_NAME[match[1]] ?? "straight";
          const rawColor = match[2].trim();
          const widthParam = match[3].trim();
          const text = match[4];
          if (!text) return;
          const color = rawColor ? decodeColorParam(rawColor, TEXT_COLORS) : null;
          if (rawColor && !color) return;
          if (widthParam && !WIDTH_RE.test(widthParam)) return;
          commands.insertContentAt(range, {
            type: "text",
            text,
            marks: [{ type: "underline", attrs: { style, color, width: widthParam || null } }],
          });
        },
      }),
    ];
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state: any, mark: any, parent: any, index: number) {
            const style = normalizeStyle(mark.attrs.style);
            const color = mark.attrs.color ? encodeColorParam(mark.attrs.color, TEXT_COLORS) : "";
            const width = String(mark.attrs.width ?? "");
            const run = collectMarkRunText(parent, index, mark, 1);
            if (templateUnsafeReason(run)) {
              return underlineHtmlTags(style, mark.attrs.color, mark.attrs.width)[0];
            }
            return `{{${NAME_BY_STYLE[style]}|${color}|${width}|`;
          },
          close(_state: any, mark: any, parent: any, index: number) {
            const style = normalizeStyle(mark.attrs.style);
            const run = collectMarkRunText(parent, index, mark, -1);
            if (templateUnsafeReason(run)) {
              return underlineHtmlTags(style, mark.attrs.color, mark.attrs.width)[1];
            }
            return "}}";
          },
        },
        parse: {
          setup(markdownit: any) {
            /**
             * `{{Wavy|颜色|粗细|内容}}` → `<span class="md-underline" data-style="wavy" …>`。
             * 颜色/粗细为空表示"跟随主题/默认"；参数非法时返回 null，
             * 让这段原文留在正文里（不要默默吞掉内容）。
             */
            for (const style of STYLES) {
              registerTemplateRenderer(NAME_BY_STYLE[style] as any, (_match, inner: string) => {
                const parts = splitParams(inner, 2);
                if (!parts) return null;
                const [colorParam, widthParam, content] = parts;
                const rawColor = colorParam.trim();
                const color = rawColor ? decodeColorParam(rawColor, TEXT_COLORS) : null;
                if (rawColor && !color) return null;
                const width = widthParam.trim();
                if (width && !WIDTH_RE.test(width)) return null;
                return underlineTemplateHtml(style, color, width || null, content);
              });
            }
            installTemplateRuleOnce(markdownit);
          },
        },
      },
    };
  },
});

export default Underline;

/** 供右键菜单 / 快捷键引用：样式 id 列表（顺序即菜单顺序） */
export const UNDERLINE_STYLES = STYLES;
