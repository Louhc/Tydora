/**
 * 实测注音的「本体宽度 / 读音宽度」，写进各自的 CSS 变量。
 *
 * 背景：注音的读音是 `::after` 绝对定位画上去的，**不参与布局** —— 读音比本体长时会向两侧
 * 溢出、压到相邻注音。所以需要在**本体**两侧各让出 `(读音宽 − 本体宽) / 2`。
 *
 * 早期是按字符数估算（每个字 1em / 0.5em），对 CJK 勉强可用，但：
 *   - 英文等**非等宽**字体里，每个字母宽度差异很大（i 与 W 差几倍 ✗）；
 *   - 读音为英文时估算值会高出一倍，本体左右多出大片空白（用户实测反馈 ✗）。
 * 所以改成**实测**：
 *   - 本体：Range.getBoundingClientRect().width —— 精确，且天然不含 padding ✓；
 *   - 读音：它是 ::after，量不到；但可以用 canvas 按**它自己的计算字体**量 ✓。
 *
 * 结果以 **px** 写进 --ruby-base-w / --ruby-rt-w（内联变量最可靠），CSS 只负责取差值 ✓。
 */
import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";

/** canvas 上下文只需一个，复用即可 */
let measureCtx: CanvasRenderingContext2D | null = null;

function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  try {
    const canvas = document.createElement("canvas");
    measureCtx = canvas.getContext("2d");
  } catch {
    measureCtx = null;
  }
  return measureCtx;
}

/**
 * 用一个元素的**当前字体**量一段文字的宽度（px）。
 * pseudo 传 "::after" 时取伪元素的字体（读音是 0.5em 字号，必须用它自己的）。

/**
 * 量根节点下所有 .md-ruby，把宽度写进 CSS 变量。
 * 幂等：重复调用只是重新量一次（字体/主题变化后也能跟上）。
 */
/**
 * 注音读音的安全余量，单位是**本体字号**的 em（跟随字号变化 ✓）。
 * 0.2em：默认字号（16px）下约 3.2px，平分到两侧每边约 1.6px。
 */
const RT_MARGIN_EM = 0.2;
export function measureRubies(root: HTMLElement | null | undefined): void {
  if (!root) return;
  const nodes = root.querySelectorAll<HTMLElement>(".md-ruby[data-rt]");
  if (nodes.length === 0) return;

  /**
   * ⚠️ 必须**分三段**做：先全部读 → 再全部算 → 最后全部写 ✓。
   *
   * 以前在一个 for 循环里「读一次布局 → 写一次样式」交替 ✗：
   * 每次写 CSS 变量都让布局失效 ✗ → 下一次读又强制重排 ✗
   * → 整篇 N 个注音就是 N 次强制布局 ✗。
   * 实测（性能探针）平均 **44ms / 次** ✗，一帧才 16ms ✗ → 输入被切成一块一块 ✓。
   */

  // ── ① 只读：本体宽度（合并成一次布局）+ 计算字体 ──
  const range = document.createRange();
  const fontCache = new Map<string, string>();
  const tasks: { el: HTMLElement; baseW: number; rt: string; margin: number; font: string }[] = [];

  for (const el of nodes) {
    if (!el.isConnected) continue;
    const rt = el.dataset.rt ?? "";
    if (!rt) continue;
    let baseW = 0;
    try {
      range.selectNodeContents(el);
      baseW = range.getBoundingClientRect().width;
    } catch {
      baseW = 0;
    }

    const cs = getComputedStyle(el);
    const baseFontPx = parseFloat(cs.fontSize) || 16;
    const margin = baseFontPx * RT_MARGIN_EM;

    // 读音是 ::after、字号 0.5em：字体族 / 字重 / 字形沿本体 ✓
    const fontKey = `${cs.fontStyle}|${cs.fontWeight}|${cs.fontFamily}|${baseFontPx}`;
    let font = fontCache.get(fontKey);
    if (font == null) {
      const pseudo = getComputedStyle(el, "::after");
      const pseudoSize = parseFloat(pseudo.fontSize) || baseFontPx * 0.5;
      font = `${pseudo.fontStyle || "normal"} ${pseudo.fontWeight || "400"} ${pseudoSize}px ${pseudo.fontFamily || cs.fontFamily || "serif"}`;
      fontCache.set(fontKey, font);
    }

    tasks.push({ el, baseW, rt, margin, font });
  }

  if (tasks.length === 0) return;

  // ── ② 只算：canvas 量读音（不碰布局 ✓，同字体同文本只量一次 ✓）──
  const ctx = getMeasureCtx();
  const textCache = new Map<string, number>();
  const results: { el: HTMLElement; baseW: number; rtW: number; margin: number }[] = [];
  for (const t of tasks) {
    let rtW = 0;
    if (ctx) {
      const key = t.font + "\u0000" + t.rt;
      const cached = textCache.get(key);
      if (cached != null) {
        rtW = cached;
      } else {
        ctx.font = t.font;
        try {
          rtW = ctx.measureText(t.rt).width;
        } catch {
          rtW = 0;
        }
        textCache.set(key, rtW);
      }
    }
    results.push({ el: t.el, baseW: t.baseW, rtW, margin: t.margin });
  }

  // ── ③ 只写：一次性写回变量（此后不再读布局 ✓）──
  for (const r of results) {
    if (r.baseW > 0) r.el.style.setProperty("--ruby-base-w", `${r.baseW.toFixed(2)}px`);
    if (r.rtW > 0) r.el.style.setProperty("--ruby-rt-w", `${(r.rtW + r.margin).toFixed(2)}px`);
  }
}

/**
 * 注音宽度实测：编辑器创建后量一次，之后**内容变化**时再量（选区变化不必量）。
 * 用 rAF 延后到布局完成之后，避免量到未排版的尺寸（会得到 0）。
 */
export const RubyMeasure = Extension.create({
  name: "rubyMeasure",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("tydoraRubyMeasure"),
        view(editorView) {
          let scheduled = false;
          const run = () => {
            scheduled = false;
            measureRubies(editorView.dom as HTMLElement);
          };
          const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(run);
          };
          // 初始渲染后量一次（首次打开文件、重建视图都会走到这里）
          schedule();
          return {
            update(view, prevState) {
              // 内容没变就不必重排：选区变化、装饰变化都不影响文字宽度
              if (view.state.doc.eq(prevState.doc)) return;
              /**
               * ⚠️ **组字（输入法）期间不要量** ✗。
               *
               * `measureRubies` 会读 `Range.getBoundingClientRect()` 并**写 CSS 变量** ✓ ——
               * 在 IME 组字过程中做这些会打断组字 ✗：实测用 Google 日语输入法打 `so` 时，
               * 第一个 `s` 被提前提交、变成 `sそ` ✗（用户实测 ✓）。
               * 组字结束后 `compositionend` 会再触发一次 update ✓，届时补量即可 ✓。
               */
              if (view.composing) return;
              schedule();
            },
          };
        },
      }),
    ];
  },
});
