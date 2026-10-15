/**
 * 「在 Markdown 原文里查找 / 替换」的纯函数。
 *
 * 为什么匹配的**真理源**是 Markdown 原文，而不是 PM 文档的文本投影：
 *
 *  - 注音的**读音（rt）**不改 `leafText`（改了会破坏 markdown 位置映射与序列化，
 *    见 ruby.ts 的说明），但在原文里 rt 就是普通字符串，搜索理应能找到；
 *  - 原文匹配让 **IR 与 SV 的搜索口径完全一致**：SV 本来就是搜源码，
 *    IR 则只是把命中的**偏移**映射成 PM 坐标来显示高亮。
 *
 * 因此：查找/替换都在这里对字符串操作；IR 侧只负责「偏移 → PM 位置」的映射。
 */

/** 原文里的一处命中（Markdown 偏移区间，`[mdFrom, mdTo)`） */
export interface MarkdownMatch {
  mdFrom: number;
  mdTo: number;
}

/**
 * 在 Markdown 原文里找出全部命中（大小写不敏感，**不重叠**，与主流编辑器一致）。
 * 返回按偏移升序排列的数组。
 */
export function findMarkdownMatches(markdown: string, query: string): MarkdownMatch[] {
  const out: MarkdownMatch[] = [];
  if (!markdown || !query) return out;
  const hay = markdown.toLowerCase();
  const needle = query.toLowerCase();
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    out.push({ mdFrom: idx, mdTo: idx + query.length });
    idx += needle.length;
  }
  return out;
}

/**
 * 把若干处命中替换成 `replacement`，返回**新的** Markdown 原文。
 *
 * 从后往前替换，这样尚未处理的偏移不会被前面的替换打乱；
 * `matches` 不必有序（内部会排序）。
 */
export function applyMarkdownReplacements(
  markdown: string,
  matches: MarkdownMatch[],
  replacement: string,
): string {
  const sorted = [...matches].sort((a, b) => b.mdFrom - a.mdFrom);
  let out = markdown;
  for (const m of sorted) {
    out = out.slice(0, m.mdFrom) + replacement + out.slice(m.mdTo);
  }
  return out;
}

/**
 * 替换完成后，`matches[index]` 那处替换的**结尾**在新的 Markdown 里对应的偏移。
 * 用来把光标落回"刚改完的地方"（SV 里手动改文本的体感）。
 *
 * `matches` 必须是**按偏移升序**的（findMarkdownMatches 的输出即是）。
 */
export function caretOffsetAfterReplace(
  matches: MarkdownMatch[],
  index: number,
  replacement: string,
): number {
  let delta = 0;
  for (let i = 0; i < index && i < matches.length; i++) {
    delta += replacement.length - (matches[i].mdTo - matches[i].mdFrom);
  }
  const m = matches[index];
  if (!m) return 0;
  return m.mdFrom + delta + replacement.length;
}
