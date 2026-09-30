import { useEffect, useRef, useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { executeCommand } from "./extensions/custom-commands";
import { loadShortcuts, formatShortcutDisplay } from "./shortcuts";
import type { ShortcutItem } from "./shortcuts";
import type { Editor } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import {
  HIGHLIGHT_COLORS,
  getHighlighterColor,
  getHighlighterMode,
  setHighlighterColor,
  subscribeHighlighter,
} from "./highlighter";
import { TEXT_COLORS } from "./extensions/text-color";

interface ContextMenuProps {
  editor: Editor | null;
  /**
   * 菜单锚点。
   * - 不带 placement：锚点 = 鼠标落点，向右下展开（右键菜单）；
   * - placement: "above"：菜单浮在锚点**上方**，锚点取选区的左上角（划选文本时自动弹出）。
   */
  position: { x: number; y: number; placement?: "above" } | null;
  onClose: () => void;
}

interface IconItem {
  name: string;
  label: string;
  shortcutId: string | null;
  icon: React.ReactNode;
}

interface SubmenuEntry {
  name: string;
  label: string;
  shortcutId: string | null;
  icon?: React.ReactNode;
  /** 颜色色块（荧光笔调色板用）*/
  swatch?: string;
  /** 勾选态（当前荧光笔颜色/ 模式开关） */
  checked?: boolean;
}

interface SubmenuItem {
  name: string;
  label: string;
  icon?: React.ReactNode;
  submenu?: Array<SubmenuEntry | { divider: true; label: string }>;
}

/** 荧光笔调色板选项的name 前缀，点击时由本组件直接处理（不进executeCommand）。*/
const HIGHLIGHT_COLOR_PREFIX = "highlight-color:";

/** 文字颜色调色板选项的name 前缀（同上）。*/
const TEXT_COLOR_PREFIX = "text-color:";

const ICONS = {
  cut: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><line x1="20" y1="4" x2="8.12" y2="15.88" /><line x1="14.47" y1="14.48" x2="20" y2="20" /><line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  ),
  copy: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  ),
  paste: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  ),
  trash: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  ),
  bold: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4h8a4 4 0 014 4 4 4 0 01-4 4H6z" /><path d="M6 12h9a4 4 0 014 4 4 4 0 01-4 4H6z" />
    </svg>
  ),
  italic: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="19" y1="4" x2="10" y2="4" /><line x1="14" y1="20" x2="5" y2="20" /><line x1="15" y1="4" x2="9" y2="20" />
    </svg>
  ),
  strikethrough: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 4H9a3 3 0 00-2.83 4" /><path d="M14 12a4 4 0 010 8H6" /><line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  ),
  code: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  link: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
    </svg>
  ),
  quote: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V21z" />
      <path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3z" />
    </svg>
  ),
  listUnordered: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" /><line x1="8" y1="12" x2="21" y2="12" /><line x1="8" y1="18" x2="21" y2="18" /><circle cx="4" cy="6" r="1" fill="currentColor" /><circle cx="4" cy="12" r="1" fill="currentColor" /><circle cx="4" cy="18" r="1" fill="currentColor" />
    </svg>
  ),
  listOrdered: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="10" y1="6" x2="21" y2="6" /><line x1="10" y1="12" x2="21" y2="12" /><line x1="10" y1="18" x2="21" y2="18" /><text x="2" y="8" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">1</text><text x="2" y="14" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">2</text><text x="2" y="20" fontSize="7" fill="currentColor" stroke="none" fontFamily="sans-serif">3</text>
    </svg>
  ),
  checkSquare: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
    </svg>
  ),
  heading: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 4v16M18 4v16M6 12h12" />
    </svg>
  ),
  plus: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  image: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" ry="2" /><circle cx="8.5" cy="8.5" r="1.5" /><polyline points="21 15 16 10 5 21" />
    </svg>
  ),
  minus: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  ),
  table: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="3" y1="15" x2="21" y2="15" /><line x1="9" y1="3" x2="9" y2="21" /><line x1="15" y1="3" x2="15" y2="21" />
    </svg>
  ),
  codeBlock: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
    </svg>
  ),
  math: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <text x="3" y="17" fontSize="14" fill="currentColor" stroke="none" fontFamily="serif" fontStyle="italic">x</text><line x1="14" y1="5" x2="20" y2="19" /><line x1="20" y1="5" x2="14" y2="19" />
    </svg>
  ),
  chevronRight: (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  ),
  highlight: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
    </svg>
  ),
  wikiLink: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71" />
      <text x="7" y="16" fontSize="8" fill="currentColor" stroke="none" fontFamily="monospace">[[</text>
    </svg>
  ),
  toc: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="6" x2="20" y2="6" /><line x1="4" y1="12" x2="14" y2="12" /><line x1="4" y1="18" x2="17" y2="18" />
    </svg>
  ),
  pen: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.5 3.5a2.12 2.12 0 013 3L9 16l-4 1 1-4z" /><path d="M4 21h16" />
    </svg>
  ),
  eraser: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 20H8.5L3 14.5a1.5 1.5 0 010-2.1l6.9-6.9a1.5 1.5 0 012.1 0l7 7a1.5 1.5 0 010 2.1z" /><line x1="9" y1="9" x2="16" y2="16" />
    </svg>
  ),
  check: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  textColor: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5.5 16.5 11 4.5h1.2l5.5 12" /><line x1="7.8" y1="12.6" x2="15.6" y2="12.6" /><line x1="4" y1="20.5" x2="20" y2="20.5" />
    </svg>
  ),
};

