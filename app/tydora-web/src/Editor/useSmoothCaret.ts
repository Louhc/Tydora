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
 * 4. 显示/隐藏用 **`display: none`** ✓ —— 它让光标**完全不进布局** ✓；
 *    早期用 `visibility` ✗ 元素仍参与布局 ✓，绝对定位后代会把滚动容器的 `scrollHeight` 撑大 ✗
 *    → 滚到底一片空白 ✓（这条坑踩了很多轮 ✗）。状态只在显示/隐藏切换时写一次 ✓，不是每帧 ✓。
 * 5. 先读完所有几何量（coordsAtPos / getBoundingClientRect），再统一写样式，避免读写交错。
 *
 * ## 位置策略
 * 光标元素挂在**滚动容器 `.tiptap-editor` 内部**，坐标用"内容坐标"
 * （视口坐标 + 当前 scrollTop/scrollLeft）。这样滚动时它跟着内容一起被合成器移动，
 * 不需要监听 scroll、也不会落后一帧。因此这里只在选区变化时重算，滚动不触发任何 JS。
 */

/** 打字后保持常亮的时长：超过它才恢复闪烁 */
const TYPING_HOLD_MS = 600;

/**
 * 取某个元素的行高（px）✓。
 *
 * ⚠️ **不要缓存**结果 ✗。
 *
 * 以前用 `WeakMap` 按元素缓存 ✓ —— 但字号是运行时可变的 ✓（Ctrl+滚轮 / 设置面板 ✓），
 * 缓存不失效 ✗ → 从大字号缩到小字号后，光标仍按**旧的大行高**画 ✗
 * → "字号很小的时候，标题的光标高得离谱"✗（用户实测 ✓）。标题的 line-height 是
 * 1.25、字号又是 2.2em ✓，缓存过期时差异尤其明显 ✓。
 * `getComputedStyle` 只在光标移动时取一次 ✓，代价可以接受 ✓。
 */
