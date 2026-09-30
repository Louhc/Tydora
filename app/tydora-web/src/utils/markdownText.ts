/**
 * 行内 HTML 相关的 Markdown 文本工具。
 *
 * 有颜色的文字/高亮在 Markdown 里就是内联 HTML（例如
 * `<span data-color="#e03131" style="color: rgb(224, 49, 49);">标题</span>`，
 * 见 Editor/extensions/text-color.ts 与 Editor/highlighter.ts）——
 * Markdown 没有颜色语法，tiptap-markdown 对这种没有 markdown spec 的 mark
 * 会退化成内联 HTML。于是所有「按原始 Markdown 扫描文本」的地方都必须先剥掉标记。
 */

/**
 * 去掉行内 HTML 标签与注释，只留文字。
 *
 * 只匹配「标签形状」的片段：`<` 后紧跟字母或 `/`，后面允许一段以空白开头的属性。
 * 这样正文里的 `a < b`、Markdown 自动链接 `<https://example.com>` 都不会被误删
 * （自动链接的 `:` 紧跟在名字后面，不满足「空白或直接 `>`」）。
 */
export function stripInlineHtml(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(\s[^>]*)?>/g, "")
    .trim();
}
