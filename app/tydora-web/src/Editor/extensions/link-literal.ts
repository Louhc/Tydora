/**
 * 链接「双表示」的**规则层**（纯函数，无 DOM / 无 ProseMirror 状态）✓
 *
 * 背景：链接有两种表示 ✓
 *   - **渲染态**：真实 `link` mark（点击可打开 ✓、不占源码 ✓）
 *   - **编辑态**：`linkSource` 内联节点，内容就是 Markdown 字面量 `[文字](地址)` ✓
 *
 * 历史上这两者靠一堆启发式互相切换 ✗，于是同一类 bug 反复出现 ✓：
 *   - 字面量里被塞进非链接文字 ✗ → 收起时解析失败 ✓ → "收不起来" ✓
 *   - 收起之后又被"光标贴近自动展开" ✗ → 反复拉锯 ✓
 *   - 字面量 `content: text*` ✗ → Enter 拆不开 ✓
 *
 * 现在把规则收敛成**一条不变量** ✓，所有过渡都基于它：
 *
 *   R1：字面量的文本里**必须**恰好包含一个 `[文字](地址)` ✓；
 *       其前后若还有别的文字 ✗ → 由 {@link splitLiteral} 拆出来 ✓（降级成普通文本 ✓，不丢字 ✓）。
 *
 * 这样「渲染态 ↔ 编辑态」只是"同一个链接的两种画法" ✓，
 * 收起 = 把字面量换成 link mark ✓；展开 = 把 link mark 换成字面量 ✓ —— 不必再猜 ✓。
 */

/** 解析结果 ✓：链接本体 + 它前后被误并进来的文字 ✓ */
export interface LiteralParts {
  /** 链接之前多出来的文字（通常为空串 ✓） */
  prefix: string;
  /** 链接显示文字 ✓ */
  label: string;
  /** 链接地址 ✓ */
  href: string;
  /** 链接之后多出来的文字（展开态里接着打字就会落到这里 ✓） */
  suffix: string;
}

/**
 * 从字面量文本里解析出链接 ✓。
 *
 * ⚠️ **不加 `^…$` 锚定** ✗：编辑态里用户经常在链接前后接着打字 ✓，
 * 锚定会让整块解析失败 ✗ → 字面量永远收不起来 ✓（线上实测 ✓）。
 *
 * 规则（与编辑器文档里的约定一致 ✓）：
 *   - 文字里不允许 `[` `]` 和换行 ✓（避免嵌套歧义 ✓）；
 *   - 地址里不允许 `)` 和空白 ✓（Markdown 行内链接的常规限制 ✓）。
 */
export function parseLiteral(text: string): LiteralParts | null {
  if (!text) return null;
  const m = /\[([^[\]\n]+)\]\(([^)\s]+)\)/.exec(text);
  if (!m) return null;
  return {
    prefix: text.slice(0, m.index),
    label: m[1],
    href: m[2],
    suffix: text.slice(m.index + m[0].length),
  };
}

/** 是否"干净的字面量" ✓（前后都没有多余文字 ✓，可以直接整块还原成链接 ✓） */
export function isPureLiteral(text: string): boolean {
  const parts = parseLiteral(text);
  return !!parts && parts.prefix === "" && parts.suffix === "";
}

/** 由解析结果拼回字面量原文 ✓（往返一致性用 ✓） */
export function literalText(parts: LiteralParts): string {
  return `${parts.prefix}[${parts.label}](${parts.href})${parts.suffix}`;
}

/** 归一化结果 ✓：链接左侧文字、链接、链接右侧文字（空串表示没有 ✓） */
export interface LiteralSplit {
  before: string;
  label: string;
  href: string;
  after: string;
}

/**
 * 把字面量**拆成三段** ✓ —— R1 的落地：
 *   前面多余文字（普通文本 ✓）+ 链接（link mark ✓）+ 后面多余文字（普通文本 ✓）
 *
 * 解析不出链接时返回 `null` ✓ —— 调用方应把整块**降级成纯文本** ✓
 * （而不是像旧实现那样"原样保留非法字面量" ✗，那会让非法状态永久存在 ✓）。
 */
export function splitLiteral(text: string): LiteralSplit | null {
  const parts = parseLiteral(text);
  if (!parts) return null;
  return { before: parts.prefix, label: parts.label, href: parts.href, after: parts.suffix };
}

/**
 * 编辑态里输入文字后，光标应该落在哪 ✓。
 *
 * 用途：当归一化把"链接后面的文字"移出字面量时 ✓，
 * 需要把光标从字面量内部映射到"链接之后的普通文本"里 ✓，
 * 否则用户会感觉打字时光标乱跳 ✗。
 *
 * @param caretInLiteral 光标相对**字面量内容**的偏移 ✓（0 = 字面量最前面 ✓）
 * @returns 归一化后的新偏移：`label` 段内按比例映射 ✓，落在 suffix 里则平移到 after ✓
 */
export function mapCaretAfterNormalize(parts: LiteralParts, caretInLiteral: number): number {
  const insideLink = Math.max(0, Math.min(caretInLiteral, parts.label.length + parts.href.length + 4));
  if (insideLink <= parts.label.length) return insideLink; // 落在显示文字里 ✓
  // 落在 `](地址)` 之后 → 把整段链接算作前置长度 ✓，再进入 suffix ✓
  const linkLength = parts.label.length + parts.href.length + 4;
  return linkLength + Math.max(0, caretInLiteral - linkLength);
}
