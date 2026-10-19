// src/Editor/extensions/ruby-edit-popover.ts
//
// 注音的就地编辑浮层（方案 B）。
//
// 为什么不做成"节点内部可编辑"（方案 A）：那需要在 NodeView 里放 contenteditable 子区域，
// 必须处理 stopEvent / ignoreMutation / 输入法组字（日语输入！）/ 撤销栈 / Vim 与 SV 模式，
// 每一处都要实测。方案 B 让节点保持 atom（不可进入），单击时在节点旁弹一个两行小浮层，
// 输入即更新节点 attrs —— 不动 ProseMirror 的编辑语义，风险低得多。

import type { Editor } from "@tiptap/core";

interface OpenOptions {
  editor: Editor;
  /** 节点的当前位置（NodeView 的 getPos，可能已失效 → 返回 undefined 时不提交） */
  getPos: () => number | undefined;
  /** 触发浮层的元素：用来定位 */
  anchor: HTMLElement;
}

let activePanel: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

/** 关闭当前浮层（若有） */
export function closeRubyEditor(): void {
  cleanup?.();
}

/**
 * 打开注音编辑浮层：上行注音（rt）、下行本体（base）。
 * Enter 提交、Esc 取消、点击面板外提交。
 */
export function openRubyEditor({ editor, getPos, anchor }: OpenOptions): void {
  closeRubyEditor();

  const node = editor.state.doc.nodeAt(getPos() ?? -1);
  // 本体是节点的**文本内容**（方案 A：ruby 节点自带 content），不再存在 attrs.base ✓
  const base = (node?.textContent ?? "") as string;
  const rt = (node?.attrs.rt ?? "") as string;

  const panel = document.createElement("div");
  panel.className = "ruby-edit-popover";
  panel.innerHTML = `
    <input class="ruby-edit-rt" type="text" />
    <input class="ruby-edit-base" type="text" />
  `;
  const rtInput = panel.querySelector<HTMLInputElement>(".ruby-edit-rt")!;
  const baseInput = panel.querySelector<HTMLInputElement>(".ruby-edit-base")!;
  rtInput.value = rt;
  rtInput.placeholder = "注音";
  baseInput.value = base;
  baseInput.placeholder = "本体";

  document.body.appendChild(panel);
  activePanel = panel;

  // 定位：贴在节点上方；超出视口就翻到下方
  const rect = anchor.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  let left = rect.left;
  let top = rect.top - panelRect.height - 6;
  if (top < 4) top = rect.bottom + 6;
  if (left + panelRect.width > window.innerWidth - 4) left = window.innerWidth - panelRect.width - 4;
  panel.style.left = `${Math.max(4, left)}px`;
  panel.style.top = `${top}px`;

  const commit = () => {
    const pos = getPos();
    if (typeof pos !== "number") {
      closeRubyEditor();
      return;
    }
    const node = editor.state.doc.nodeAt(pos);
    const nextBase = baseInput.value.trim();
    const nextRt = rtInput.value.trim();
    // 两段都非空才提交：否则会变成零宽空注音（ProseMirror 会判为无效内容）
    if (node && nextBase && nextRt) {
      // 本体与读音都在属性里（节点无内容，见 ruby.ts 的 atom 说明）
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { base: nextBase, rt: nextRt }));
    }
    closeRubyEditor();
  };
  const cancel = () => closeRubyEditor();

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };
  const onMouseDownOutside = (e: MouseEvent) => {
    if (!panel.contains(e.target as Node)) commit();
  };

  panel.addEventListener("keydown", onKeyDown);
  // 用 capture + 延迟注册：避免"打开浮层的那次点击"立刻把它关掉
  const timer = window.setTimeout(() => document.addEventListener("mousedown", onMouseDownOutside, true), 0);

  cleanup = () => {
    window.clearTimeout(timer);
    document.removeEventListener("mousedown", onMouseDownOutside, true);
    panel.removeEventListener("keydown", onKeyDown);
    panel.remove();
    if (activePanel === panel) activePanel = null;
    cleanup = null;
  };

  rtInput.focus();
  rtInput.select();
}