// 三行图标按钮配置（使用工厂函数以便 i18n）
function createIconRows(t: (key: string) => string): IconItem[][] {
  return [
    // 第一行：剪贴板
    [
      { name: "cut", label: t("editor.contextMenu.cut"), shortcutId: null, icon: ICONS.cut },
      { name: "copy", label: t("editor.contextMenu.copy"), shortcutId: null, icon: ICONS.copy },
      { name: "paste", label: t("editor.contextMenu.paste"), shortcutId: null, icon: ICONS.paste },
      { name: "delete", label: t("editor.contextMenu.delete"), shortcutId: null, icon: ICONS.trash },
    ],
    // 第二行：行内格式
    [
      { name: "bold", label: t("editor.contextMenu.bold"), shortcutId: "bold", icon: ICONS.bold },
      { name: "italic", label: t("editor.contextMenu.italic"), shortcutId: "italic", icon: ICONS.italic },
      { name: "strike", label: t("editor.contextMenu.strikethrough"), shortcutId: "strike", icon: ICONS.strikethrough },
      { name: "inline-code", label: t("editor.contextMenu.inlineCode"), shortcutId: "inline-code", icon: ICONS.code },
      { name: "link", label: t("editor.contextMenu.link"), shortcutId: "link", icon: ICONS.link },
    ],
    // 第三行：块级格式
    [
      { name: "quote", label: t("editor.contextMenu.quote"), shortcutId: "quote", icon: ICONS.quote },
      { name: "list", label: t("editor.contextMenu.unorderedList"), shortcutId: "unordered-list", icon: ICONS.listUnordered },
      { name: "ordered-list", label: t("editor.contextMenu.orderedList"), shortcutId: "ordered-list", icon: ICONS.listOrdered },
      { name: "check", label: t("editor.contextMenu.taskList"), shortcutId: "check-list", icon: ICONS.checkSquare },
      { name: "highlight", label: t("editor.contextMenu.highlight"), shortcutId: "highlight", icon: ICONS.highlight },
    ],
  ];
}

// 子菜单配置（使用工厂函数以便 i18n）
function createSubmenuItems(t: (key: string) => string): SubmenuItem[] {
  return [
    {
      name: "heading",
      label: t("editor.contextMenu.heading"),
      icon: ICONS.heading,
      submenu: [
        { name: "heading-1", label: t("editor.contextMenu.heading1"), shortcutId: "heading-1" },
        { name: "heading-2", label: t("editor.contextMenu.heading2"), shortcutId: "heading-2" },
        { name: "heading-3", label: t("editor.contextMenu.heading3"), shortcutId: "heading-3" },
        { name: "heading-4", label: t("editor.contextMenu.heading4"), shortcutId: "heading-4" },
        { name: "heading-5", label: t("editor.contextMenu.heading5"), shortcutId: "heading-5" },
        { name: "heading-6", label: t("editor.contextMenu.heading6"), shortcutId: "heading-6" },
        { divider: true, label: "" },
        { name: "paragraph", label: t("editor.contextMenu.paragraph"), shortcutId: "paragraph" },
      ],
    },
    {
      name: "insert",
      label: t("editor.contextMenu.insert"),
      icon: ICONS.plus,
      submenu: [
        { name: "upload", label: t("editor.contextMenu.image"), shortcutId: null, icon: ICONS.image },
        { name: "hr", label: t("editor.contextMenu.horizontalRule"), shortcutId: "hr", icon: ICONS.minus },
        { name: "table", label: t("editor.contextMenu.table"), shortcutId: "table", icon: ICONS.table },
        { name: "code", label: t("editor.contextMenu.codeBlock"), shortcutId: "code-block", icon: ICONS.codeBlock },
        { name: "math", label: t("editor.contextMenu.mathBlock"), shortcutId: null, icon: ICONS.math },
        { name: "toc", label: t("editor.contextMenu.toc"), shortcutId: null, icon: ICONS.toc },
        { divider: true, label: "" },
        { name: "wiki-link", label: t("editor.contextMenu.wikiLink"), shortcutId: null, icon: ICONS.wikiLink },
      ],
    },
  ];
}

