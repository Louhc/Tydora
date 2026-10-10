import { lazy, Suspense } from "react";
import ReactDOM from "react-dom/client";
import { bootStart, bootEnd, bootStamp, bootSummary, connectRustBootTiming } from "./boot-timing";

// —— 最早的 JS 执行时间点（文件解析即执行，无需等待 import 完成）
bootStart("main_entry_to_root_rendered");
bootStamp("js_main_entry");

import { ThemeProvider } from "./themes";
import { LanguageProvider } from "./i18n/LanguageContext";
import { VimProvider } from "./vim";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./i18n"; // init i18next before first render
bootStamp("i18n_imported_init_done");

import "./themes.css";
import "./global.css";
import { applyMenuDensityFromStorage } from "./utils/menuDensity";
import { setupUiScale } from "./utils/uiScale";

// 尽早应用菜单密度与界面缩放，保证各独立窗口（设置/白板/图谱等）启动即生效
applyMenuDensityFromStorage();
setupUiScale();
window.addEventListener("storage", (e) => {
  if (e.key === "zmd-general-settings") applyMenuDensityFromStorage();
});

// macOS Overlay 标题栏：给布局留出红绿灯空间，并隐藏自定义红黄绿按钮
if (
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPod|iPad/i.test(navigator.platform) ||
    navigator.userAgent.includes("Mac OS"))
) {
  document.documentElement.classList.add("platform-macos");
} else if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("platform-windows");
} else if (typeof navigator !== "undefined" && /Linux/i.test(navigator.userAgent)) {
  document.documentElement.classList.add("platform-linux");
}

// 是否按住了 Ctrl / ⌘：CSS 无法感知修饰键，挂在 <html> 上供样式选择器使用
// （例如顶栏文件名在按住 Ctrl 时变成"可点击"手型 —— 那时点击是"打开所在位置"）。
// 用 window 的 blur 兜底：切走窗口时收不到 keyup，类会一直挂着。
(() => {
  const root = document.documentElement;
  const sync = (e: KeyboardEvent, down: boolean) => {
    if (e.key !== "Control" && e.key !== "Meta") return;
    root.classList.toggle("ctrl-held", down);
  };
  const onDown = (e: KeyboardEvent) => sync(e, true);
  const onUp = (e: KeyboardEvent) => sync(e, false);
  const clear = () => root.classList.remove("ctrl-held");
  window.addEventListener("keydown", onDown, true);
  window.addEventListener("keyup", onUp, true);
  window.addEventListener("blur", clear);
})();

// 开始接收 Rust boot-timing 事件（异步：不阻塞当前模块解析）
connectRustBootTiming();
bootStamp("rust_boot_listener_registered");

// 按窗口代码分割：每个窗口只加载自身及其依赖的 chunk，
// 避免启动/打开窗口时解析全部窗口的代码（显著降低首屏与窗口打开耗时）
bootStart("main_window_lazy_chunks_resolve");
const App = lazy(() =>
  import("./App").then((m) => {
    bootStamp("App_chunk_resolved");
    return m;
  })
);
const MindmapWindow = lazy(() => import("./mindmap").then((m) => ({ default: m.MindmapWindow })));
const GraphWindow = lazy(() => import("./graph").then((m) => ({ default: m.GraphWindow })));
const CanvasWindow = lazy(() => import("./Canvas/CanvasWindow"));
const SettingsWindow = lazy(() => import("./Settings"));

// 屏蔽 ResizeObserver 循环警告（调整窗口/侧栏宽度时的良性警告）
// Chromium 的 ResizeObserver 错误走 window.onerror 和 console.error 两条路径
const RESIZE_OBSERVER_MSG = "ResizeObserver loop completed with undelivered notifications";
const prevOnError = window.onerror;
window.onerror = function (message, source, lineno, colno, error) {
  if (typeof message === "string" && message.includes(RESIZE_OBSERVER_MSG)) return true;
  if (prevOnError) return prevOnError.call(window, message, source, lineno, colno, error);
  return false;
};
const _origConsoleError = console.error.bind(console);
console.error = (...args: any[]) => {
  const msg = args[0];
  const text = msg instanceof Error ? msg.message : String(msg ?? "");
  if (text.includes(RESIZE_OBSERVER_MSG)) return;
  _origConsoleError(...args);
};

// 屏蔽 React DevTools 下载提示（Tauri 桌面应用无法使用浏览器扩展）
if (import.meta.env.DEV) {
  const originalLog = console.log;
  console.log = (...args: any[]) => {
    if (typeof args[0] === "string" && args[0].includes("React DevTools")) return;
    originalLog(...args);
  };
}

function Root() {
  bootStamp("root_component_entered");
  const urlParams = new URLSearchParams(window.location.search);
  /**
   * 窗口类型：优先 URL 的 ?window=；dev 下入口是 index.html，走 Vite 时 query 可能被
   * 重定向吃掉，于是退回读 **Tauri 窗口 label**（Rust 建窗口时的 label 与这里的 key 同名：
   * settings / mindmap / graph / canvas / vault-manager / editor）。
   */
  let windowKind = urlParams.get("window");
  if (!windowKind) {
    try {
      windowKind = getCurrentWindow().label || null;
    } catch {
      windowKind = null;
    }
  }
  const isMindmapWindow = windowKind === "mindmap";
  const isGraphWindow = windowKind === "graph";
  const isCanvasWindow = windowKind === "canvas";
  const isSettingsWindow = windowKind === "settings";
  const initialFilePath = windowKind === "editor"
    ? urlParams.get("file")?.replace(/\//g, "\\")
    : null;
  const initialVaultPath = windowKind === "editor"
    ? urlParams.get("vault")?.replace(/\//g, "\\")
    : null;

  if (isSettingsWindow) {
    bootEnd("main_window_lazy_chunks_resolve");
    return <SettingsWindow />;
  }
  if (isMindmapWindow) {
    bootEnd("main_window_lazy_chunks_resolve");
    return <MindmapWindow />;
  }
  if (isGraphWindow) {
    bootEnd("main_window_lazy_chunks_resolve");
    return <GraphWindow />;
  }
  if (isCanvasWindow) {
    bootEnd("main_window_lazy_chunks_resolve");
    return <CanvasWindow />;
  }
  return (
    <VimProvider>
      <App initialFilePath={initialFilePath} initialVaultPath={initialVaultPath} />
    </VimProvider>
  );
}

bootStart("react_commit_root");
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ThemeProvider>
    <LanguageProvider>
      <Suspense fallback={null}>
        <Root />
      </Suspense>
    </LanguageProvider>
  </ThemeProvider>,
);

// 首帧完成后，在"下一个 rAF + 下一个 macrotask"确认"用户可见第一帧"确实发生（commit→paint）
requestAnimationFrame(() => {
  setTimeout(() => {
    bootStamp("first_paint_likely");
    bootEnd("react_commit_root");
    bootEnd("main_entry_to_root_rendered");
    bootEnd("main_window_lazy_chunks_resolve");
    // 首阶段时间点先打印一轮，后续 App 内部的埋点会继续追加到 stamps
    bootSummary();
  }, 0);
});
