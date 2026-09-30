/**
 * 每个文件「上次离开时」的视图位置（光标 + 视口），用于重新打开文件、
 * 或重启软件 / 刷新页面后回到原处。
 *
 * 为什么不和 App 的会话（`zmd-session`，记录上次打开了哪个文件）放同一个键：
 * 位置由编辑器组件自己持续读写，会话由 App 读写 —— 同一个键两边写会互相覆盖。
 *
 * 写盘做了节流：滚动事件很密，逐次写 localStorage 会拖慢编辑器；
 * 另外在 pagehide / visibilitychange 时补一次同步落盘，保证按 F5 刷新也不丢。
 */

export interface FileViewPosition {
  /** 记录时所在的模式：ir = ProseMirror 位置，sv = Markdown 源码偏移 */
  mode: "ir" | "sv";
  /** 光标位置（ir: ProseMirror 位置；sv: 源码偏移） */
  cursor: number;
  /** 光标在视口内的相对高度（0~1）；-1 表示不可用，只能按 scrollRatio 恢复 */
  ratio: number;
  /** 视口滚动比例（0~1） */
  scrollRatio: number;
}

const STORAGE_KEY = "zmd-file-positions";
/** 最多保留多少个文件的位置：够用即可，避免 localStorage 无限膨胀 */
const MAX_ENTRIES = 200;
/** 写盘节流间隔：滚动过程中不逐次写 */
const FLUSH_DELAY = 800;

type PositionMap = Record<string, FileViewPosition>;

let pending: PositionMap | null = null;
let flushTimer: number | null = null;

function readAll(): PositionMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as PositionMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function flush() {
  if (flushTimer != null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!pending) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
  } catch {
    /* 配额满等异常：位置丢了不影响正常使用，静默即可 */
  }
  pending = null;
}

/** 记下某个文件的视图位置（内部节流，可放心在 scroll / 选区变更里调用） */
export function saveFileViewPosition(filePath: string | null | undefined, pos: FileViewPosition) {
  if (!filePath) return;
  const all = pending ?? readAll();
  all[filePath] = pos;
  const keys = Object.keys(all);
  if (keys.length > MAX_ENTRIES) {
    // 超出上限时丢掉最早写入的（对象键顺序即写入顺序）
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete all[k];
  }
  pending = all;
  if (flushTimer == null) flushTimer = window.setTimeout(flush, FLUSH_DELAY);
}

/** 读取某个文件上次的视图位置 */
export function loadFileViewPosition(filePath: string | null | undefined): FileViewPosition | null {
  if (!filePath) return null;
  const all = pending ?? readAll();
  const hit = all[filePath];
  return hit && typeof hit.cursor === "number" ? hit : null;
}

/** 刷新 / 关闭页面前把节流中的位置落盘 */
export function flushFileViewPositions() {
  flush();
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
