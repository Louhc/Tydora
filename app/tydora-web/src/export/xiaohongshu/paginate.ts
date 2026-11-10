// 卡片分页：严格按 --- 分割线（hr）分页。
// - 只要内容中存在 hr，断点即为每个 hr 底部——分割线之间的内容各自成为一张卡片，
//   完全忽略页高与标题分页设置（卡片高度由 render.ts 按分段内容自适应）；
// - 仅当内容中不存在任何 hr 时，退化为按页高安全切分（兜底，保证不切断块级元素/
//   代码行/文本行，算法与 src/export/exporters.ts 的 findSafePageBreaks 一致，但改为
//   内容相对坐标、scale=1）。
// 断点坐标均为内容相对坐标（CSS px）。

/** 不可分割块级元素选择器（同时用于空段检测） */
export const UNSPLITTABLE_SELECTORS = [
  "p",
  "li",
  "pre",
  "blockquote",
  "h1", "h2", "h3", "h4", "h5", "h6",
  ".callout",
  "tr",
  "figure",
  "img",
  "svg",
  "ul[data-type='taskList'] > li",
];

interface LineRect {
  top: number;
  bottom: number;
}

/** 收集元素内每个视觉行（处理自动换行）的上下边界，坐标相对内容顶部 */
function collectTextLines(el: HTMLElement, offsetTop: number): LineRect[] {
  const lines: LineRect[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const range = document.createRange();
    range.selectNodeContents(node);
    const rects = range.getClientRects();
    for (let i = 0; i < rects.length; i++) {
      const rect = rects[i];
      lines.push({ top: rect.top - offsetTop, bottom: rect.bottom - offsetTop });
    }
  }
  if (lines.length === 0) return [];

  lines.sort((a, b) => a.top - b.top);
  const merged: LineRect[] = [];
  for (const line of lines) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(line.top - last.top) < 2) {
      last.bottom = Math.max(last.bottom, line.bottom);
    } else {
      merged.push({ top: line.top, bottom: line.bottom });
    }
  }
  return merged;
}

/** 将断点 snap 到最近的文本行边界，避免切断一行文字（阈值 ratio） */
function snapToLineBoundary(
  nextY: number,
  currentY: number,
  pageH: number,
  lines: LineRect[],
  ratio: number,
): number {
  for (let i = 0; i < lines.length - 1; i++) {
    const thisLineBottom = lines[i].bottom;
    const nextLineTop = lines[i + 1].top;
    if (nextY >= thisLineBottom && nextY <= nextLineTop) {
      if (thisLineBottom - currentY >= pageH * ratio) {
        return thisLineBottom;
      }
      return nextLineTop;
    }
  }
  const lastLine = lines[lines.length - 1];
  if (lastLine && nextY > lastLine.bottom) return lastLine.bottom;
  const firstLine = lines[0];
  if (firstLine && nextY < firstLine.top) return firstLine.top;
  return nextY;
}

/**
 * 把断点**向下吸附到下一行的行顶** ✓
 *
 * 只允许向下 ✗→✓：
 *  - 若允许"最近的边界"✓，`hr.bottom` 会经常吸到**上一行的行底** ✗ →
 *    那一行就被前后两张卡片**同时包含** ✓ → 下一页顶部出现重复的一行 ✓（实测两次 ✓）；
 *  - 只取"第一个 ≥ y 的行顶" ✓ → 断点永远不小于 y ✓，上一行完整留在上一张 ✓，
 *    下一张从干净的一行开始 ✓。
 *
 * 找不到时返回 y 本身（不吸附 ✓）。
 */
function snapDownToLineStart(y: number, lines: LineRect[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const line of lines) {
    if (line.top >= y - 0.5 && line.top < best) best = line.top;
  }
  return Number.isFinite(best) ? best : y;
}

/**
 * 把断点**向上吸到下一个块的顶边**：在 `(afterY, y)` 之间有块顶时取最小的那个块顶。
 *
 * 用途见 hr 分支：只吸到「行顶」会把块的首行留在卡片底边上（测量与克隆有几像素差就露馅）；
 * 吸到块顶至少多出 margin-top + 半行距的余量。限定 `top > afterY` 保证断点不会跑到
 * 分割线之前。
 */
