/**
 * 回收站：删除文件 / 文件夹时先移进来，而不是永久删除。
 *
 * 约定（设置界面里的说明与此一致）：
 * - **所有仓库共用一个回收站**：默认在应用数据目录下的 `recycle-bin`，可在设置里改位置；
 * - 每个条目单独一个目录：`<回收站>/items/<id>/<原文件名>`，元数据记在 `<回收站>/index.json`
 *   （原路径 / 所属仓库 / 删除时间 / 大小）。这样既能精确还原，也能直接用文件管理器翻看；
 * - 配额：只保留**最近的**条目、总量不超过 {@link TRASH_MAX_BYTES}，超出按最旧优先淘汰；
 *   单个条目超过配额时调用方会走「永久删除」分支并要求用户二次确认（见 Sidebar）；
 * - 恢复：当成「新建文件」——回到原目录（目录没了就放仓库根），**重名时在文件名后加数字**，
 *   绝不覆盖已有文件。
 *
 * 注意：这里刻意不用 `fs.stat`（能力里没有 `fs:allow-stat`），体量统计走 Rust 命令
 * `path_usage`（递归累加，超过上限提前返回）；也不用 `fs.copyFile`（同样未授权），
 * 跨盘回退用 readFile + writeFile。
 */
import { exists, mkdir, readDir, readFile, readTextFile, remove, rename, writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { appDataDir } from "@tauri-apps/api/path";
import { invoke } from "@tauri-apps/api/core";
import { baseNameOf, joinDirLike, parentDirOf } from "../utils/fileName";

/** 回收站总量预算的**默认值**：10MB（可在设置里调整，见 getTrashMaxBytes） */
export const TRASH_MAX_BYTES_DEFAULT = 10 * 1024 * 1024;
/** 兼容旧引用：默认预算 */
export const TRASH_MAX_BYTES = TRASH_MAX_BYTES_DEFAULT;

/** 容量下限/上限（设置里可调）：1MB ~ 10GB */
const TRASH_MAX_BYTES_MIN = 1 * 1024 * 1024;
const TRASH_MAX_BYTES_MAX = 10 * 1024 * 1024 * 1024;

/** 回收站位置（用户配置；空 = 用默认位置） */
const TRASH_DIR_KEY = "zmd-trash-dir";
/** 回收站容量（用户配置，字节；空 = 用默认值） */
const TRASH_MAX_BYTES_KEY = "zmd-trash-max-bytes";
const INDEX_FILE = "index.json";
const ITEMS_DIR = "items";

/** 读取用户配置的回收站容量（字节）；没配置或非法时返回默认值 */
export function getTrashMaxBytes(): number {
  try {
    const raw = localStorage.getItem(TRASH_MAX_BYTES_KEY);
    const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) return TRASH_MAX_BYTES_DEFAULT;
    return Math.min(Math.max(parsed, TRASH_MAX_BYTES_MIN), TRASH_MAX_BYTES_MAX);
  } catch {
    return TRASH_MAX_BYTES_DEFAULT;
  }
}

/** 写入回收站容量（字节）；非法值忽略 */
export function setTrashMaxBytes(bytes: number): void {
  try {
    if (!Number.isFinite(bytes) || bytes <= 0) localStorage.removeItem(TRASH_MAX_BYTES_KEY);
    else {
      const clamped = Math.min(Math.max(Math.round(bytes), TRASH_MAX_BYTES_MIN), TRASH_MAX_BYTES_MAX);
      localStorage.setItem(TRASH_MAX_BYTES_KEY, String(clamped));
    }
  } catch {
    /* localStorage 不可用：本次会话继续用默认值 */
  }
}

export interface TrashEntry {
  id: string;
  /** 原文件名（含扩展名） */
  name: string;
  /** 原绝对路径，恢复时优先回到这里 */
  originalPath: string;
  /** 所属仓库根目录，原目录已不存在时的兜底 */
  vaultPath: string;
  isDirectory: boolean;
  deletedAt: number;
  /** 删除时统计的字节数，用于配额淘汰 */
  size: number;
}

export interface TrashMoveFailure {
  path: string;
  error: string;
}

/** 读取用户配置的回收站位置（未配置返回 null，设置界面用） */
export function getConfiguredTrashDir(): string | null {
  try {
    const raw = localStorage.getItem(TRASH_DIR_KEY);
    return raw && raw.trim() ? raw : null;
  } catch {
    return null;
  }
}

/** 写入回收站位置；传 null 恢复默认位置 */
export function setConfiguredTrashDir(dir: string | null): void {
  try {
    if (!dir || !dir.trim()) localStorage.removeItem(TRASH_DIR_KEY);
    else localStorage.setItem(TRASH_DIR_KEY, dir.trim());
  } catch {
    /* localStorage 不可用时忽略：本次会话仍按默认位置工作 */
  }
}

/** 当前生效的回收站目录（配置优先，默认 appDataDir/recycle-bin） */
export async function getTrashDir(): Promise<string> {
  const configured = getConfiguredTrashDir();
  if (configured) return configured;
  const base = await appDataDir();
  return joinDirLike(base, "recycle-bin");
}

