/**
 * 记录「最近一次内容变化**之前**的光标位置」。
 *
 * 用途：App 的文档级撤销是**整篇快照替换**（utils/doc-history.ts），快照帧只存内容，
 * 撤销后光标就丢了。之前的做法是「按内容字符串反查当时的光标」，实测会被两类情况坑：
 *   - 内容在缓冲区与编辑器序列化之间差 1 个字符 → 查不到 ✗；
 *   - 「旧内容 × 新光标」的错误配对 → 查到的是过期值 ✗。
 *
 * 改成结构性做法：快照帧**自带**光标（App 在立帧时向这里取"这次变化之前的光标"），
 * 撤销哪一帧就还原那一帧自带的光标 —— 不做任何内容匹配 ✓。
 *
 * 之所以记「变化**之前**」：立帧压入的是**变更前的内容**，与"变化之前的光标"正好配对 ✓。
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

export interface CaretPos {
  from: number;
  to: number;
}

/** 插件状态：最近一次 docChanged 事务**之前**的选区（无则 null）。 */
export const caretBeforeChangeKey = new PluginKey<CaretPos | null>("tydoraCaretBeforeChange");

export const CaretHistory = Extension.create({
  name: "caretHistory",
  addProseMirrorPlugins() {
    return [
      new Plugin<CaretPos | null>({
        key: caretBeforeChangeKey,
        state: {
          init: () => null,
          apply: (tr, prev, oldState) => {
            // 只在内容真的变化时更新：这样连打几个字后，取到的仍是"开始打字前"的位置 ✓
            if (!tr.docChanged) return prev;
            return { from: oldState.selection.from, to: oldState.selection.to };
          },
        },
      }),
    ];
  },
});
