/**
 * markdown-it 规则安装守卫 —— 以及解析期的"词边界"标记。
 *
 * tiptap-markdown 的 MarkdownParser.parse() 每次解析都会重新调用所有扩展的
 * `markdown.parse.setup()`，而 markdown-it 的 ruler.push / before / after 都不做
 * 重名去重 —— 不设防时规则会随解析次数线性累加（同一规则被重复执行，渲染开销
 * 持续增长，长时间编辑 / 频繁外部刷新后明显变慢）。
 *
 * 用法：每个扩展的 setup 开头做一次安装判断：
 *
 *   setup(markdownit: any) {
 *     if (!installMarkdownRuleOnce(markdownit, "my_rule")) return;
 *     markdownit.core.ruler.push("my_rule", ...);
 *   }
 *
 * 标记挂在 markdown-it 实例上：编辑器重建会创建新的 MarkdownParser（新实例），
 * 标记随之重置，不会漏装。
 */
export function installMarkdownRuleOnce(md: any, key: string): boolean {
  if (!md || typeof md !== "object") return true;
  const flags: Record<string, boolean> = (md.__tydoraMarkdownRules ??= {});
  if (flags[key]) return false;
  flags[key] = true;
  return true;
}

/**
 * 解析期的"词边界"标记（Private Use Area，U+E000 / U+E001）。
 *
 * 解决的问题：**紧贴行内原子节点的 mark 分隔符**（`**` / `*` / `~~`）在 markdown-it
 * 的 flanking 规则下一个也开不了 / 闭不了。
 *
 * 原因：解析时 `{{Ruby|…}}` 会被换成 `<span class="md-ruby" …>`，而 `<` `>`
 *（以及图片语法起头的 `!`、收尾的 `)`）在 markdown-it 眼里**都算标点**。
 * CommonMark 的 flanking 规则要求"标点旁边必须还有空白或标点才算能开 / 能闭"，
 * 于是下面这两行里的 mark 会丢：
 *   `前**{{Ruby|際|きわ}}**後の世界`   （`**` 左右分别贴着「前」和 `<`）
 *   `前**![x](a.png)**後の世界`        （`**` 左右分别贴着「前」和 `!`）
 *
 * 修法：在这些原子节点的 Markdown 写法**两侧各加一个既非空白、也非标点的字符**，
 * flanking 就会把它当成"词"来算 —— `**词**` 永远成立。
 *
 * 关键：标记**绝不能漏进正文**。所以它只在 markdown-it 的 token 里存在一小会儿：
 *   before("inline") 插入 → inline 分词 / 解析强调 → after("inline") 由
 *   installWordMarkCleanup 从 token.content 里清掉 → 之后才渲染 HTML。
 * 也就是说它既不会出现在 DOM、也不会进入 ProseMirror 文档、更不会写进磁盘文件。
 */
export const WORD_MARK_START = "\uE000";
export const WORD_MARK_END = "\uE001";
const WORD_MARK_RE = /[\uE000\uE001]/g;

/**
 * 幂等安装：inline 解析结束后，把词边界标记从所有 token 的内容里清掉。
 *
 * 必须挂在 `inline` **之后**：强调的配对（balance_pairs / emphasis）在 inline 阶段
 * 就完成了，标记的使命那时已经结束；再晚（渲染时）就来不及了。
 */
export function installWordMarkCleanup(md: any): void {
  if (!installMarkdownRuleOnce(md, "md_word_mark_cleanup")) return;
  md.core.ruler.after("inline", "md_word_mark_cleanup", (state: any) => {
    const clean = (tokens: any[]) => {
      for (const token of tokens) {
        if (token.content) token.content = token.content.replace(WORD_MARK_RE, "");
        if (token.children?.length) clean(token.children);
      }
    };
    clean(state.tokens);
  });
}

/**
 * 图片语法：只认标准 `![alt](url)`（URL 允许 `<…>` 包裹或带一层括号），
 * 且前面不能是转义的 `\`（`\![…](…)` 是字面量，插进标记会把转义拆开）。
 *
 * 有意写得保守：匹配不上只是"这个 mark 分隔符仍然开不了"（旧行为），
 * 不会往错误的位置插标记。应用序列化图片用的就是这种形式（见 TipTapEditor 的 TiptapImage）。
 * 注意 `![[嵌入]]`（Obsidian 写法）不走这里，它由 wiki-link 扩展转成 HTML。
 */
const IMAGE_SYNTAX_RE = /(?<!\\)!\[[^\]]*\]\((?:<[^>]*>|[^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/g;

/** 幂等安装：给图片语法两侧加词边界标记（配合 installWordMarkCleanup 使用） */
export function installImageWordMarkRule(md: any): void {
  // 谁插标记谁负责清理：图片扩展可能出现在没有注音扩展的编辑器里
  //（那样仅靠注音扩展安装 cleanup 就会把标记漏进正文）。
  installWordMarkCleanup(md);
  if (!installMarkdownRuleOnce(md, "md_image_word_mark")) return;
  md.core.ruler.before("inline", "md_image_word_mark", (state: any) => {
    state.tokens.forEach((token: any) => {
      if (token.type !== "inline" || !token.content || !token.content.includes("![")) return;
      token.content = token.content.replace(
        IMAGE_SYNTAX_RE,
        (whole: string) => `${WORD_MARK_START}${whole}${WORD_MARK_END}`,
      );
    });
  });
}