function lineHeightOf(el: HTMLElement, fallback: number): number {
  let lh = fallback;
  try {
    const parsed = Number.parseFloat(getComputedStyle(el).lineHeight);
    if (Number.isFinite(parsed) && parsed > 0) lh = parsed;
  } catch {
    /* 取不到就用 fallback */
  }
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
    caret.style.display = "none"; // 初始隐藏 ✓（hidden 初值是 true ✓），不进布局 ✓

    let raf = 0;
    let typingTimer = 0;
    /** 隐藏状态缓存：避免每帧重复写 display / 触发样式失效 */
    let hidden = true;
    /** 上一次写入时光标所在文档的正文高度 ✓（用来识别"换文档"的那一两帧 ✗）*/
    let lastContentHeight = -1;

    /**
     * 正文内容的高度 ✓ —— 用来**夹住光标位置** ✗。
     *
     * ⚠️ 光标是 `position: absolute` 的后代 ✗，**绝对定位同样计入滚动容器的 `scrollHeight`** ✗。
     * 换文件时它在布局中途可能被写到旧文档的位置（实测到过 4.5 万像素 ✗），
     * 于是滚动条凭空多出几万像素可滚 ✗ → 用户滚下去全是空白 ✓（复现日志已确认 ✓）。
     */
    const contentHeight = () => {
      const content = scroller.querySelector(".tiptap") as HTMLElement | null;
      return Math.max(0, content?.offsetHeight ?? scroller.clientHeight);
    };

    /**
     * 显示 / 隐藏光标 ✓ —— 隐藏用 **`display: none`** ✓。
     *
     * 为什么不用 `visibility: hidden` ✗：元素仍然参与布局 ✓，而光标是 `position: absolute` 后代 ✗
     * → 会把滚动容器的 `scrollHeight` 撑大 ✗ → 滚到底一片空白 ✓（之前用了好几轮"夹位置/归位"去擦 ✓）。
     * `display: none` 让它**完全不进布局** ✓ → 从根上不会再撑大滚动容器 ✓。
     * 只切一次状态 ✓（不是每帧 ✓），开销可以忽略 ✓。
     */
    const setHidden = (next: boolean) => {
      if (hidden === next) return;
      hidden = next;
      caret.style.display = next ? "none" : "block";
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
      /**
       * ⚠️ **组字（输入法）期间不要动光标** ✗。
       *
       * `view.coordsAtPos()` 是布局读取 ✓、写 `caret.style` 是样式写入 ✓ ——
       * 在 IME 组字过程中做这些会打断组字 ✗：实测 Google 日语输入法打 `so` 时，
       * 第一个 `s` 被提前提交、变成 `sそ` ✗（用户实测 ✓）。组字期间交给原生光标 ✓。
       */
      if (view.composing) {
        setHidden(true);
        return;
      }
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
      /**
       * ── 根因守卫 ✓：换文档的那一两帧**不写位置** ──
       *
       * 这一刻 `coordsAtPos()` 用的是新布局 ✓，但 `scroller.scrollTop` 还停在旧文档的位置 ✗
       * （实测 35914，而新正文只有 7945 ✗）→ `viewportTop + scrollTop` 算出来是脏坐标 ✗ →
       * 光标被写到旧文档深处 ✗ → 它又是绝对定位后代 ✗ → 撑大 `scrollHeight` ✗ → 滚到底一片空白 ✓。
       *
       * 判据：正文高度**大幅变矮** ✓（打字只会变几像素 ✓；换文档是成百上千 ✓）。
       * 命中就隐藏 + 归位 ✓，等下一帧（布局稳定后）再正常写入 ✓ —— 一次性 ✓，不轮询 ✓。
       */
      const nowContentH = contentHeight();
      if (lastContentHeight >= 0 && nowContentH < lastContentHeight - 200) {
        lastContentHeight = nowContentH;
        setHidden(true);
        return;
      }
      lastContentHeight = nowContentH;

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
      // 先把位置写好，再显示 ✓ —— 反过来会从"上一次的位置"滑过来 ✗（用户实测：光标从左上角滑入 ✗）
      const clampedTop = Math.max(0, Math.min(top, contentHeight() + 8));
      caret.style.transform = `translate3d(${left}px, ${clampedTop}px, 0)`;
      caret.style.height = `${Math.max(8, boxHeight)}px`;
      setHidden(false);
      markTyping();
    };

    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(update);
    };

    /**
     * **同步**重绘光标 ✓（事件 `tydora:caret-sync`）。
     *
     * 拖动侧栏 / 缩放窗口时，TipTapEditor 会逐帧修正 `scrollTop` ✓。
     * 如果光标仍走 rAF（下一帧才重算 ✗），这一帧的光标就会跟着滚动抖一下 ✗ ——
     * 在修正滚动之后立刻同步跑一次 update ✓，两者就能在同一帧对齐 ✓。
     */
    const onCaretSync = () => {
      if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
      /**
       * **只压制这一次同步重绘的过渡** ✓。
       *
       * 之前用「给 <html> 挂 data-caret-no-anim」来关过渡 ✗ —— 全局标记一旦没及时撤掉 ✗，
       * 平时打字的光标动画也会被一起关掉 ✗（用户实测："正常输入字母时光标的动画似乎也被取消了"）。
       * 改成写在光标元素自己的 inline style 上 ✓、下一帧立刻还原 ✓ —— 不可能残留 ✓。
       */
      const prevTransition = caret.style.transition;
      caret.style.transition = "none";
      try {
        update();
      } catch {
        /* 视图未就绪：忽略这次同步，下一次 schedule() 会补上 */
      }
      requestAnimationFrame(() => {
        caret.style.transition = prevTransition;
      });
    };
    window.addEventListener("tydora:caret-sync", onCaretSync);

    /**
     * ⚠️ 组字结束时必须**再调度一次** ✓。
     *
     * 上面 `view.composing` 守卫会在组字期间把光标藏起来 ✓；而 IME 按回车提交时，
     * 那次 `transaction` 往往**仍处于 composing 状态** ✗ → 光标被藏、之后没有事件再触发 ✗
     * → "按下回车结束输入后光标不出现"✗（用户实测 ✓）。监听 `compositionend` 补一次即可 ✓。
     */
    const onCompositionEnd = () => schedule();
    host.addEventListener("compositionend", onCompositionEnd, true);

    editor.on("selectionUpdate", schedule);
    editor.on("transaction", schedule);
    editor.on("focus", schedule);
    editor.on("blur", schedule);
    // 只监听"尺寸变化"，不监听 scroll —— 滚动由内容坐标天然跟随
    /**
     * 尺寸变化时重算光标位置 ✓。
     *
     * ⚠️ 必须 observe **内容元素**（`view.dom`）而不是只 observe 滚动容器 ✗：
     * 字号变化时滚动容器自身尺寸不变 ✓（变的是内容高度 / 行高 ✓），
     * 只 observe scroller 根本不会触发 ✗ —— 表现就是"放大缩小后光标位置还是旧的"✗。
     */
    /**
     * 内容尺寸一变（换文档 / 字号变化 / 图片加载 ✓）就检查光标是否越界 ✓。
     *
     * 这就是"切换文档时一次性做好" ✓ —— 由 `ResizeObserver` 驱动 ✗，不是轮询 ✓。
     * 换文档时正文会突然变矮 ✓，而光标可能还停在旧文档的深处 ✗：
     * 它是绝对定位后代 ✗ → 会把滚动容器的 `scrollHeight` 撑大 ✓ → 滚到底一片空白 ✓。
     */
    const resizeObserver = new ResizeObserver(schedule); // 尺寸变化 → 重新量一次（守卫在 update 里 ✓）
    resizeObserver.observe(scroller);
    try {
      resizeObserver.observe(editor.view.dom as HTMLElement);
    } catch {
      /* view.dom 不可用时忽略 */
    }
    /**
     * 字号变化是改 `--editor-font-size` 这个 CSS 变量 ✓，内容尺寸变化可能有延迟 ✓，
     * 所以再监听根元素的 `style` 变化 ✓ —— 保证字号一改就重算 ✓。
     */
    const styleObserver = new MutationObserver(schedule);
    try {
      styleObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["style"] });
    } catch {
      /* 忽略 */
    }
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
      styleObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("visibilitychange", schedule);
      host.removeEventListener("compositionend", onCompositionEnd, true);
      window.removeEventListener("tydora:caret-sync", onCaretSync);
      caret.remove();
    };
  }, [editor, hostRef, enabled]);
}
