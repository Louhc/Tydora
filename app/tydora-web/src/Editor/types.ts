import type { ThemeName } from "../themes";
import type { ImageSettings } from "../services";
import type { EditorSettings } from "../Settings";

export interface EditorHandle {
  getValue: () => string;
  setValue: (value: string) => void;
  /** 将焦点移入编辑器（IR 模式聚焦 TipTap view，SV 模式聚焦源码编辑器） */
  focus: () => void;
  insertTextAtCursor: (text: string) => void;
  replaceRangeWithWikiLink: (fromPos: number, noteName: string, heading?: string, display?: string) => void;
  replaceRangeWithTag: (fromPos: number, tag: string) => void;
  resize: () => void;
  highlightSearch: (query: string) => void;
  clearHighlight: () => void;
  executeCommand: (name: string) => void;
  scrollToHeading: (text: string, line: number) => void;
  /**
   * 跳到 Markdown 行号（侧栏搜索结果）。
   *
   * `path` 为目标文件路径：需要换文件时编辑器会把跳转排到内容装载后同帧执行，
   * 避免先渲染一次中间位置（顶部 / 上次光标）造成可见的两次跳动。
   */
  scrollToLine: (line: number, path?: string) => void;
  getCursorOffset: () => number;
  /** 把光标落到指定 Markdown 偏移（文档级撤销后恢复「编辑前的位置」用） */
  setCaretAtMarkdownOffset(mdOffset: number): void;
  /** 按内容字符串还原光标（撤销后优先用它；返回 false 表示无记录） */
  setCaretForMarkdown(md: string): boolean;
  /** 撤销/重做期间禁止写光标缓存（避免覆盖「编辑前的位置」） */
  suppressCaretCache(on: boolean): void;
  /** 最近一次内容变化之前的光标（App 立快照帧时取用） */
  getCaretBeforeLastChange(): { from: number; to: number } | null;
  /** 直接按 PM 坐标恢复光标（快照帧自带的光标） */
  setCaretAtPmPosition(pos: { from: number; to: number }): boolean;
  isSourceMode: () => boolean;
  /** 克隆当前渲染内容元素（用于导出）；源码模式下返回 null */
  getContentElement: () => HTMLElement | null;
  /** 全文搜索，返回所有匹配位置 */
  findMatches: (query: string) => SearchMatch[];
  /**
   * 选中指定范围并滚动到可见位置（不聚焦编辑器，用于搜索高亮）。
   *
   * ⚠️ 参数口径随模式变：**IR 是 ProseMirror 位置，SV 是 Markdown 原文偏移**
   *（SV 的查找/替换直接在源码上做，见 findMatches 的说明）。
   */
  selectMatch: (from: number, to: number) => void;
  /** 选中指定范围并滚动到可见位置（同时聚焦编辑器，用于导航跳转）。参数口径同 selectMatch */
  selectAndScroll: (from: number, to: number) => void;
  /**
   * 标记"当前命中"（查找框保持焦点时原生选区会被清空，需要单独一条装饰）。
   * 参数是 **Markdown 原文偏移** —— Ruby 展开/收起后按当前文档重算，不会错位。
   */
  setCurrentMatch?: (mdFrom: number, mdTo: number) => void;
  /**
   * 替换若干处命中。
   *
   * ⚠️ 用**Markdown 原文偏移**（不是 PM 位置）：替换一律在原文上做字符串替换
   *（SV 语义），IR 只负责把新原文写回编辑器重新渲染。
   * 之所以不能用 PM 区间：命中落在注音字面量内部时，PM 侧只能整块高亮节点，
   * 但替换必须只动命中那几个字，否则会把整个 `{{Ruby|漢字|かんじ}}` 换掉。
   */
  replaceMatches: (items: Array<{ mdFrom: number; mdTo: number }>, replacement: string) => void;
}

/**
 * 一处查找命中。
 *
 * `mdFrom/mdTo` 是 **Markdown 原文偏移**（匹配的真理源）；
 * `from/to` 是映射到显示位置的区间 —— IR 下是 ProseMirror 位置，SV 下与 md 相同。
 */
export interface SearchMatch {
  from: number;
  to: number;
  mdFrom: number;
  mdTo: number;
}

export type EditorMode = "ir" | "sv";

export const MODE_LABELS: Record<EditorMode, string> = {
  ir: "IR",
  sv: "SV",
};

export interface EditorProps {
  value: string;
  onChange: (value: string) => void;
  mode: EditorMode;
  theme: ThemeName;
  typewriterMode?: boolean;
  previewMaxWidth?: number;
  lineHeight?: number;
  paragraphSpacing?: number;
  codeLineHeight?: number;
  irLineNumbers?: boolean;
  editorSettings?: EditorSettings;
  imageSettings?: ImageSettings;
  currentFilePath?: string | null;
  activeVaultPath?: string | null;
  onWordCount?: (count: number) => void;
  /** 该编辑器是否为当前激活窗格（多窗格时只有激活窗格的 Leader 菜单才生效，避免重复触发） */
  active?: boolean;
}
