/**
 * Tydora 源码模式（CodeMirror）使用的 Markdown 语言。
 *
 * 为什么不直接用 `@codemirror/lang-markdown` 导出的 `markdownLanguage`：
 *
 *   1. **去掉 Emoji 短代码解析。** 那个导出实际是
 *      `commonmark + [GFM, Subscript, Superscript, Emoji]`，而 `Emoji` 扩展会把任意
 *      `:字母数字下划线:` 当成 emoji 节点 —— 时间戳 `1:36:07` 里的 `:36:` 就会被误判
 *      （IR 模式并不支持 emoji 短代码，两边口径也不一致）。这里自己拼一份，不含它。
 *   2. **加上 `{{Ruby|本体|读音}}` 的内联高亮**（Tydora 自己的注音简写）。
 *
 * 构造方式刻意用 `new Language(commonmarkLanguage.data, parser, ...)`：必须带上
 * commonmark 的 language-data，否则会丢掉自动闭合括号之类的编辑行为
 *（`@codemirror/lang-markdown` 内部也是这么建的，`Language` 上没有 `configure`）。
 */
import { Language, foldNodeProp } from "@codemirror/language";
import { commonmarkLanguage } from "@codemirror/lang-markdown";
import { parser as markdownParser, GFM, Subscript, Superscript } from "@lezer/markdown";
import { Tag } from "@lezer/highlight";

/**
 * 注音简写的专用 tag。
 *
 * 不借用现成的 `tags.string` / `tags.processingInstruction`：那样会与代码块里的字符串、
 * 表格分隔行共用颜色。这里定义独立 tag，颜色在 CodeMirrorEditor.tsx 的 HighlightStyle
 * 里用 `--text-ruby`（回退到代码配色的字符串色）指定，需要单独调色时改一处即可。
 */
export const rubyShorthandTag = Tag.define();

/**
 * `{{Ruby|本体|读音}}`：也接受 `{{Ruby:本体:读音}}` 与分隔符两侧的空格，
 * 与 IR 模式的输入规则（TipTapEditor 的 ruby InputRule）保持一致；
 * 本体/读音里不允许再出现 `|`、`{}`、`:`（同 IR 规则）。
 */
const RUBY_SHORTHAND_RE = /^\{\{Ruby\s*[|:]\s*([^|{}:]+?)\s*[|:]\s*([^|{}:]+?)\}\}/;

/** `{{Ruby|…}}` 内联解析 → 一个 RubyShorthand 节点（只用于高亮，不改文本） */
const rubyShorthand = {
  defineNodes: [{ name: "RubyShorthand", style: rubyShorthandTag }],
  parseInline: [
    {
      name: "RubyShorthand",
      parse(cx: any, next: number, pos: number) {
        if (next !== 123 /* '{' */) return -1;
        const m = RUBY_SHORTHAND_RE.exec(cx.slice(pos, cx.end));
        if (!m) return -1;
        return cx.addElement(cx.elt("RubyShorthand", pos, pos + m[0].length));
      },
    },
  ],
};

/**
 * 「解析不了的模板」专用 tag（与 IR 的错误块对应，见 extensions/template-error.ts）。
 *
 * 覆盖的是 ruby 本体/读音里再塞模板这类写法 —— IR 里会渲染成错误块，
 * 这里给源码里的同一段染警示色，改对了颜色自动消失 ✓。纯语法着色，不动文本 ✓。
 */
export const templateErrorShorthandTag = Tag.define();

/**
 * 「`{{Ruby|` 之后**还没遇到任何花括号就先碰到嵌套 `{{`**」→ 本体里塞了模板。
 *
 * ⚠️ 不能用懒匹配 `[^\n]*?\{\{`：那样会**跳过 Ruby 自己的 `}}`**，把同一行后面
 * 另一个合法模板当成"嵌套"而误报（实测：`…{{Ruby|屎狗|shigou}}}}` 后面的
 * `{{Hilite|green|…}}` 就被当成了嵌套 ✗）。
 * 用 `[^{}\n]*` 保证中间不能出现任何花括号，命中即"紧随其后的第一个括号是 `{{`" ✓。
 */
const TEMPLATE_ERROR_HEAD_RE = /^\{\{Ruby\s*[|:][^{}\n]*\{\{/;

/**
 * 高亮范围：从 `{{Ruby|` 起按**配平**扫到与它配对的 `}}`（扫不到就标到行尾）。
 * 只用于着色，不改文本 ✓。
 */
function templateErrorExtent(text: string, pos: number): number {
  let depth = 0;
  for (let i = pos; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n") return i; // 单行内
    if (ch === "{" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (ch === "}" && text[i + 1] === "}") {
      depth--;
      i++;
      if (depth === 0) return i + 1;
      continue;
    }
  }
  return text.length;
}

const templateErrorShorthand = {
  defineNodes: [{ name: "TemplateErrorShorthand", style: templateErrorShorthandTag }],
  parseInline: [
    {
      name: "TemplateErrorShorthand",
      parse(cx: any, next: number, pos: number) {
        if (next !== 123 /* '{' */) return -1;
        const text = cx.slice(pos, cx.end);
        if (!TEMPLATE_ERROR_HEAD_RE.test(text)) return -1;
        const end = templateErrorExtent(text, 0);
        return cx.addElement(cx.elt("TemplateErrorShorthand", pos, pos + end));
      },
    },
  ],
};
/** 表格折叠：`markdownLanguage` 里也带了这条，自己配置时要一并补上 */
const tableFold = {
  props: [
    foldNodeProp.add({
      Table: (tree: any, state: any) => ({ from: state.doc.lineAt(tree.from).to, to: tree.to }),
    }),
  ],
};

/** Tydora 的 Markdown 语言：GFM + 上下标 + `{{Ruby|…}}` 高亮，**不含 Emoji 短代码** */
export const tydoraMarkdownLanguage = new Language(
  commonmarkLanguage.data,
  markdownParser.configure([
    GFM,
    Subscript,
    Superscript,
    templateErrorShorthand, // 必须在 rubyShorthand 之前：先命中者胜
    rubyShorthand,
    tableFold,
  ]),
  [],
  "markdown",
);
