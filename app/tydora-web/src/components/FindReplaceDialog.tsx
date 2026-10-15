import { useState, useEffect, useCallback, useRef } from "react";
import type { EditorHandle, SearchMatch } from "../Editor/types";
import { useDebounce } from "../hooks/useDebounce";
import "./FindReplaceDialog.css";

interface FindReplaceDialogProps {
  editorHandle: EditorHandle | null;
  mode: "find" | "replace";
  onClose: () => void;
  /** 打开时预填的查找内容：通常是编辑器里选中的文本（纯文本、无格式） */
  initialQuery?: string;
  /** 是否展开替换行（VS Code 那样默认收起，由左侧箭头切换；Ctrl+H 打开时展开） */
  showReplaceRow?: boolean;
  /** 每次"打开查找"自增：已经打开时再按 Ctrl+F 也重新聚焦并全选查找框 */
  focusToken?: number;
  /** 当前文档内容：用于在编辑 / 撤销重做 / 外部更新后重算匹配数（如 1/5 要跟着变） */
  docContent?: string;
}

const DEBOUNCE_DELAY = 180; // ms — 防抖延迟，用户停止输入 180ms 后才执行搜索

export default function FindReplaceDialog({
  editorHandle,
  mode: initialMode,
  onClose,
  initialQuery = "",
  showReplaceRow = false,
  focusToken = 0,
  docContent,
}: FindReplaceDialogProps) {
  const [query, setQuery] = useState(initialQuery);
  const debouncedQuery = useDebounce(query, DEBOUNCE_DELAY);
  const [replaceText, setReplaceText] = useState("");
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  // 默认收起替换行（与 VS Code 一致），点左侧箭头展开
  const [showReplace, setShowReplace] = useState(showReplaceRow);
  const findInputRef = useRef<HTMLInputElement>(null);
  /** 替换输入框：回车时用来判断焦点到底在查找框还是替换框里 */
  const replaceInputRef = useRef<HTMLInputElement>(null);

  /**
   * 关闭动画：父组件是靠条件渲染挂载本组件的，直接调 onClose 会立刻卸载、没有淡出机会。
   * 所以先挂 .closing 播完"向上滑出"，再真正 onClose。时长与 CSS 里的动画保持一致。
   */
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<number | null>(null);
  const requestClose = useCallback(() => {
    if (closeTimerRef.current != null) return;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      editorHandle?.clearHighlight();
      onClose();
    }, 100);
  }, [editorHandle, onClose]);
  useEffect(
    () => () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    },
    [],
  );

  // Ctrl+H 打开时展开替换行；用户之后仍可自行收起
  useEffect(() => {
    if (showReplaceRow) setShowReplace(true);
  }, [showReplaceRow]);

  // 已经打开时再按 Ctrl+F / Ctrl+H：重新聚焦并全选，便于直接覆盖输入。
  // 用自增的 token 而不是 initialQuery 变化来驱动 —— 选中的文本与上次相同时
  // setState 会被 React 判为无变化，光靠 initialQuery 是触发不了的。
  useEffect(() => {
    if (focusToken === 0) return;
    const timer = setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 50);
    return () => clearTimeout(timer);
  }, [focusToken]);

  // 再次按 Ctrl+F / Ctrl+H（对话框已开着）时，用当前选区刷新查找内容。
  // 只在非空时覆盖，避免"没选中就按快捷键"把用户已经输入的内容清掉。
  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
  }, [initialQuery]);

  // Auto-focus find input on mount / mode change
  useEffect(() => {
    // 延迟聚焦，确保编辑器的 selectMatch 调用不会抢走焦点
    const timer = setTimeout(() => {
      findInputRef.current?.focus();
    }, 50);
    return () => clearTimeout(timer);
  }, [initialMode]);

  // Perform search when query changes
  const doSearch = useCallback((q: string) => {
    if (!editorHandle || !q) {
      setMatches([]);
      setCurrentIndex(-1);
      editorHandle?.clearHighlight();
      return;
    }
    const results = editorHandle.findMatches(q);
    setMatches(results);
    if (results.length > 0) {
      setCurrentIndex(0);
      editorHandle.selectMatch(results[0].from, results[0].to);
      editorHandle.highlightSearch(q);
    } else {
      setCurrentIndex(-1);
      editorHandle.clearHighlight();
    }
  }, [editorHandle]);

  // Perform search when debounced query changes — 防抖避免每次按键都扫描全文
  useEffect(() => {    // 空查询立即清空高亮（无延迟，保证即时响应）
    if (!debouncedQuery) {
      editorHandle?.clearHighlight();
      setMatches([]);
      setCurrentIndex(-1);
      return;
    }
    doSearch(debouncedQuery);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQuery]);

  /**
   * 文档内容变化（编辑、Ctrl+Z 撤销 / 重做、外部修改）时**重算匹配**。
   *
   * 原来只有查询词变化才会重算，所以查找框里的 "1/5" 会停在打开那一刻的旧结果：
   * 撤销一次后匹配数其实变了，数字却不动。这里只更新 matches / currentIndex，
   * **不**调用 selectAndScroll —— 免得和"查询词变化"那条路径抢着滚动。
   */
  useEffect(() => {
    if (!editorHandle || !debouncedQuery) return;
    const fresh = editorHandle.findMatches(debouncedQuery);
    setMatches(fresh);
    setCurrentIndex((cur) => (fresh.length === 0 ? -1 : Math.min(Math.max(cur, 0), fresh.length - 1)));
  }, [docContent, editorHandle, debouncedQuery]);

  // Navigate to next match
  const goToNext = useCallback(() => {
    if (!editorHandle || matches.length === 0) return;
    // 导航前按当前文档重算匹配：搜索结果缓存的位置在文档变化后
    // （继续输入、外部更新、切换文件）会失效，避免命中过期位置
    const fresh = editorHandle.findMatches(query);
    if (fresh.length > 0) setMatches(fresh);
    const list = fresh.length > 0 ? fresh : matches;
    const next = (currentIndex + 1) % list.length;
    setCurrentIndex(next);
    /**
     * 焦点必须在 selectAndScroll **之前**取：它会把焦点交给编辑器，而编辑器一旦拿到焦点，
     * 下一次回车就会被 ProseMirror 先处理 —— 此时匹配文字处于选中态，回车=用段落分隔符
     * 替换选区，用户看到的就是"第二次回车把搜索到的文字删掉了"。
     * 所以这里记录并还回焦点（与 VS Code 一样：导航时焦点留在查找框）。
     */
    const focused = document.activeElement as HTMLElement | null;
    editorHandle.selectAndScroll(list[next].from, list[next].to);
    // 用装饰标出"当前命中"：焦点保持在查找框时原生选区会被清空，靠它给出可见反馈。
    // 传**原文偏移**——Ruby 展开/收起后插件按当前文档重算，不会错位。
    (editorHandle as any).setCurrentMatch?.(list[next].mdFrom, list[next].mdTo);
    if (focused && (focused === findInputRef.current || focused === replaceInputRef.current)) {
      focused.focus();
      // 再补一次：selectAndScroll 若把焦点交给编辑器（有些实现是在下一帧做的），
      // 同步 focus 会被它覆盖，于是下一次回车仍被 ProseMirror 先处理、吃掉选中的匹配文字。
      requestAnimationFrame(() => {
        if (document.activeElement !== focused) focused.focus();
      });
    }
  }, [matches, currentIndex, editorHandle, query]);

  // Navigate to previous match
  const goToPrev = useCallback(() => {
    if (!editorHandle || matches.length === 0) return;
    const fresh = editorHandle.findMatches(query);
    if (fresh.length > 0) setMatches(fresh);
    const list = fresh.length > 0 ? fresh : matches;
    const prev = (currentIndex - 1 + list.length) % list.length;
    setCurrentIndex(prev);
    const focused = document.activeElement as HTMLElement | null;
    editorHandle.selectAndScroll(list[prev].from, list[prev].to);
    // 同上：当前命中用装饰标记（焦点留在查找框），参数是原文偏移
    (editorHandle as any).setCurrentMatch?.(list[prev].mdFrom, list[prev].mdTo);
    if (focused && (focused === findInputRef.current || focused === replaceInputRef.current)) {
      focused.focus();
      // 再补一次：selectAndScroll 若把焦点交给编辑器（有些实现是在下一帧做的），
      // 同步 focus 会被它覆盖，于是下一次回车仍被 ProseMirror 先处理、吃掉选中的匹配文字。
      requestAnimationFrame(() => {
        if (document.activeElement !== focused) focused.focus();
      });
    }
  }, [matches, currentIndex, editorHandle, query]);

  // Replace current match
  const replaceCurrent = useCallback(() => {
    if (!editorHandle || matches.length === 0 || currentIndex < 0 || currentIndex >= matches.length) return;
    const match = matches[currentIndex];
    /**
     * 替换用**Markdown 原文偏移**，等价于"在 SV 里改文本"：
     * 命中落在注音字面量内部时（rt 里的字），PM 侧只能整块高亮节点，
     * 但替换必须只动命中那几个字，所以交给编辑器在原文上替换再写回。
     */
    editorHandle.replaceMatches([{ mdFrom: match.mdFrom, mdTo: match.mdTo }], replaceText);
    // Refresh matches after replace
    const newResults = editorHandle.findMatches(query);
    setMatches(newResults);
    if (newResults.length > 0) {
      const newIdx = Math.min(currentIndex, newResults.length - 1);
      setCurrentIndex(newIdx);
      // 同样在 selectAndScroll 之前记住焦点，之后还回去（否则下一次回车被编辑器吃掉）
      const focused = document.activeElement as HTMLElement | null;
      editorHandle.selectAndScroll(newResults[newIdx].from, newResults[newIdx].to);
      if (focused && (focused === findInputRef.current || focused === replaceInputRef.current)) {
      focused.focus();
      // 再补一次：selectAndScroll 若把焦点交给编辑器（有些实现是在下一帧做的），
      // 同步 focus 会被它覆盖，于是下一次回车仍被 ProseMirror 先处理、吃掉选中的匹配文字。
      requestAnimationFrame(() => {
        if (document.activeElement !== focused) focused.focus();
      });
    }
    } else {
      setCurrentIndex(-1);
      editorHandle.clearHighlight();
    }
  }, [editorHandle, matches, currentIndex, replaceText, query]);

  // Replace all matches
  const replaceAll = useCallback(() => {
    if (!editorHandle || matches.length === 0) return;
    // 全部替换同样在 Markdown 原文上一次性完成（从后往前替换，偏移不会互相打乱）
    editorHandle.replaceMatches(
      matches.map((m) => ({ mdFrom: m.mdFrom, mdTo: m.mdTo })),
      replaceText,
    );
    setMatches([]);
    setCurrentIndex(-1);
    editorHandle.clearHighlight();
  }, [editorHandle, matches, replaceText]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const target = e.target as HTMLElement | null;
        /**
         * 只有焦点在**替换输入框**里时回车才执行替换；在查找框里一律"跳到下一个匹配"。
         *
         * 原判据是 `target.closest('.find-replace-row:last-child')` —— 按"行的位置"判断，
         * 而替换行收起时查找行就成了唯一的行、也就成了 :last-child，于是在查找框里按回车
         * 会执行 replaceCurrent()，替换内容为空 → 直接把匹配到的文字删掉。
         */
        if (showReplace && replaceInputRef.current && target === replaceInputRef.current) {
          replaceCurrent();
        } else {
          goToNext();
        }
      } else if (e.key === "Escape") {
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [showReplace, replaceCurrent, goToNext, requestClose]);

  return (
    <div className={`find-replace-dialog${closing ? " closing" : ""}`}>
      <div className="find-replace-row">
        <button
          className={`find-replace-expand-btn${showReplace ? ' expanded' : ''}`}
          onClick={() => setShowReplace(v => !v)}
          title={showReplace ? "收起替换" : "展开替换"}
        >
          <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor">
            <path d="M6.03 3.72a.75.75 0 0 1 1.06 0l4.97 4.97a.75.75 0 0 1 0 1.06l-4.97 4.97a.75.75 0 1 1-1.06-1.06L10.47 8.5 6.03 4.78a.75.75 0 0 1 0-1.06Z"/>
          </svg>
        </button>
        <div className="find-replace-input-group">
          <svg className="find-replace-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M10.68 11.74a6 6 0 0 1-7.922-8.982 6 6 0 0 1 8.982 7.922l3.04 3.04a.749.749 0 0 1-.326 1.275.749.749 0 0 1-.734-.215ZM11.5 7a4.499 4.499 0 1 0-8.997 0A4.499 4.499 0 0 0 11.5 7Z"/>
          </svg>
          <input
            ref={findInputRef}
            className="find-replace-input"
            type="text"
            placeholder="查找..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <span className="find-replace-count">
              {matches.length > 0 ? `${currentIndex + 1}/${matches.length}` : "0/0"}
            </span>
          )}
        </div>
        <button
          className="find-replace-nav-btn"
          onClick={goToPrev}
          disabled={matches.length === 0}
          title="上一个匹配"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M3.47 7.78a.75.75 0 0 1 0-1.06l3.25-3.25a.75.75 0 0 1 1.06 1.06L5.06 7.25h7.69a.75.75 0 0 1 0 1.5H5.06l2.72 2.72a.75.75 0 1 1-1.06 1.06L3.47 8.28Z"/>
          </svg>
        </button>
        <button
          className="find-replace-nav-btn"
          onClick={goToNext}
          disabled={matches.length === 0}
          title="下一个匹配"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M12.53 8.22a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L10.94 8.75H3.25a.75.75 0 0 1 0-1.5h7.69L8.22 4.53a.75.75 0 1 1 1.06-1.06l3.25 3.25Z"/>
          </svg>
        </button>
        <button
          className="find-replace-close-btn"
          onClick={requestClose}
          title="关闭"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor">
            <path d="M3.72 3.72a.75.75 0 0 1 1.06 0L8 6.94l3.22-3.22a.75.75 0 1 1 1.06 1.06L9.06 8l3.22 3.22a.75.75 0 1 1-1.06 1.06L8 9.06l-3.22 3.22a.75.75 0 0 1-1.06-1.06L6.94 8 3.72 4.78a.75.75 0 0 1 0-1.06Z"/>
          </svg>
        </button>
      </div>

      {showReplace && (
        <div className="find-replace-row">
          <div className="find-replace-expand-spacer" />
          <div className="find-replace-input-group">
            <svg className="find-replace-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8 20V4"/>
              <polyline points="4 8 8 4 12 8"/>
              <path d="M16 4v16"/>
              <polyline points="12 16 16 20 20 16"/>
            </svg>
            <input
              ref={replaceInputRef}
              className="find-replace-input"
              type="text"
              placeholder="替换为..."
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
            />
          </div>
          <button
            className="find-replace-action-btn"
            onClick={replaceCurrent}
            disabled={matches.length === 0}
          >
            替换
          </button>
          <button
            className="find-replace-action-btn find-replace-all-btn"
            onClick={replaceAll}
            disabled={matches.length === 0}
          >
            全部替换
          </button>
        </div>
      )}
    </div>
  );
}
