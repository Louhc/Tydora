/**
 * 文档级撤销栈。
 *
 * ## 为什么需要它
 * IR（TipTap/ProseMirror）与 SV（CodeMirror）是两个**独立的编辑器实例**，各自持有自己的
 * 撤销栈。切换模式会卸载其中一个、挂载另一个，于是那一侧的历史就没了 ——
 * 表现为"切换 IR/SV 后 Ctrl+Z 无法恢复"（双编辑器架构的固有缺口，不是某行写错）。
 *
 * 这里在**文档层**维护一份快照栈，作为跨模式的兜底历史。
 *
 * ## 触发策略：分层撤销（关键设计）
 * 用户按 Ctrl+Z 时：
 *   1. **先由当前编辑器处理**（原生栈）——此时事件的 defaultPrevented 会变成 true；
 *   2. 原生栈耗尽后，编辑器不再消费该事件 → App 层兜底处理器介入 → 弹出文档级快照。
 * 于是行为是"先撤当前模式内的编辑，再撤跨模式/更早的状态"，既不打断熟悉的撤销手感，
 * 也补上了切换模式丢掉的那一段。
 *
 * ## 记录策略
 * - 连续输入按时间**合并**（默认 500ms 一帧），避免每个字符一帧；
 * - 结构性操作（切模式、切文件等）调用 `flush` **强制立帧**，保证跨模式的边界清晰；
 * - 每份文档最多保留 `MAX_PER_KEY` 帧，超出丢弃最旧的；
 * - 内容未变化时不记录（避免栈里塞满重复状态）。
 *
 * key 用"文件路径"：每个文件各自一条历史，切文件不会串味。
 */

export interface DocSnapshot {
  content: string;
  at: number;
}

/** 每份文档最多保留的快照数 */
const MAX_PER_KEY = 50;
/** 连续输入的合并窗口（毫秒）：窗口内只更新"当前状态"，不追加新帧 */
const MERGE_MS = 500;

/** key → 快照栈（栈顶是最近一次"变更前"的状态） */
const stacks = new Map<string, DocSnapshot[]>();
/** key → 重做栈（被 pop 掉的"变更后"状态，按时间顺序） */
const redos = new Map<string, DocSnapshot[]>();
/** key → 最近一次"已提交状态"的内容（用于比对与作为下一帧的内容） */
const committed = new Map<string, string>();
/** key → 最近一次立帧时间 */
const lastPushAt = new Map<string, number>();

/**
 * 打开文件时初始化：只记录当前状态，**不**产生快照。
 * （否则每打开一个文件都会多出一帧"空 → 内容"的历史。）
 */
export function initDocHistory(key: string, content: string): void {
  if (!key) return;
  committed.set(key, content);
  lastPushAt.set(key, Date.now());
}

/**
 * 内容变化时调用（节流）。
 * 若距上一次立帧超过合并窗口，就把**变更前的状态**压入栈，并更新当前状态。
 */
export function pushDocHistory(key: string, content: string): void {
  if (!key) return;
  const prev = committed.get(key);
  if (prev === undefined) {
    // 尚未初始化（例如外部打开）：直接以当前内容作为基线
    initDocHistory(key, content);
    return;
  }
  if (prev === content) return; // 没变
  const now = Date.now();
  const last = lastPushAt.get(key) ?? 0;
  if (now - last < MERGE_MS) {
    // 合并窗口内：只推进"当前状态"，不追加帧（保持"变更前"那一帧不被覆盖）
    committed.set(key, content);
    return;
  }
  pushFrame(key, prev);
  committed.set(key, content);
  lastPushAt.set(key, now);
}

/**
 * 强制立帧（结构性操作：切换模式、切换分屏、应用命令等）。
 * 保证"操作前的状态"一定在栈里，即使它落在合并窗口内。
 */
export function flushDocHistory(key: string, content: string): void {
  if (!key) return;
  const prev = committed.get(key);
  if (prev === undefined) {
    initDocHistory(key, content);
    return;
  }
  if (prev !== content) pushFrame(key, prev);
  committed.set(key, content);
  lastPushAt.set(key, Date.now());
}

/**
 * 弹出最近一帧（"变更前"的状态）。
 * 返回 null 表示没有更多历史。弹出后会把**当前内容**作为新的基线继续记录，
 * 这样连续按 Ctrl+Z 可以一路往前走。
 */
export function popDocHistory(key: string, currentContent: string): string | null {
  const stack = stacks.get(key);
  if (!stack || stack.length === 0) return null;
  /**
   * 跳过与当前内容相同的帧：这类帧与编辑器原生栈的粒度重叠，
   * 直接返回会让用户觉得"按了一下没反应"。
   */
  let snap = stack.pop()!;
  while (snap.content === currentContent && stack.length > 0) snap = stack.pop()!;
  if (snap.content === currentContent) {
    stack.push(snap); // 没找到可用帧，放回去
    return null;
  }
  // 当前内容进入重做栈（redo 用）
  pushRedo(key, currentContent);
  committed.set(key, snap.content);
  lastPushAt.set(key, Date.now());
  return snap.content;
}

/**
 * 重做：返回"更晚"的那个状态。返回 null 表示没有可重做内容。
 */
export function redoDocHistory(key: string, currentContent: string): string | null {
  const stack = redos.get(key);
  if (!stack || stack.length === 0) return null;
  let snap = stack.pop()!;
  while (snap.content === currentContent && stack.length > 0) snap = stack.pop()!;
  if (snap.content === currentContent) {
    stack.push(snap);
    return null;
  }
  // 当前内容回到撤销栈，保证可以再撤销（keepRedo：不要清空重做链）
  pushFrame(key, currentContent, true);
  committed.set(key, snap.content);
  lastPushAt.set(key, Date.now());
  return snap.content;
}

/** 当前可撤销的帧数（调试/测试用） */
export function docHistoryDepth(key: string): number {
  return stacks.get(key)?.length ?? 0;
}

/** 清空某份文档的历史（例如文件被删除/关闭） */
export function clearDocHistory(key: string): void {
  stacks.delete(key);
  redos.delete(key);
  committed.delete(key);
  lastPushAt.delete(key);
}

function pushFrame(key: string, content: string, keepRedo = false): void {
  const stack = stacks.get(key) ?? [];
  stack.push({ content, at: Date.now() });
  while (stack.length > MAX_PER_KEY) stack.shift();
  stacks.set(key, stack);
  /**
   * 产生**新编辑**时重做链失效；但"重做"本身把内容放回撤销栈时必须保留重做链
   * （否则刚重做一步，后续的重做项就被自己清空了 —— 单测抓到过这个 bug）。
   */
  if (!keepRedo) redos.delete(key);
}

function pushRedo(key: string, content: string): void {
  const stack = redos.get(key) ?? [];
  stack.push({ content, at: Date.now() });
  while (stack.length > MAX_PER_KEY) stack.shift();
  redos.set(key, stack);
}
