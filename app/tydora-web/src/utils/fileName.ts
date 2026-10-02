/**
 * 文件名展示 / 重命名的共用规则。
 *
 * 文件树标签和顶部标题栏都只显示基名（Markdown 隐藏扩展名），两处必须用同一套规则，
 * 否则「树上叫 `笔记`、标题上叫 `笔记.md`」这种不一致会立刻被发现；重命名提交时
 * 也要用同一套规则把扩展名接回去。
 */

/** 判断文件名是否为 Markdown（与编辑器分屏区一致，仅支持 Markdown 在新面板打开） */
export function isMarkdownFileName(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return ["md", "markdown", "mdx"].includes(ext);
}

/**
 * 展示用的名字：Markdown 文件隐藏扩展名（.md / .markdown / .mdx）。
 *
 * 用于树标签 / 顶部标题，也用作内联重命名输入框的初始值（输入框同样只显示基名，
 * 提交时由 restoreExtension() 把原扩展名接回去）。
 * 右键菜单、删除确认、排序仍用完整文件名 —— 排序是按真实文件名
 * （1.5.md / 1.md）比较的，展示名只影响观感。
 */
export function displayFileName(name: string, isDirectory: boolean): string {
  if (isDirectory || !isMarkdownFileName(name)) return name;
  return name.replace(/\.(md|markdown|mdx)$/i, "");
}

/**
 * 内联重命名提交时用：把输入框里被隐藏的扩展名接回去。
 *
 * 输入框里显示的是基名（见 displayFileName），用户在框里看到的是 `笔记`，
 * 提交时必须还原成 `笔记.md` —— 否则一次失焦就把 .md 改没了。
 *
 * 两种情况不追加：
 *   1) 目录 / 非 Markdown 文件：displayFileName 本就没隐藏后缀，用户输入的就是全名；
 *   2) 用户自己把后缀打回来了（也包括改成 .markdown / .mdx）：以用户输入为准。
 */
export function restoreExtension(input: string, originalName: string, isDirectory: boolean): string {
  const name = input.trim();
  if (!name || isDirectory || !isMarkdownFileName(originalName)) return name;
  if (/\.(md|markdown|mdx)$/i.test(name)) return name;
  const ext = originalName.match(/\.(md|markdown|mdx)$/i)?.[0] ?? "";
  if (!ext) return name;
  // Windows 会静默吃掉结尾的点，先去掉再拼，免得 `foo.` 变成 `foo..md`
  const base = name.replace(/\.+$/, "");
  return base ? `${base}${ext}` : name;
}

/** 取出路径里的文件名（最后一段），取不到时返回空串。 */
export function baseNameOf(path: string | null | undefined): string {
  if (!path) return "";
  return path.split(/[/\\]/).pop() || "";
}

/** 取出路径的父目录（保留原分隔符风格），取不到时返回空串。 */
export function parentDirOf(path: string): string {
  return path.replace(/[/\\][^/\\]*$/, "");
}

/**
 * 目录 + 子项 拼路径，分隔符与 dirPath 保持一致。
 *
 * 别直接写 `${dir}/${name}`：Windows 上仓库路径来自系统对话框（`D:\vault`），
 * 拼完就成了 `D:\vault\新名.md` vs `D:\vault/新名.md` 里的后者。文件系统都接受，
 * 但路径**字符串**与文件树（用系统分隔符拼）不一致 —— 打开文件时「已打开则复用缓冲」
 * 是按字符串比较的，落空就会被当成另一个文件重新加载，光标与滚动位置全被重置。
 * 文件树的 joinPath / pathSep 是同一个道理。
 */
export function joinDirLike(dirPath: string, childPath: string): string {
  const sep = dirPath.includes("\\") ? "\\" : "/";
  // 两段都统一到 sep：来源本身可能是混用的（历史遗留 / 手写的路径），
  // 顺手把它规范化，避免脏拼写一直传下去。
  const norm = (s: string) => (sep === "\\" ? s.replace(/\//g, "\\") : s.replace(/\\/g, "/"));
  const base = norm(dirPath).replace(/[/\\]+$/, ""); // 去掉尾部分隔符，避免拼出 `D:\vault\\x.md`
  const child = norm(childPath);
  return base ? `${base}${sep}${child}` : `${sep}${child}`;
}

/**
 * 给一个**文件路径**换同目录下的新文件名（重命名用）。
 * 与 joinDirLike 分开：那个是「目录 + 子项」，输入是目录，不能拿文件路径去喂它，
 * 否则末段会被当成文件名剁掉（`D:\vault` → `D:`）。
 */
export function replaceBaseNameLike(filePath: string, newBaseName: string): string {
  return joinDirLike(parentDirOf(filePath), newBaseName);
}

/**
 * 路径比较用的归一化键：统一成 `/` 分隔、去掉尾部斜杠。
 * 刻意不做大小写转换 —— 大小写不敏感只对 Windows 成立，改小了会在 macOS / Linux 上误判。
 */
export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}