/** 条目所在的存储目录 */
function entryDirOf(trashDir: string, id: string): string {
  return joinDirLike(joinDirLike(trashDir, ITEMS_DIR), id);
}

async function readIndex(trashDir: string): Promise<TrashEntry[]> {
  try {
    const raw = await readTextFile(joinDirLike(trashDir, INDEX_FILE));
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is TrashEntry => Boolean(e) && typeof (e as TrashEntry).id === "string");
  } catch {
    // 首次使用 / 索引损坏：当作空回收站，不阻塞删除
    return [];
  }
}

async function writeIndex(trashDir: string, entries: TrashEntry[]): Promise<void> {
  await mkdir(trashDir, { recursive: true });
  await writeTextFile(joinDirLike(trashDir, INDEX_FILE), JSON.stringify(entries, null, 2));
}

/**
 * 递归统计路径占用（Rust `path_usage`）。
 * `cap` 之内的精确值有意义；超过 cap 时只保证返回值 > cap（用于「放不放得下」的判断）。
 *
 * 统计失败时返回 0（乐观：当作放得下，宁可少记配额也不要因为统计失败删掉用户的东西），
 * 但会打日志 —— 若 Rust 命令缺失/未重建，控制台能看到原因。
 */
export async function measureUsage(path: string, cap: number = getTrashMaxBytes()): Promise<number> {
  try {
    return await invoke<number>("path_usage", { path, maxBytes: cap });
  } catch (err) {
    console.warn("[recycle-bin] path_usage 调用失败，本次按 0 计（不影响删除，但配额可能偏松）:", path, err);
    return 0;
  }
}

/** 批量统计总量，超过 cap 就提前收敛 */
export async function measureTotalUsage(paths: string[], cap: number = getTrashMaxBytes()): Promise<number> {
  let total = 0;
  for (const p of paths) {
    total += await measureUsage(p, cap);
    if (total > cap) return total;
  }
  return total;
}

/** 递归复制（跨盘移动到回收站时的回退路径）：文件用 readFile + writeFile */
async function copyRecursive(src: string, dst: string, isDirectory: boolean): Promise<void> {
  if (!isDirectory) {
    const bytes = await readFile(src);
    await writeFile(dst, bytes);
    return;
  }
  await mkdir(dst, { recursive: true });
  for (const entry of await readDir(src)) {
    const from = joinDirLike(src, entry.name);
    const to = joinDirLike(dst, entry.name);
    if (entry.isDirectory) await copyRecursive(from, to, true);
    else if (entry.isFile) await copyRecursive(from, to, false);
  }
}

/** 移动（同名盘内 rename；跨盘则复制后删除） */
async function movePath(src: string, dst: string, isDirectory: boolean): Promise<void> {
  try {
    await rename(src, dst);
    return;
  } catch {
    /* 跨盘 / rename 不可用：走复制 + 删除 */
  }
  await copyRecursive(src, dst, isDirectory);
  await remove(src, { recursive: true });
}

/** 删除后维持「最近的条目、总量 ≤ 配额」，多出来的按最旧优先淘汰 */
async function enforceQuota(trashDir: string): Promise<number> {
  const maxBytes = getTrashMaxBytes();
  const entries = await readIndex(trashDir);
  const newestFirst = [...entries].sort((a, b) => b.deletedAt - a.deletedAt);
  const kept: TrashEntry[] = [];
  let total = 0;
  const evicted: TrashEntry[] = [];
  for (const entry of newestFirst) {
    if (total + entry.size <= maxBytes) {
      kept.push(entry);
      total += entry.size;
    } else {
      evicted.push(entry);
    }
  }
  if (evicted.length === 0) return 0;
  for (const entry of evicted) {
    try {
      await remove(entryDirOf(trashDir, entry.id), { recursive: true });
    } catch {
      /* 已经不在就算了 */
    }
  }
  await writeIndex(trashDir, kept);
  return evicted.length;
}

/**
 * 按当前容量设置重新淘汰一遍（设置里调小容量后调用），返回被清理的条目数。
 */
export async function applyTrashQuota(): Promise<number> {
  const trashDir = await getTrashDir();
  return enforceQuota(trashDir);
}

export interface TrashMoveResult {
  moved: TrashEntry[];
  failed: TrashMoveFailure[];
  /** 因超配额被淘汰掉的旧条目数 */
  evicted: number;
}

/**
 * 判断路径是不是目录：能 readDir 成功就是目录。
 * 不用 fs.stat（能力里没有 `fs:allow-stat`），readDir 已在授权范围内。
 */
