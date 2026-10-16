/**
 * 滚动条显示策略。
 *
 * 默认**隐藏**（用户要求），可在「设置 → 外观」里打开。
 *
 * 做法：给 `<html>` 挂 `data-hide-scrollbars` 属性，配一段 CSS（见 App.css 末尾）——
 * 只隐藏**视觉上的滚动条**，滚轮 / 触控板 / 键盘 / 拖动内容滚动都完全不受影响 ✓。
 *
 * 跨窗口同步沿用项目既有模式：写 localStorage，其它窗口靠 `storage` 事件重放
 *（与 utils/menuDensity.ts、utils/uiScale.ts 一致）。
 */
export function normalizeHideScrollbars(value: unknown): boolean {
  // 没设置过 → 默认隐藏（true）；只有显式 false 才显示滚动条
  return value === undefined || value === null ? true : value !== false;
}

export function applyHideScrollbars(hide: boolean): void {
  document.documentElement.dataset.hideScrollbars = hide ? "1" : "0";
}

/** 从 localStorage 读取并应用到当前窗口（供各窗口入口尽早调用） */
export function applyHideScrollbarsFromStorage(): void {
  try {
    const raw = localStorage.getItem("zmd-general-settings");
    const settings = raw ? JSON.parse(raw) : {};
    applyHideScrollbars(normalizeHideScrollbars(settings.hideScrollbars));
  } catch {
    applyHideScrollbars(true);
  }
}
