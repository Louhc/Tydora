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
/** `{{Ruby|本体|读音}}`（与编辑器模板语法一致：`|` 或 `:` 分隔 ✓） */
const RUBY_TEMPLATE_SRC = String.raw`\{\{Ruby\s*[|:]\s*([^|{}:\n]*?)\s*[|:]\s*([^|{}:\n]*?)\s*\}\}`;

/** 在一段纯字符串里找全部命中（不重叠） */
function findAllRanges(hay: string, needle: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let idx = 0;
  while ((idx = hay.indexOf(needle, idx)) !== -1) {
    out.push([idx, idx + needle.length]);
    idx += needle.length;
  }
  return out;
}

/**
 * 把注音模板展开成**本体版**或**读音版**，并给出"展开串下标 → 原文下标"的映射 ✓。
 *
 * 为什么需要映射：高亮要落在**原文**的偏移上（IR 靠它映射 PM 位置 ✓），
 * 但用户搜索的可能是展开后的文字（`{{Ruby|A|X}}B` 里的 `AB` ✓）。
 */
function expandRubyTemplates(
  markdown: string,
  mode: "base" | "rt",
): { text: string; map: number[]; spans: Array<[number, number]> } {
  const re = new RegExp(RUBY_TEMPLATE_SRC, "gd");
  let text = "";
  const map: number[] = [];
  const spans: Array<[number, number]> = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown))) {
    for (let i = last; i < m.index; i++) {
      text += markdown[i];
      map.push(i);
    }
    // 只保留本体/读音那一段；用 indices（d 标志）拿到它在原文里的绝对位置 ✓
    const indices = (m as any).indices as Array<[number, number] | undefined> | undefined;
    const cap = mode === "base" ? indices?.[1] : indices?.[2];
    const [s, e] = cap ?? [m.index, m.index + m[0].length];
    for (let i = s; i < e; i++) {
      text += markdown[i];
      map.push(i);
    }
    spans.push([m.index, m.index + m[0].length]);
    last = m.index + m[0].length;
  }
  for (let i = last; i < markdown.length; i++) {
    text += markdown[i];
    map.push(i);
  }
  return { text, map, spans };
}

/**
 * 在 Markdown 原文里找出全部命中（大小写不敏感，**不重叠**）。
 *
 * 除了**原文直接匹配** ✓，还会把注音模板展开成**本体版**与**读音版**再匹配一次 ✓ ——
 * 这样 `AB` 既能命中 `{{Ruby|A|X}}B`（本体是 A ✓），也能命中 `{{Ruby|X|A}}B`（读音是 A ✓）。
 * 展开版的命中位置会**映射回原文偏移** ✓，保证高亮落在正确的地方 ✓。
 */
export function findMarkdownMatches(markdown: string, query: string): MarkdownMatch[] {
  const out: MarkdownMatch[] = [];
  if (!markdown || !query) return out;
  const needle = query.toLowerCase();

  // ① 原文直接匹配
  for (const [s, e] of findAllRanges(markdown.toLowerCase(), needle)) {
    out.push({ mdFrom: s, mdTo: e });
  }

  // ② 注音展开后再匹配一次（只在含模板时才做 ✓）
  if (markdown.includes("{{Ruby")) {
    for (const mode of ["base", "rt"] as const) {
      const { text, map, spans } = expandRubyTemplates(markdown, mode);
      for (const [s, e] of findAllRanges(text.toLowerCase(), needle)) {
        const from = map[s];
        const to = map[e - 1];
        if (from == null || to == null) continue;
        /**
         * ⚠️ 把范围**对齐到整个注音模板** ✓。
         *
         * 展开后的命中可能只覆盖模板内部的几个字（例如命中 `A|X}}` 这一段 ✓），
         * 这样的偏移拿去映射 PM 位置会**落到模板语法内部** ✗ —— 实测会抛
         * `RangeError: Position 95 out of range` ✗。
         * 所以只要命中与某个模板**有交集**，就把整段模板包含进来 ✓（高亮覆盖整个注音 ✓）。
         */
        let mdFrom = from;
        let mdTo = to + 1;
        for (const [ts, te] of spans) {
          if (ts < mdTo && te > mdFrom) {
            mdFrom = Math.min(mdFrom, ts);
            mdTo = Math.max(mdTo, te);
          }
        }
        out.push({ mdFrom, mdTo });
      }
    }
  }

  // 去重 + 按偏移升序（首尾相接的重叠只保留一个 ✓）
  out.sort((a, b) => a.mdFrom - b.mdFrom || a.mdTo - b.mdTo);
  const dedup: MarkdownMatch[] = [];
  for (const m of out) {
    const prev = dedup[dedup.length - 1];
    if (prev && m.mdFrom < prev.mdTo) continue;
    dedup.push(m);
  }
  return dedup;
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
