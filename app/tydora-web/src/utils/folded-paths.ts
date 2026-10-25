import { normalizePathKey } from "./fileName";

/**
 * 折叠（收起）文件 / 文件夹 —— 与「星标」互补的另一种就地标记：
 *   - 星标：把该项在树里**强调**出来 ✓
 *   - 折叠：把该项从树里**藏起来** ✓，只在同级留一行 `...` 用于展开 ✓
 *
 * 实现要点（与 `starred-paths.ts` 保持同一套做法）：
 *   - 只标它自己（折一个文件夹不会连带子项 ✓）；
 *   - 持久化在 localStorage 的 `zmd-folded-paths` ✓，存 `normalizePathKey` 规范化后的路径 ✓；
 *   - 支持**批量**：`setFolded(paths, folded)` 一次处理多个 ✓（右键多选时用 ✓）；
 *   - 变更时派发 `folded-changed` 事件 ✓，多侧栏 / 多窗口可据此刷新 ✓；
 *   - 内存缓存：树的每个节点渲染都要问"我是不是折叠的" ✓，
 *     每次 JSON.parse 一遍 localStorage 在几百文件时开销可观 ✓。
 */

const FOLDED_KEY = "zmd-folded-paths";
const FOLDED_EVENT = "folded-changed";

let cache: Set<string> | null = null;

function readRaw(): string[] {
  try {
    const raw = localStorage.getItem(FOLDED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 读取全部折叠路径（已规范化，带内存缓存） */
export function loadFolded(): Set<string> {
  if (cache) return cache;
  cache = new Set(readRaw().map(normalizePathKey));
  return cache;
}

/** 某个路径是否已折叠 */
export function isFolded(path: string): boolean {
  return loadFolded().has(normalizePathKey(path));
}

function write(paths: Set<string>): void {
  cache = paths;
  try {
    localStorage.setItem(FOLDED_KEY, JSON.stringify([...paths]));
  } catch {
    /* localStorage 不可用（隐私模式 / 配额）时静默失败，本次会话内 UI 仍按内存状态显示 */
  }
  window.dispatchEvent(new CustomEvent(FOLDED_EVENT));
}

/**
 * 批量设置折叠状态 ✓。
 *
 * `folded = true` → 把这些路径都标成折叠 ✓；
 * `folded = false` → 全部取消折叠 ✓（用于"取消折叠"与"展开后取消" ✓）。
 */
export function setFolded(paths: string[], folded: boolean): void {
  const set = loadFolded();
  let changed = false;
  for (const p of paths) {
    const key = normalizePathKey(p);
    if (folded) {
      if (!set.has(key)) {
        set.add(key);
        changed = true;
      }
    } else if (set.delete(key)) {
      changed = true;
    }
  }
  if (changed) write(set);
}

/** 切换折叠状态（返回切换后的状态：true = 现在是折叠）。只影响传入的这一个路径。 */
export function toggleFolded(path: string): boolean {
  const nowFolded = !isFolded(path);
  setFolded([path], nowFolded);
  return nowFolded;
}

/**
 * 改名 / 移动后同步折叠路径 ✓。
 *
 * 目录改名要**连带后代** ✓ —— 折叠是按完整路径记录的 ✓，
 * 只改自身会让原本折起来的子项突然全冒出来 ✗。
 */
export function remapFolded(oldPath: string, newPath: string): void {
  const oldKey = normalizePathKey(oldPath);
  const newKey = normalizePathKey(newPath);
  if (oldKey === newKey) return;
  const set = loadFolded();
  const doomed: string[] = [];
  const added: string[] = [];
  for (const p of set) {
    if (p === oldKey) {
      doomed.push(p);
      added.push(newKey);
    } else if (p.startsWith(oldKey + "/") || p.startsWith(oldKey + "\\")) {
      doomed.push(p);
      added.push(newKey + p.slice(oldKey.length));
    }
  }
  if (doomed.length === 0) return;
  for (const p of doomed) set.delete(p);
  for (const p of added) set.add(p);
  write(set);
}

/** 订阅折叠变更，返回取消订阅函数 */
export function subscribeFolded(handler: () => void): () => void {
  window.addEventListener(FOLDED_EVENT, handler);
  return () => window.removeEventListener(FOLDED_EVENT, handler);
}
