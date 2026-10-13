import { normalizePathKey } from "./fileName";

/**
 * 星标（标星）文件 / 文件夹 —— 轻量的"就地标记"，与收藏（Bookmarks）互补：
 *   - 星标：只在文件树里把该项**强调**出来，不进收藏面板、不分组；
 *   - 收藏：带分组的独立清单（`Bookmarks/`），走自己的服务与面板。
 *
 * 实现要点：
 *   - 只标它自己（标一个文件夹不会连带子项）；
 *   - 持久化在 localStorage 的 `zmd-starred-paths`（与项目其它键同一命名风格），
 *     存 `normalizePathKey` 规范化后的路径，与树里比较路径的方式一致；
 *   - 变更时派发 `starred-changed` 事件（与 `file-renamed` 的做法一致），
 *     多侧栏 / 多窗口可据此刷新；
 *   - 内存缓存解析结果：树的每个节点渲染都要问"我是不是星标"，
 *     每次 JSON.parse 一遍 localStorage 在几百文件时开销可观。
 */

const STARRED_KEY = "zmd-starred-paths";
const STARRED_EVENT = "starred-changed";

let cache: Set<string> | null = null;

function readRaw(): string[] {
  try {
    const raw = localStorage.getItem(STARRED_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** 读取全部星标路径（已规范化，带内存缓存） */
export function loadStarred(): Set<string> {
  if (cache) return cache;
  cache = new Set(readRaw().map(normalizePathKey));
  return cache;
}

/** 某个路径是否已标星 */
export function isStarred(path: string): boolean {
  return loadStarred().has(normalizePathKey(path));
}

function write(paths: Set<string>): void {
  cache = paths;
  try {
    localStorage.setItem(STARRED_KEY, JSON.stringify([...paths]));
  } catch {
    /* localStorage 不可用（隐私模式 / 配额）时静默失败，本次会话内 UI 仍按内存状态显示 */
  }
  window.dispatchEvent(new CustomEvent(STARRED_EVENT));
}

/** 切换标星状态，返回切换后的状态（true = 现在是星标）。只影响传入的这一个路径。 */
export function toggleStarred(path: string): boolean {
  const key = normalizePathKey(path);
  const set = loadStarred();
  const nowStarred = !set.has(key);
  if (nowStarred) set.add(key);
  else set.delete(key);
  write(set);
  return nowStarred;
}

/** 改名 / 移动后同步星标路径（只处理自身；目录改名想连带后代需在此按前缀批量替换） */
export function remapStarred(oldPath: string, newPath: string): void {
  const oldKey = normalizePathKey(oldPath);
  const set = loadStarred();
  if (!set.delete(oldKey)) return;
  set.add(normalizePathKey(newPath));
  write(set);
}

/** 订阅星标变更，返回取消订阅函数 */
export function subscribeStarred(handler: () => void): () => void {
  window.addEventListener(STARRED_EVENT, handler);
  return () => window.removeEventListener(STARRED_EVENT, handler);
}