async function isDirectoryPath(path: string): Promise<boolean> {
  try {
    await readDir(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把若干路径移入回收站。
 *
 * 调用方需自行保证这些路径都放得下（提前用 {@link measureTotalUsage} 判断）；
 * 这里不再二次确认，失败项原样回报，让 UI 决定怎么提示。
 * `isDirectory` 可省略，省略时自动探测（多选删除时 UI 只知道被点那个节点的类型）。
 */
export async function moveToTrash(
  items: { path: string; isDirectory?: boolean }[],
  vaultPath: string,
): Promise<TrashMoveResult> {
  const trashDir = await getTrashDir();
  await mkdir(joinDirLike(trashDir, ITEMS_DIR), { recursive: true });
  const existing = await readIndex(trashDir);
  const moved: TrashEntry[] = [];
  const failed: TrashMoveFailure[] = [];

  for (const item of items) {
    const name = baseNameOf(item.path);
    if (!name) {
      failed.push({ path: item.path, error: "路径无效" });
      continue;
    }
    const isDirectory = item.isDirectory ?? (await isDirectoryPath(item.path));
    const size = await measureUsage(item.path);
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const dir = entryDirOf(trashDir, id);
      await mkdir(dir, { recursive: true });
      await movePath(item.path, joinDirLike(dir, name), isDirectory);
      moved.push({
        id,
        name,
        originalPath: item.path,
        vaultPath,
        isDirectory,
        deletedAt: Date.now(),
        size,
      });
    } catch (err) {
      failed.push({ path: item.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (moved.length > 0) {
    await writeIndex(trashDir, [...moved, ...existing]);
  }
  const evicted = moved.length > 0 ? await enforceQuota(trashDir) : 0;
  return { moved, failed, evicted };
}

/** 列出回收站条目（最近的在前） */
export async function listTrashEntries(): Promise<TrashEntry[]> {
  const trashDir = await getTrashDir();
  const entries = await readIndex(trashDir);
  return entries.sort((a, b) => b.deletedAt - a.deletedAt);
}

/** `name.md` → { base: "name", ext: ".md" }；没有扩展名时 ext 为空 */
function splitName(name: string): { base: string; ext: string } {
  const m = name.match(/\.[^./\\]+$/);
  if (!m) return { base: name, ext: "" };
  return { base: name.slice(0, -m[0].length), ext: m[0] };
}

async function uniqueFilePath(dirPath: string, baseName: string, ext: string): Promise<string> {
  const first = joinDirLike(dirPath, `${baseName}${ext}`);
  if (!(await exists(first))) return first;
  for (let i = 1; ; i++) {
    const candidate = joinDirLike(dirPath, `${baseName} ${i}${ext}`);
    if (!(await exists(candidate))) return candidate;
  }
}

async function uniqueDirPath(dirPath: string, dirName: string): Promise<string> {
  const first = joinDirLike(dirPath, dirName);
  if (!(await exists(first))) return first;
  for (let i = 1; ; i++) {
    const candidate = joinDirLike(dirPath, `${dirName} ${i}`);
    if (!(await exists(candidate))) return candidate;
  }
}

/**
 * 恢复一个条目：当成「新建文件」放回去。
 * 目标目录优先用原目录，原目录不存在则退回所属仓库根；重名一律加数字，不覆盖。
 * @returns 恢复后的绝对路径
 */
export async function restoreTrashEntry(id: string): Promise<string> {
  const trashDir = await getTrashDir();
  const entries = await readIndex(trashDir);
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error("回收站里找不到这条记录");

  const stored = joinDirLike(entryDirOf(trashDir, entry.id), entry.name);
  if (!(await exists(stored))) throw new Error("回收站里的文件已丢失");

  const originalDir = parentDirOf(entry.originalPath);
  let targetDir = originalDir;
  if (!targetDir || !(await exists(targetDir))) {
    targetDir = entry.vaultPath && (await exists(entry.vaultPath)) ? entry.vaultPath : originalDir;
  }
  if (!targetDir || !(await exists(targetDir))) {
    throw new Error("原目录与仓库目录都不存在了，无法恢复");
  }

  const target = entry.isDirectory
    ? await uniqueDirPath(targetDir, entry.name)
    : await uniqueFilePath(targetDir, splitName(entry.name).base, splitName(entry.name).ext);

  await movePath(stored, target, entry.isDirectory);
  try {
    await remove(entryDirOf(trashDir, entry.id), { recursive: true });
  } catch {
    /* 空壳清不掉不影响恢复结果 */
  }
  await writeIndex(trashDir, entries.filter((e) => e.id !== id));
  return target;
}

/** 彻底删除一个条目（不进仓库，只从回收站移除） */
export async function deleteTrashEntry(id: string): Promise<void> {
  const trashDir = await getTrashDir();
  const entries = await readIndex(trashDir);
  try {
    await remove(entryDirOf(trashDir, id), { recursive: true });
  } catch {
    /* 已经不在就算了 */
  }
  await writeIndex(trashDir, entries.filter((e) => e.id !== id));
}

/** 清空回收站 */
export async function emptyTrash(): Promise<void> {
  const trashDir = await getTrashDir();
  try {
    await remove(joinDirLike(trashDir, ITEMS_DIR), { recursive: true });
  } catch {
    /* 目录本来就不存在 */
  }
  await writeIndex(trashDir, []);
}
