import { useEffect } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Word 式光标（IR 模式）。
 *
 * 原生光标由系统绘制，只能硬切换，无法做淡入淡出 —— 所以这里把原生光标改成透明
 * （caret-color: transparent，注意是"透明"而不是"移除"：几何位置还在，输入法据此
 * 定位候选框），再自绘一根 2px 竖条：
 *
 * - **淡入淡出**：透明度走关键帧动画（渐隐 → 停 → 渐显），不是硬切换；
 * - **平滑滑动**：left/top 带 ~70ms 过渡，点击、方向键跳位时看得出滑动，
 *   打字时几乎察觉不到（字符本身仍是即时上屏，不做输入延迟）；
 * - **打字时常亮**：每次光标移动都重启一次动画，于是连续输入时它保持满亮，
 *   停下来才重新开始闪烁 —— 与 Word 的手感一致。
 *
 * 位置策略（重要）：光标元素挂在**滚动容器 `.tiptap-editor` 内部**，坐标用"内容坐标"
 * （视口坐标 + 当前 scrollTop/scrollLeft）。这样滚动时它跟着内容一起被合成器移动，
 * 不需要监听 scroll、也不会落后一帧 —— 挂在外面那个不滚动的容器上时，滚动是合成器
 * 线程做的、而位置要等 JS 重算，视觉上就会"光标和正文不同步"。
 * 因此这里只在选区变化时重算，滚动不触发任何 JS。
 */
export function useSmoothCaret(
  editor: Editor | null,
  hostRef: { current: HTMLElement | null },
  enabled: boolean,
): void {
  useEffect(() => {
    if (!editor || !enabled) return;
    const host = hostRef.current;
    if (!host) return;
    // 滚动容器：EditorContent 渲染出来的 .tiptap-editor（应用自己控制的 div，不是 ProseMirror 的 DOM）
    const scroller = (host.querySelector(".tiptap-editor") as HTMLElement | null) ?? host;

    const caret = document.createElement("div");
    caret.className = "tydora-caret";
    caret.setAttribute("aria-hidden", "true");

    let raf = 0;
    const update = () => {
      raf = 0;
      // 自愈：万一被 React 重渲染顺手清掉，补回去
      if (caret.parentElement !== scroller) scroller.appendChild(caret);
      const view = editor.view;
      const sel = view.state.selection;
      // 失焦、选区非空（此时显示的是原生高亮）、只读：不画光标。
      // 注意必须同时看 **document.hasFocus()**：OS 焦点切到别的程序（例如浏览器）时，
      // WebView 里的元素常常收不到 blur，view.hasFocus() 仍是 true，
      // 只判它的话自绘光标会继续闪（原生光标由系统按窗口活动状态隐藏，所以以前没这问题）。
      if (!document.hasFocus() || !view.hasFocus() || !sel.empty || !editor.isEditable) {
        caret.style.display = "none";
        return;
      }
      let coords: { left: number; top: number; bottom: number } | null = null;
      try {
        const c = view.coordsAtPos(sel.head);
        coords = { left: c.left, top: c.top, bottom: c.bottom };
      } catch {
        coords = null;
      }
      if (!coords) {
        caret.style.display = "none";
        return;
      }
      const rect = scroller.getBoundingClientRect();
      // 视口坐标 → 滚动内容坐标：滚动时 coords 与 rect 同步变化，相加后恒定不变
      const left = coords.left - rect.left + scroller.scrollLeft;
      const top = coords.top - rect.top + scroller.scrollTop;
      // 光标滚出可视区就藏起来（滚动容器自身也会裁剪，这里提前藏更省事）
      const viewportTop = coords.top - rect.top;
      const outside =
        coords.left - rect.left < -4 ||
        coords.left - rect.left > rect.width + 4 ||
        viewportTop < -4 ||
        viewportTop > rect.height + 4;
      if (outside) {
        caret.style.display = "none";
        return;
      }
      caret.style.display = "block";
      caret.style.left = `${left}px`;
      caret.style.top = `${top}px`;
      // 高度取「行盒」：coordsAtPos 在行首/行尾返回的是文字盒，比行盒矮一截
      // （行高 1.6 时看着只有半根），所以拿该位置所属元素的 line-height 作下限。
      let boxHeight = coords.bottom - coords.top;
      try {
        const at = view.domAtPos(sel.head);
        const node = at.node;
        const el = (node.nodeType === 3 ? node.parentElement : (node as HTMLElement)) as HTMLElement | null;
        if (el) {
          const lh = Number.parseFloat(getComputedStyle(el).lineHeight);
          if (Number.isFinite(lh) && lh > boxHeight) boxHeight = lh;
        }
      } catch {
        /* 取不到就用 coords 的高度 */
      }
      caret.style.height = `${Math.max(8, boxHeight)}px`;
      // 重启闪烁动画：连续打字 → 每次重启都回到"满亮"，光标看起来常亮；
      // 停下来不再重启，才会慢慢淡出淡入。
      caret.style.animation = "none";
      void caret.offsetWidth;
      caret.style.animation = "";
    };
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    editor.on("selectionUpdate", schedule);
    editor.on("transaction", schedule);
    editor.on("focus", schedule);
    editor.on("blur", schedule);
    // 只监听"尺寸变化"，不监听 scroll —— 滚动由内容坐标天然跟随
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(scroller);
    window.addEventListener("resize", schedule);
    // 窗口焦点变化（切到别的程序 / 切回来）与可见性变化，都要立刻重算，
    // 否则光标会在窗口失去焦点后继续闪、或切回来时不出现。
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("visibilitychange", schedule);
    schedule();

    return () => {
      if (raf) cancelAnimationFrame(raf);
      editor.off("selectionUpdate", schedule);
      editor.off("transaction", schedule);
      editor.off("focus", schedule);
      editor.off("blur", schedule);
      resizeObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
      caret.remove();
    };
  }, [editor, hostRef, enabled]);
}