function getShortcutLabel(shortcutId: string | null, shortcuts: ShortcutItem[]): string {
  if (!shortcutId) return "";
  const item = shortcuts.find((s) => s.id === shortcutId);
  return item ? formatShortcutDisplay(item.keys) : "";
}

export function ContextMenu({ editor, position, onClose }: ContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string | null>(null);
  const [submenuPos, setSubmenuPos] = useState<{ x: number; y: number } | null>(null);
  const [shortcuts, setShortcuts] = useState<ShortcutItem[]>([]);

  // 荧光笔的当前颜色 / 模式与编辑器共用同一份模块级状态（Editor/highlighter.ts）
  const highlighterColor = useSyncExternalStore(subscribeHighlighter, getHighlighterColor);
  const highlighterMode = useSyncExternalStore(subscribeHighlighter, getHighlighterMode);

  const iconRows = createIconRows(t);

  // 「高亮/ 荧光笔」子菜单：模式开关+ 6 色调色板（带勾选态）+ 清除
  const highlightSubmenu = useMemo<SubmenuItem>(() => ({
    name: "highlight",
    label: t("editor.contextMenu.highlight"),
    icon: ICONS.pen,
    submenu: [
      {
        name: "highlighter-mode",
        label: t("editor.contextMenu.highlighterMode"),
        shortcutId: null,
        icon: ICONS.pen,
        checked: highlighterMode,
      },
      { divider: true, label: "" },
      ...HIGHLIGHT_COLORS.map((c) => ({
        name: `${HIGHLIGHT_COLOR_PREFIX}${c.color}`,
        label: t(c.labelKey),
        shortcutId: null,
        swatch: c.color,
        checked: c.color.toLowerCase() === highlighterColor.toLowerCase(),
      })),
      { divider: true, label: "" },
      {
        name: "highlight-clear",
        label: t("editor.contextMenu.clearHighlight"),
        shortcutId: null,
        icon: ICONS.eraser,
      },
    ],
  }), [t, highlighterColor, highlighterMode]);

  // 「文字颜色」子菜单：6 色（中间调，明暗主题都能读）+ 默认色
  const textColorSubmenu = useMemo<SubmenuItem>(() => ({
    name: "text-color",
    label: t("editor.contextMenu.textColor"),
    icon: ICONS.textColor,
    submenu: [
      ...TEXT_COLORS.map((c) => ({
        name: `${TEXT_COLOR_PREFIX}${c.color}`,
        label: t(c.labelKey),
        shortcutId: null,
        swatch: c.color,
      })),
      { divider: true, label: "" },
      {
        name: "text-color-clear",
        label: t("editor.contextMenu.defaultColor"),
        shortcutId: null,
        icon: ICONS.eraser,
      },
    ],
  }), [t]);

  const submenuItems = useMemo(
    () => [...createSubmenuItems(t), highlightSubmenu, textColorSubmenu],
    [t, highlightSubmenu, textColorSubmenu],
  );

  useEffect(() => {
    if (position) {
      setShortcuts(loadShortcuts());
    }
  }, [position]);

  // 子菜单渲染后校正位置
  useEffect(() => {
    if (activeSubmenu && submenuRef.current && submenuPos) {
      const el = submenuRef.current;
      const rect = el.getBoundingClientRect();
      const GAP = 4;
      let { x, y } = submenuPos;

      if (x + rect.width > window.innerWidth - GAP) {
        x = window.innerWidth - rect.width - GAP;
      }
      if (x < GAP) x = GAP;
      if (y + rect.height > window.innerHeight - GAP) {
        y = window.innerHeight - rect.height - GAP;
      }
      if (y < GAP) y = GAP;

      if (x !== submenuPos.x || y !== submenuPos.y) {
        setSubmenuPos({ x, y });
      }
    }
  }, [activeSubmenu, submenuPos]);

  const handleClickOutside = useCallback((e: MouseEvent) => {
    if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
      onClose();
      setActiveSubmenu(null);
    }
  }, [onClose]);

  useEffect(() => {
    if (position) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [position, handleClickOutside]);

  /**
   * 菜单打开时，按任意键都收起它（Esc 也在内）：菜单是浮层，
   * 按了键它还赖在屏幕上会挡住正文。
   * 用捕获阶段，抢在编辑器 keymap 与 App 级快捷键之前。
   */
  useEffect(() => {
    if (!position) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Esc 是「取消」语义；焦点在菜单里时 Enter/空格会「再次激活」那个按钮，
      // 这两种情况要吞掉这次按键，否则菜单刚关就被自己的按钮又点开。
      // 其它按键只收菜单、不拦截 —— 输入的字符照常进入编辑器。
      const focusInMenu = !!menuRef.current?.contains(e.target as Node);
      if (e.key === "Escape" || (focusInMenu && (e.key === "Enter" || e.key === " "))) {
        e.preventDefault();
        e.stopPropagation();
      }
      // 收起菜单的同时取消选择：这个菜单是「对选区做事」的浮层，
      // 只把菜单收掉、留下一整片蓝色选区，会让人以为还没退出选择状态。
      // 落点取选区 head（鼠标松开的那一端），接着敲的键就在这个位置生效。
      //
      // 但有两类按键要放过，否则会把「对选区做事」的操作打断：
      //   1) Ctrl/Cmd/Alt 组合键 —— Ctrl+C 要复制这段选区、Ctrl+B 要加粗它，
      //      先把选区收掉的话，复制就拿不到东西了；
      //   2) 单独按修饰键 —— 用户往往正要 Shift+点击去扩展选区。
      const modifierOnly = ["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock"].includes(e.key);
      const isShortcut = e.ctrlKey || e.metaKey || e.altKey;
      if (!modifierOnly && !isShortcut) collapseSelection();
      onClose();
      setActiveSubmenu(null);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [position, onClose, editor]);

  useEffect(() => {
    if (position && menuRef.current) {
      const menu = menuRef.current;
      const rect = menu.getBoundingClientRect();
      const GAP = 4;

      let left = position.x;
      // 划选弹出时浮在选区上方（锚点是选区左上角）；右键时锚点就是鼠标落点、向右下展开
      let top = position.placement === "above" ? position.y - rect.height - 8 : position.y;

      if (left + rect.width > window.innerWidth - GAP) {
        left = position.x - rect.width;
      }
      if (position.placement !== "above" && top + rect.height > window.innerHeight - GAP) {
        top = position.y - rect.height;
      }
      if (left < GAP) left = GAP;
      if (top < GAP) top = GAP;

      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
  }, [position]);

  const handleItemClick = (name: string) => {
    if (!editor) return;
    executeCommand(name, editor);
    onClose();
    setActiveSubmenu(null);
  };

  /**
   * 把选区折叠到 head（鼠标松开的那一端）：用于「用完就收」的场景。
   * 表格单元格选区等特殊情形取不到合法文本位置，保持原样即可。
   */
  const collapseSelection = () => {
    if (!editor?.isEditable) return;
    const { selection } = editor.state;
    if (selection.empty) return;
    try {
      editor.commands.setTextSelection(selection.head);
    } catch {
      /* 特殊选区：不处理 */
    }
  };

  /**
   * 荧光笔调色板：选中颜色即设为「当前颜色」，并在有选区时立刻给选区内文字上色。
   * 没有选区时只记住颜色，配合「荧光笔模式」使用。
   *
   * 上完色要顺手收掉选区：浏览器用蓝色覆盖层画选中区域，选区还在就看不见刚上的颜色。
   * （加粗 / 斜体这类不遮内容，所以那类操作保持选中，方便连着套多个格式。）
   */
  const handleHighlightColor = (color: string) => {
    setHighlighterColor(color);
    if (editor && !editor.state.selection.empty) {
      editor.chain().focus().setHighlight({ color }).run();
    }
    collapseSelection();
    onClose();
    setActiveSubmenu(null);
  };

  /**
   * 文字颜色：直接给选区上色。
   * 没有选区时 setMark 会记进 storedMarks，接着输入的文字就用这个颜色（符合预期）。
   * 同样在上色后收掉选区，否则看不到颜色效果。
   */
  const handleTextColor = (color: string) => {
    if (editor) {
      editor.chain().focus().setTextColor(color).run();
    }
    collapseSelection();
    onClose();
    setActiveSubmenu(null);
  };

  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  const scheduleClose = () => {
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      setActiveSubmenu(null);
      setSubmenuPos(null);
      closeTimerRef.current = null;
    }, 200);
  };

  const handleSubmenuEnter = (e: React.MouseEvent, item: any) => {
    if (!item.submenu) return;
    clearCloseTimer();
    const wrapper = e.currentTarget as HTMLElement;
    const rect = wrapper.getBoundingClientRect();
    setActiveSubmenu(item.name || null);

    const GAP = 4;
    const submenuWidth = 200;
    const submenuHeight = item.submenu.length * 32 + 8;

    let x = rect.right + GAP;
    let y = rect.top;

    if (x + submenuWidth > window.innerWidth - GAP) {
      x = rect.left - submenuWidth - GAP;
    }
    if (y + submenuHeight > window.innerHeight - GAP) {
      y = window.innerHeight - submenuHeight - GAP;
    }
    if (y < GAP) y = GAP;

    setSubmenuPos({ x, y });
  };

  const handleSubmenuLeave = () => {
    scheduleClose();
  };

  const handleSubmenuPanelEnter = () => {
    clearCloseTimer();
  };

  const handleSubmenuPanelLeave = () => {
    scheduleClose();
  };

  useEffect(() => {
    return () => clearCloseTimer();
  }, []);

  if (!position) return null;

  return (
    <div
      ref={menuRef}
      className="editor-context-menu"
      // 点菜单里的任何东西都不把焦点从编辑器抢走（按钮默认会抢）：
      // 这样按任意键收起菜单后继续打字，字符仍然落在编辑器里
      onMouseDown={(e) => e.preventDefault()}
      style={{ left: position.x, top: position.y }}
    >
      {/* 三行图标按钮 */}
      {iconRows.map((row, rowIdx) => (
        <div key={`row-${rowIdx}`} className="context-menu-icon-row">
          {row.map((item) => {
            const shortcutLabel = getShortcutLabel(item.shortcutId, shortcuts);
            const tooltip = shortcutLabel ? `${item.label} (${shortcutLabel})` : item.label;
            return (
              <div
                key={item.name}
                className="context-menu-icon-btn-wrapper"
                data-tooltip={tooltip}
              >
                <button
                  className="context-menu-icon-btn"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    handleItemClick(item.name);
                  }}
                >
                  {item.icon}
                </button>
              </div>
            );
          })}
        </div>
      ))}

      <div className="context-menu-divider" />

      {/* 标题和插入子菜单 */}
      {submenuItems.map((item) => (
        <div
          key={item.name}
          className="context-menu-item-wrapper"
          onMouseEnter={(e) => handleSubmenuEnter(e, item)}
          onMouseLeave={handleSubmenuLeave}
        >
          <button className="context-menu-item">
            <span className="context-menu-icon">{item.icon}</span>
            <span className="context-menu-label">{item.label}</span>
            <span className="context-menu-arrow">{ICONS.chevronRight}</span>
          </button>

          {activeSubmenu === item.name && submenuPos && (
            <div
              ref={submenuRef}
              className="context-menu-submenu"
              style={{ left: submenuPos.x, top: submenuPos.y }}
              onMouseEnter={handleSubmenuPanelEnter}
              onMouseLeave={handleSubmenuPanelLeave}
            >
              {item.submenu!.map((sub, subIdx: number) => {
                if ('divider' in sub && sub.divider) {
                  return <div key={`sub-div-${subIdx}`} className="context-menu-divider" />;
                }
                const subItem = sub as SubmenuEntry;
                return (
                  <button
                    key={subItem.name}
                    className="context-menu-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      if (subItem.name?.startsWith(HIGHLIGHT_COLOR_PREFIX)) {
                        handleHighlightColor(subItem.name.slice(HIGHLIGHT_COLOR_PREFIX.length));
                        return;
                      }
                      if (subItem.name?.startsWith(TEXT_COLOR_PREFIX)) {
                        handleTextColor(subItem.name.slice(TEXT_COLOR_PREFIX.length));
                        return;
                      }
                      // 「清除高亮 / 默认色」也直接作用在文字外观上：
                      // 清完同样收掉选区，否则蓝色覆盖层还盖着，看不出已经清掉
                      if (subItem.name === "highlight-clear" || subItem.name === "text-color-clear") {
                        handleItemClick(subItem.name);
                        collapseSelection();
                        return;
                      }
                      if (subItem.name) handleItemClick(subItem.name);
                    }}
                  >
                    {subItem.swatch ? (
                      <span className="context-menu-swatch" style={{ background: subItem.swatch }} />
                    ) : subItem.icon ? (
                      <span className="context-menu-icon">{subItem.icon}</span>
                    ) : null}
                    <span className="context-menu-label">{subItem.label}</span>
                    {subItem.checked && <span className="context-menu-check">{ICONS.check}</span>}
                    {getShortcutLabel(subItem.shortcutId, shortcuts) && (
                      <span className="context-menu-shortcut">
                        {getShortcutLabel(subItem.shortcutId, shortcuts)}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