function snapUpToBlockTop(afterY: number, y: number, rects: { top: number }[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (const r of rects) {
    if (r.top > afterY - 0.5 && r.top < y && r.top < best) best = r.top;
  }
  return Number.isFinite(best) ? best : y;
}

/**
 * 计算分页断点。返回内容相对坐标（CSS px），首尾分别为 0 与内容总高。
 * 内容中存在 hr（---）时严格按分割线分页；无 hr 时按页高安全切分。
 */
export function computePageBreaks(
  contentEl: HTMLElement,
  pageContentH: number,
): number[] {
  const contentRect = contentEl.getBoundingClientRect();
  const offsetTop = contentRect.top;
  const contentBottom = contentEl.offsetHeight;

  if (contentBottom <= 0) return [0, 0];

  const elements = Array.from(contentEl.querySelectorAll(UNSPLITTABLE_SELECTORS.join(", ")));
  const rects = elements
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        el: el as HTMLElement,
        top: rect.top - offsetTop,
        bottom: rect.bottom - offsetTop,
        height: rect.height,
      };
    })
    .filter((r) => r.height > 0);

  // 分割线（--- / <hr>）：作为分页点收集（不属于不可分割元素）
  const hrRects = Array.from(contentEl.querySelectorAll("hr"))
    .map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        el: el as HTMLElement,
        top: rect.top - offsetTop,
        bottom: rect.bottom - offsetTop,
        height: rect.height,
      };
    })
    .filter((r) => r.height > 0);

  // ── 严格分割线分页 ──
  // 只要存在 hr（---），断点即为每个 hr 底部：分割线之间的内容各自成一张卡片，
  // 完全忽略页高与标题分页设置（卡片高度由 render.ts 按分段内容自适应）。
  if (hrRects.length > 0) {
    /**
     * 严格按分割线分页 ✓ —— 但断点要**吸附到文本行边界** ✗→✓：
     * `hr.bottom` 与上一行行底 / 下一行行顶常有半行偏差 ✗，
     * 不吸附就会出现"两张卡片共享同一行、且这一行被切一半"✗（用户实测 ✓）。
     */
    const allLines = collectTextLines(contentEl, offsetTop);
    const breaks: number[] = [0];
    for (const hr of hrRects) {
      const snapped = snapDownToLineStart(hr.bottom, allLines);
      /**
       * ⚠️ 再往上吸到**下一个块的顶边**。
       *
       * 只吸到「行顶」会在卡片底部切进块的首行：测量容器与卡片克隆里的垂直位置
       * 只要有几像素差（margin 折叠 / 字体度量 / 行高取整），块的第一行就会从卡片
       * 底边露出一截 —— 用户实测：第 4 张底边露出 `### ②` 标题的上半截。
       *
       * 块的顶边比块内首行的行顶至少高「margin-top + 半行距」，这几十像素正好是
       * 安全余量，且断点仍落在 hr 之后（不会把分割线前的内容切走）。
       */
      const b = snapUpToBlockTop(hr.bottom, snapped, rects);
      if (b > breaks[breaks.length - 1] && b < contentBottom) breaks.push(b);
    }
    if (breaks[breaks.length - 1] < contentBottom) breaks.push(contentBottom);
    return breaks;
  }

  const codeBlockLines = new Map<HTMLElement, LineRect[]>();
  for (const r of rects) {
    if (r.el.tagName !== "PRE") continue;
    const lines = collectTextLines(r.el, offsetTop);
    if (lines.length > 0) codeBlockLines.set(r.el, lines);
  }

  const breaks: number[] = [0];
  let currentY = 0;

  while (currentY < contentBottom) {
    let nextY = Math.min(currentY + pageContentH, contentBottom);
    if (nextY >= contentBottom) break;

    const cutPre = rects.find(
      (r) => r.el.tagName === "PRE" && r.top < nextY && r.bottom > nextY,
    );
    if (cutPre) {
      if (cutPre.height < pageContentH) {
        nextY = cutPre.top;
      } else {
        const lines = codeBlockLines.get(cutPre.el);
        if (lines && lines.length > 0) {
          nextY = snapToLineBoundary(nextY, currentY, pageContentH, lines, 0.35);
        }
      }
    } else {
      const cut = rects.find(
        (r) => r.top < nextY && r.bottom > nextY && r.height < pageContentH,
      );
      if (cut) {
        const before = Math.max(currentY, cut.top);
        const after = cut.bottom;
        const tag = cut.el.tagName;

        if (tag === "LI" || tag === "TR" || tag === "FIGURE") {
          nextY = before;
        } else if (before - currentY >= pageContentH * 0.55) {
          nextY = before;
        } else if (after > currentY + pageContentH) {
          const tLines = collectTextLines(cut.el, offsetTop);
          if (tLines.length > 1) {
            nextY = snapToLineBoundary(currentY + pageContentH, currentY, pageContentH, tLines, 0.40);
          } else {
            nextY = after;
          }
        } else {
          nextY = after;
        }
      }
    }

    if (nextY <= currentY) {
      nextY = Math.min(currentY + pageContentH, contentBottom);
    }
    breaks.push(nextY);
    currentY = nextY;
  }

  breaks.push(contentBottom);
  return breaks;
}
