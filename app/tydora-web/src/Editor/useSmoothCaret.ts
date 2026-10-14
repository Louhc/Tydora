import { useEffect } from "react";
import type { Editor } from "@tiptap/react";

/**
 * Word 式光标（IR 模式）。
 *
 * 原生光标由系统绘制，只能硬切换，无法做淡入淡出 —— 所以这里把原生光标改成透明
 * （caret-color: transparent，注意是"透明"而不是"移除"：几何位置还在，输入法据此
 * 定位候选框），再自绘一根 2px 竖条。
 *
 * ## 性能约定（重要，改这里前先读）
 * 打字时每个字符都会触发一次重算，所以热路径必须做到"只读一次、只写一次、不强制布局"：
 *
 * 1. **位移用 `transform: translate3d()`**，不用 `left/top`：前者走合成器，后者每帧都要重排。
 * 2. **不重启关键帧动画**：连续打字靠切换 `.is-typing` 类保持常亮。类名重复添加不会造成
 *    样式失效，所以输入期间零开销；停手后移除类，动画自然从头开始（满亮 → 闪烁）。
 *    早期实现每次按键都做 `animation = "none"; void offsetWidth; animation = ""`，
 *    每次都要强制 reflow + 重建动画，是"输入一快就卡"的主因。
 * 3. **行高按元素缓存**（WeakMap）：`getComputedStyle` 会强制样式重算，不能每帧调用。
 * 4. 显示/隐藏用 `visibility`（不触发布局），不用 `display`。
 * 5. 先读完所有几何量（coordsAtPos / getBoundingClientRect），再统一写样式，避免读写交错。
 *
 * ## 位置策略
 * 光标元素挂在**滚动容器 `.tiptap-editor` 内部**，坐标用"内容坐标"
 * （视口坐标 + 当前 scrollTop/scrollLeft）。这样滚动时它跟着内容一起被合成器移动，
 * 不需要监听 scroll、也不会落后一帧。因此这里只在选区变化时重算，滚动不触发任何 JS。
 */

/** 打字后保持常亮的时长：超过它才恢复闪烁 */
const TYPING_HOLD_MS = 600;

/** 行高缓存：同一元素只算一次（getComputedStyle 很贵） */
const lineHeightCache = new WeakMap<HTMLElement, number>();

function lineHeightOf(el: HTMLElement, fallback: number): number {
  const cached = lineHeightCache.get(el);
  if (cached !== undefined) return cached;
  let lh = fallback;
  try {
    const parsed = Number.parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(parsed) && parsed > 0) lh = parsed;
  } catch {
    /* 取不到就用 fallback */
  }
  lineHeightCache.set(el, lh);
  return lh;
}

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
    let typingTimer = 0;
    /** 隐藏状态缓存：避免每帧重复写 visibility / 触发样式失效 */
    let hidden = true;

    const setHidden = (next: boolean) => {
      if (hidden === next) return;
      hidden = next;
      caret.style.visibility = next ? "hidden" : "visible";
    };

    const markTyping = () => {
      // 重复 add 同一类名不会产生样式失效 → 连续输入期间零开销
      caret.classList.add("is-typing");
      if (typingTimer) window.clearTimeout(typingTimer);
      typingTimer = window.setTimeout(() => {
        typingTimer = 0;
        caret.classList.remove("is-typing");
      }, TYPING_HOLD_MS);
    };

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
        setHidden(true);
        return;
      }

      // ── 只读阶段：把所有几何量一次取完，再进入写入阶段 ──
      let coords: { left: number; top: number; bottom: number } | null = null;
      try {
        const c = view.coordsAtPos(sel.head);
        coords = { left: c.left, top: c.top, bottom: c.bottom };
      } catch {
        coords = null;
      }
      if (!coords) {
        setHidden(true);
        return;
      }
      const rect = scroller.getBoundingClientRect();
      const viewportTop = coords.top - rect.top;
      const viewportLeft = coords.left - rect.left;
      // 光标滚出可视区就藏起来（滚动容器自身也会裁剪，这里提前藏更省事）
      if (
        viewportLeft < -4 ||
        viewportLeft > rect.width + 4 ||
        viewportTop < -4 ||
        viewportTop > rect.height + 4
      ) {
        setHidden(true);
        return;
      }

      // 视口坐标 → 滚动内容坐标：滚动时 coords 与 rect 同步变化，相加后恒定不变
      const left = viewportLeft + scroller.scrollLeft;
      const top = viewportTop + scroller.scrollTop;

      // 高度取「行盒」：coordsAtPos 在行首/行尾返回的是文字盒，比行盒矮一截
      // （行高 1.6 时看着只有半根），所以拿该位置所属元素的 line-height 作下限。
      let boxHeight = coords.bottom - coords.top;
      try {
        const at = view.domAtPos(sel.head);
        const node = at.node;
        const el = (node.nodeType === 3 ? node.parentElement : (node as HTMLElement)) as HTMLElement | null;
        if (el) boxHeight = Math.max(boxHeight, lineHeightOf(el, boxHeight));
      } catch {
        /* 取不到就用 coords 的高度 */
      }

      // ── 写入阶段：只写不读（不要在这里读 offsetWidth 等，否则又变成强制布局）──
      setHidden(false);
      caret.style.transform = `translate3d(${left}px, ${top}px, 0)`;
      caret.style.height = `${Math.max(8, boxHeight)}px`;
      markTyping();
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
      if (typingTimer) window.clearTimeout(typingTimer);
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
