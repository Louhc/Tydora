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
 */
function measureTextPx(el: Element, text: string, pseudo?: string): number {
  if (!text) return 0;
  const ctx = getMeasureCtx();
  if (!ctx) return 0;
  const cs = getComputedStyle(el, pseudo);
  // font 简写不一定可靠（部分环境下为空），逐项拼出来更稳
  const style = cs.fontStyle || "normal";
  const weight = cs.fontWeight || "400";
  const size = cs.fontSize || "16px";
  const family = cs.fontFamily || "serif";
  ctx.font = `${style} ${weight} ${size} ${family}`;
  try {
    return ctx.measureText(text).width;
  } catch {
    return 0;
  }
}

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
  const range = document.createRange();
  for (const el of nodes) {
    if (!el.isConnected) continue;
    const rt = el.dataset.rt ?? "";
    // 本体：Range 量内容宽度（不含 padding，正好是我们需要的数值）
    let baseW = 0;
    try {
      range.selectNodeContents(el);
      baseW = range.getBoundingClientRect().width;
    } catch {
      baseW = 0;
    }
    // 读音：按 ::after 的字体量（它是 0.5em 字号）
    const rtW = measureTextPx(el, rt, "::after");
    /**
     * 安全余量：实测宽度是"字形的紧贴包围盒"，相邻两个注音的读音会几乎挨在一起
     *（用户实测：两个 アクセル 贴上了 ✗）。这里给读音宽度多加一点，
     * 由于 CSS 最终是 `(读音宽 − 本体宽) / 2` 分到两侧，所以每边实际多出 余量/2。
     *
     * ⚠️ 余量必须**跟随字号**：固定 px 在用户调大字号后就不够用了 ✗。
     * 这里取本体字号的 0.5em（默认字号下约 8px，每边约 4px）✓。
     * 想更松/更紧就改 RT_MARGIN_EM ✓。
     */
    const baseFontPx = parseFloat(getComputedStyle(el).fontSize) || 16;
    const rtMargin = baseFontPx * RT_MARGIN_EM;
    if (baseW > 0) el.style.setProperty("--ruby-base-w", `${baseW.toFixed(2)}px`);
    if (rtW > 0) el.style.setProperty("--ruby-rt-w", `${(rtW + rtMargin).toFixed(2)}px`);
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
              schedule();
            },
          };
        },
      }),
    ];
  },
});