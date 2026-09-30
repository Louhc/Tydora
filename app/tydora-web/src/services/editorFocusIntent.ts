/**
 * 「打开这个文件时别把焦点交给编辑器」的定向意图。
 *
 * 背景：侧栏新建文件后会立刻打开它（让界面切到新文件），但紧接着要用户留在
 * 内联输入框里改文件名。而 App 的 openFile 会在文件读完后 `setTimeout(…, 60)`
 * 把焦点交给编辑器窗格 —— 正好把刚拿到的输入框焦点抢走，用户敲的字就落进正文了。
 *
 * 按**路径**绑定而不是用一个一次性布尔：上一个文件有未保存修改时，打开会被
 * 保存确认框推迟（走 setPendingFilePath → openFile(pendingFilePath)），
 * 用布尔的话可能被之后某次无关的打开消费掉，把编辑器的焦点也一起吞了。
 *
 * 放模块级而不是 props：这条链路要从 TreeNode / FileTree 一路穿到 App，
 * 而语义只有一句「打开这个文件时别抢焦点」。
 */

let pendingPath: string | null = null;

/** 标记「接下来打开这个文件时不要抢焦点」。 */
export function suppressEditorFocusForPath(path: string): void {
  pendingPath = path;
}

/** 取走并清除该意图；由 openFile 在起始处按实际打开路径消费。 */
export function consumeEditorFocusSuppression(path: string): boolean {
  if (!pendingPath || pendingPath !== path) return false;
  pendingPath = null;
  return true;
}
