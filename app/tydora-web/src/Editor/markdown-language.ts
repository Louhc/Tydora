/**
 * Tydora 源码模式（CodeMirror）使用的 Markdown 语言。
 *
 * 在标准 GFM / 上下标之外，所有 `{{...}}` 模板都会被整体匹配：
 * - 已知模板且参数结构完整：模板色；
 * - 未知模板、参数不足、花括号不配平：警示色，仍覆盖完整源码范围。
 *
 * 这样源码模式不会只识别 Ruby，也不会让错误模板散落成普通文本。
 */
import { Language, foldNodeProp } from "@codemirror/language";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { parser as markdownParser, GFM, Subscript, Superscript } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

/** 所有合法模板共用的源码高亮 tag。 */
export const templateShorthandTag = Tag.define();
/** 所有结构错误的 `{{...}}` 共用警示 tag。 */
export const templateErrorShorthandTag = Tag.define();

const TEMPLATE_NAMES = new Set([
  "Ruby", "Color", "Hilite", "Font", "Straight", "Wavy", "Double", "Dashed", "Dotted",
]);

/** 从一处 `{{` 开始扫描同层配对的 `}}`；未闭合时返回当前行尾并标记错误。 */
function scanTemplate(text: string): { end: number; balanced: boolean } {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") return { end: i, balanced: false };
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) return { end: i + 1, balanced: true };
      if (depth < 0) return { end: i + 1, balanced: false };
    }
  }
  return { end: text.length, balanced: false };
}

/** 只按最外层分隔符计数，嵌套模板里的 `|` / `:` 不影响参数数量。 */
function topLevelSeparatorCount(text: string): number {
  let depth = 0;
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" && text[i + 1] === "{") { depth++; i++; continue; }
    if (text[i] === "}" && text[i + 1] === "}") { depth--; i++; continue; }
    if (depth === 0 && (text[i] === "|" || text[i] === ":")) count++;
  }
  return count;
}

/** 所有 `{{...}}` 都先被匹配；只有已知模板且参数数量足够才是正常模板。 */
function isValidTemplate(text: string): boolean {
  const m = /^\{\{\s*([A-Za-z]+)\s*/.exec(text);
  if (!m || !TEMPLATE_NAMES.has(m[1])) return false;
  const separators = topLevelSeparatorCount(text.slice(m[0].length));
  const required = m[1] === "Ruby" || m[1] === "Color" || m[1] === "Hilite" || m[1] === "Font" ? 2 : 3;
  if (separators < required) return false;

  // 嵌套模板也必须各自合法：不能因为外层配平，就把错误的内层吞掉。
  for (let i = 2; i < text.length - 1; i++) {
    if (text[i] !== "{" || text[i + 1] !== "{") continue;
    const nested = scanTemplate(text.slice(i));
    if (!nested.balanced || !isValidTemplate(text.slice(i, i + nested.end))) return false;
    i += nested.end - 1;
  }
  return true;
}

const templateShorthand = {
  defineNodes: [
    { name: "TydoraTemplate", style: templateShorthandTag },
    { name: "TydoraTemplateError", style: templateErrorShorthandTag },
  ],
  parseInline: [
    {
      name: "TydoraTemplate",
      parse(cx: any, next: number, pos: number) {
        if (next !== 123 /* '{' */ || cx.slice(pos, pos + 2) !== "{{") return -1;
        const text = cx.slice(pos, cx.end);
        const scanned = scanTemplate(text);
        const nodeName = scanned.balanced && isValidTemplate(text.slice(0, scanned.end))
          ? "TydoraTemplate"
          : "TydoraTemplateError";
        return cx.addElement(cx.elt(nodeName, pos, pos + scanned.end));
      },
    },
  ],
};

/** 表格折叠：`markdownLanguage` 里也带了这条，自己配置时要一并补上。 */
const tableFold = {
  props: [
    foldNodeProp.add({
      Table: (tree: any, state: any) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
    }),
  ],
};

/** Tydora 的 Markdown 语言：GFM + 上下标 + 全量 `{{...}}` 模板高亮，不含 Emoji 短代码。 */
export const tydoraMarkdownLanguage = new Language(
  commonmarkLanguage.data,
  markdownParser.configure([
    GFM,
    Subscript,
    Superscript,
    templateShorthand,
    tableFold,
  ]),
  [],
  "markdown",
);
