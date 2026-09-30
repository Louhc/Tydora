/**
 * 荧光笔（多色高亮）调色板 + 全局状态。
 *
 * 颜色写进 mark 的 `background-color` / `data-color`（TipTap Highlight 的
 * multicolor 模式），所以能随 Markdown 一起往返 —— tiptap-markdown 对没有
 * markdown spec 的 mark 会退化成内联 HTML，正好保留这两个属性。
 *
 * 状态放模块级 store 而不是 React props：右键菜单、快捷键派发
 * （custom-commands）和编辑器组件都要读写同一份「当前颜色 / 是否处于荧光笔
 * 模式」，用 useSyncExternalStore 订阅可以避免层层透传。
 */

export interface HighlightColorOption {
  id: string;
  /** 写入 mark 的 CSS 颜色（background-color + data-color） */
  color: string;
  /** i18n key：editor.highlightColor.<id> */
  labelKey: string;
}

/**
 * 6 种荧光笔颜色。
 *
 * 都是浅色底，配 theme.css 里的深墨色前景（`--highlight-ink`），
 * 这样在浅色和深色主题下都清晰 —— 若沿用主题前景色，深色主题下会变成
 * 浅字浅底。
 */
export const HIGHLIGHT_COLORS: HighlightColorOption[] = [
  { id: "yellow", color: "#ffe58f", labelKey: "editor.highlightColor.yellow" },
  { id: "green", color: "#b7ebc6", labelKey: "editor.highlightColor.green" },
  { id: "blue", color: "#b3ddff", labelKey: "editor.highlightColor.blue" },
  { id: "pink", color: "#ffc9de", labelKey: "editor.highlightColor.pink" },
  { id: "purple", color: "#dcc9ff", labelKey: "editor.highlightColor.purple" },
  { id: "orange", color: "#ffd6a5", labelKey: "editor.highlightColor.orange" },
];

export const DEFAULT_HIGHLIGHT_COLOR = HIGHLIGHT_COLORS[0].color;

const COLOR_STORAGE_KEY = "zmd-highlighter-color";

function readStoredColor(): string {
  try {
    const saved = localStorage.getItem(COLOR_STORAGE_KEY);
    if (saved && HIGHLIGHT_COLORS.some((c) => c.color.toLowerCase() === saved.toLowerCase())) {
      return saved;
    }
  } catch {
    // localStorage 不可用（隐私模式等）：回退默认色
  }
  return DEFAULT_HIGHLIGHT_COLOR;
}

let currentColor = readStoredColor();
// 荧光笔模式是「一次性工具」语义，不持久化：重启后不该莫名其妙处于划选即高亮状态
let penMode = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function subscribeHighlighter(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getHighlighterColor(): string {
  return currentColor;
}

export function setHighlighterColor(color: string): void {
  if (color === currentColor) return;
  currentColor = color;
  try {
    localStorage.setItem(COLOR_STORAGE_KEY, color);
  } catch {
    // 持久化失败不影响本次会话
  }
  emit();
}

export function getHighlighterMode(): boolean {
  return penMode;
}

export function setHighlighterMode(on: boolean): void {
  if (on === penMode) return;
  penMode = on;
  emit();
}

export function toggleHighlighterMode(): void {
  setHighlighterMode(!penMode);
}

/** 颜色对应的调色板项（菜单打勾、取本地化名称用）。 */
export function highlightColorOption(color: string): HighlightColorOption | undefined {
  return HIGHLIGHT_COLORS.find((c) => c.color.toLowerCase() === color.toLowerCase());
}
