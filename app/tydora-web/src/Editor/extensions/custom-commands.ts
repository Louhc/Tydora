import type { Editor } from "@tiptap/core";
import { NodeSelection, TextSelection } from "prosemirror-state";
import type { Transaction } from "prosemirror-state";
import type { Node } from "prosemirror-model";
import { getHighlighterColor, toggleHighlighterMode } from "../highlighter";

/**
 * 收掉选区（折叠到原选区 head）。
 * 颜色 / 高亮是直接改变文字外观的操作，选区留着的话浏览器会用蓝色覆盖层盖住效果，
 * 等于「点了没反应」。只处理非折叠选区：折叠选区不能动，
 * 否则会清掉 setMark 记进 storedMarks 的待用颜色。
 */
function collapseSelection(editor: Editor) {
  if (!editor.isEditable) return;
  const { selection } = editor.state;
  if (selection.empty) return;
  try {
    editor.commands.setTextSelection(selection.head);
  } catch {
    /* 表格单元格等特殊选区取不到合法文本位置：保持原样 */
  }
}

/**
 * 收集一个块里所有「换行」的位置（相对块起点的偏移）。
 *
 * IR 里两种换行并存：代码块里的换行是文本里的 `\n`，段落里的换行是 hardBreak 节点。
 * 两者在 ProseMirror 里都只占 1 个位置，所以偏移可以直接当 PM 位置用。
 * 只数 text / hardBreak，像 wikiLink、tag 这种内联原子节点不参与计数，
 * 免得它们的 nodeSize 与 textContent 长度不一致时把位置算歪。
 */
function collectLineBreaks(parent: Node): number[] {
  const breaks: number[] = [];
  let offset = 0;
  parent.forEach((child) => {
    if (child.isText) {
      const text = child.text ?? "";
      for (let i = 0; i < text.length; i++) {
        if (text[i] === "\n") breaks.push(offset + i);
      }
    } else if (child.type.name === "hardBreak") {
      breaks.push(offset);
    }
    offset += child.nodeSize;
  });
  return breaks;
}

/**
 * 提交一次「删除行」的事务。
 *
 * 兜底：doc 的内容约束是 `block+`，真被删空会得到一个再也输不进字的文档。
 * 这时改用一个空段落占位 —— 与 CodeMirror 在单行文档上删完留下一空行一致。
 */
function dispatchLineDelete(editor: Editor, tr: Transaction): void {
  const { state, view } = editor;
  const next =
    tr.doc.childCount === 0
      ? state.tr.replaceWith(0, state.doc.content.size, state.schema.nodes.paragraph.create())
      : tr;
  view.dispatch(next.scrollIntoView());
  view.focus();
}

/**
 * 删除当前行 —— IR（即时渲染）模式的 deleteLine。
 *
 * SV 模式的删除行由 CodeMirror 自带 keymap（Ctrl+Shift+K）提供，IR 里没有「源码行」，
 * 行的粒度由块决定，所以按下面几档处理：
 *   1) 块里还有别的行（代码块里的 `\n`、段落里的 hardBreak）→ 只删这一行的文本，
 *      最后一行的换行要从前面吃，否则会多留一个空行；
 *   2) 表格单元格内 → 只清空这一段（删单元格 / 整行会把表格拆散）；
 *   3) 列表项内 → 删整项（SV 里 `- foo` 就是一行，删行即删项）；
 *      用 deleteRange：列表因此空了它会连列表一起收掉，不留非法空壳；
 *   4) 其余 → 删掉整个块节点（段落 / 标题 / 代码块…）。
 *      只清空内容会凭空多出一个空行，那不是「删掉这一行」。
 *      块是容器的独子时（blockquote / callout 里唯一的段落）退化成清空内容，
 *      否则容器会变成空壳，而它们的内容约束同样要求至少一个块。
 *
 * 有选区时按选区删（等于 Backspace 的语义）。
 */
export function deleteCurrentLine(editor: Editor): void {
  if (!editor.isEditable) return;
  try {
    const { state } = editor;
    const { selection } = state;
    const { $from, from, to } = selection;

    // 有选区：删选区（跨块时交给 deleteRange 收敛空掉的父容器）
    if (!selection.empty) {
      dispatchLineDelete(editor, state.tr.deleteRange(from, to));
      return;
    }

    // 整体选中的节点（图片 / 公式 / 表格 / 水平线…）：删掉它本身
    if (selection instanceof NodeSelection) {
      dispatchLineDelete(editor, state.tr.delete(from, to));
      return;
    }

    const depth = $from.depth; // 光标所在文本块
    const blockStart = $from.start(depth);
    const blockEnd = $from.end(depth);
    const breaks = collectLineBreaks($from.parent);

    // 1) 块内还有别的行
    if (breaks.length > 0) {
      const cursor = $from.pos - blockStart;
      let lineStart = 0;
      let lineEnd = $from.parent.content.size;
      for (const b of breaks) {
        if (b < cursor) lineStart = b + 1;
        else {
          lineEnd = b;
          break;
        }
      }
      let delFrom = blockStart + lineStart;
      let delTo = blockStart + lineEnd;
      if (delTo < blockEnd) delTo += 1; // 连行尾换行一起删
      else if (delFrom > blockStart) delFrom -= 1; // 最后一行：连行首换行一起删
      dispatchLineDelete(editor, state.tr.delete(delFrom, delTo));
      return;
    }

    // 2) 找「行块」：列表项 / 表格单元格要区别对待
    let itemDepth = -1;
    let cellDepth = -1;
    for (let d = depth; d > 0; d--) {
      const name = $from.node(d).type.name;
      if (name === "listItem" || name === "taskItem") {
        itemDepth = d;
        break;
      }
      if (name === "tableCell" || name === "tableHeader") {
        cellDepth = d;
        break;
      }
    }

    // 2a) 表格单元格：只清空这一段
    if (cellDepth > 0) {
      dispatchLineDelete(editor, state.tr.delete(blockStart, blockEnd));
      return;
    }

    // 2b) 列表项：删整项
    if (itemDepth > 0) {
      dispatchLineDelete(editor, state.tr.deleteRange($from.before(itemDepth), $from.after(itemDepth)));
      return;
    }

    // 3) 普通块
    const parentNode = $from.node(depth - 1);
    const insideDoc = parentNode.type.name === "doc";
    if (!insideDoc && parentNode.childCount === 1) {
      // 容器里的独子：删节点会留下空壳，只清空内容
      dispatchLineDelete(editor, state.tr.delete(blockStart, blockEnd));
      return;
    }
    dispatchLineDelete(editor, state.tr.delete($from.before(depth), $from.after(depth)));
  } catch {
    /* 视图未挂载 / 位置已失效：忽略这次按键，不能让快捷键把编辑器弄崩 */
  }
}

export function executeCommand(name: string, editor: Editor | null) {
  if (!editor) return;

  const chain = editor.chain().focus();

  // 标题
  if (name.startsWith("heading-")) {
    const level = parseInt(name.replace("heading-", "")) as 1 | 2 | 3 | 4 | 5 | 6;

    // 修复：粘贴的多行纯文本会被 hardBreak 节点连在同一个 paragraph 内，
    // 直接 toggleHeading 会把整段（含多行）都变成标题。
    // 这里在 toggleHeading 之前先把当前 paragraph 按 hardBreak 分裂为多个 paragraph，
    // 并把光标移到光标所在行对应的新 paragraph 末尾，使 toggleHeading 只作用于当前行。
    chain
      .command(({ tr, state }) => {
        const { selection, schema } = state;
        const $pos = selection.$from;

        // 仅在光标（collapsed selection）、位于 paragraph 内、含 hardBreak 时分裂
        let hasHardBreak = false;
        $pos.parent.content.forEach((n: Node) => {
          if (n.type.name === "hardBreak") hasHardBreak = true;
        });
        const needSplit =
          selection.empty &&
          $pos.parent.type.name === "paragraph" &&
          hasHardBreak;

        // 不满足条件时不修改任何事务，让后续 toggleHeading 按原行为执行
        if (!needSplit) return true;

        const paragraph = $pos.parent;
        const offset = $pos.parentOffset;

        // 按 hardBreak 把 paragraph content 分裂为多行，并计算光标所在行索引
        let lineIdx = 0;
        let pos = 0;
        const lines: Node[][] = [];
        let current: Node[] = [];

        paragraph.content.forEach((node: Node) => {
          if (node.type.name === "hardBreak") {
            // 光标在 hardBreak 之后（offset > pos）时属于下一行
            if (offset > pos) lineIdx++;
            lines.push(current);
            current = [];
          } else {
            current.push(node);
          }
          pos += node.nodeSize;
        });
        lines.push(current);

        // 为每行创建新的 paragraph 节点
        const newParagraphs: Node[] = lines.map((content) =>
          schema.nodes.paragraph.create(null, content)
        );

        const paraStart = $pos.before($pos.depth);
        const paraEnd = paraStart + paragraph.nodeSize;

        // 用新的 paragraphs 替换原 paragraph
        tr.replaceWith(paraStart, paraEnd, newParagraphs);

        // 计算光标所在行的新 paragraph 起止位置
        let targetParaStart = paraStart;
        for (let i = 0; i < lineIdx; i++) {
          targetParaStart += newParagraphs[i].nodeSize;
        }
        const targetParaEnd =
          targetParaStart + newParagraphs[lineIdx].nodeSize;

        // 把光标移到目标 paragraph 末尾（closing tag 之前）
        const $targetEnd = tr.doc.resolve(targetParaEnd - 1);
        tr.setSelection(TextSelection.near($targetEnd, -1));

        return true;
      })
      .toggleHeading({ level })
      .run();
    return;
  }

  switch (name) {
    case "paragraph":
      chain.setParagraph().run();
      break;

    // 行内格式
    case "bold":
      chain.toggleBold().run();
      break;
    case "italic":
      chain.toggleItalic().run();
      break;
    case "strike":
      chain.toggleStrike().run();
      break;
    case "inline-code":
      chain.toggleCode().run();
      break;
    case "highlight":
      // 用当前荧光笔颜色：再按一次同样的颜色会取消高亮（toggle 语义）
      chain.toggleHighlight({ color: getHighlighterColor() }).run();
      collapseSelection(editor);
      break;
    case "highlight-clear":
      chain.unsetHighlight().run();
      collapseSelection(editor);
      break;
    case "text-color-clear":
      chain.unsetTextColor().run();
      collapseSelection(editor);
      break;
    case "highlighter-mode":
      // 荧光笔模式（划选即上色）由 Editor/highlighter.ts 的模块级状态驱动，
      // TipTapEditor 订阅后自行挂/摘 mouseup 监听
      toggleHighlighterMode();
      break;
    case "link": {
      const sel = window.getSelection();
      const defaultText = sel?.toString() || "";
      // 触发弹窗事件，让 TipTapEditor 组件显示 LinkDialog
      window.dispatchEvent(new CustomEvent("link-dialog-open", {
        detail: { defaultText }
      }));
      break;
    }

    // 块级格式
    case "quote":
      chain.toggleBlockquote().run();
      break;
    case "list":
      chain.toggleBulletList().run();
      break;
    case "ordered-list":
      chain.toggleOrderedList().run();
      break;
    case "check":
      chain.toggleTaskList().run();
      break;
    case "indent":
      chain.sinkListItem("listItem").run();
      break;
    case "outdent":
      chain.liftListItem("listItem").run();
      break;
    case "task-toggle": {
      const { state } = editor;
      const { from } = state.selection;
      const node = state.doc.nodeAt(from);
      if (node && node.type.name === "taskItem") {
        const checked = node.attrs.checked;
        editor.chain().focus().command(({ tr }) => {
          tr.setNodeMarkup(from, undefined, { checked: !checked });
          return true;
        }).run();
      }
      break;
    }
    case "code":
      chain.toggleCodeBlock().run();
      break;
    case "hr":
      chain.setHorizontalRule().run();
      break;

    // 表格
    case "table":
      chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
      break;
    case "table-row-above":
      chain.addRowBefore().run();
      break;
    case "table-row-below":
      chain.addRowAfter().run();
      break;
    case "table-col-left":
      chain.addColumnBefore().run();
      break;
    case "table-col-right":
      chain.addColumnAfter().run();
      break;
    case "table-row-delete":
      chain.deleteRow().run();
      break;
    case "table-col-delete":
      chain.deleteColumn().run();
      break;
    case "table-align-left":
      editor.chain().focus().command(({ tr, state }) => {
        const { $from } = state.selection;
        const cell = $from.node(-1);
        if (cell && (cell.type.name === "tableCell" || cell.type.name === "tableHeader")) {
          tr.setNodeMarkup($from.before(-1), undefined, { ...cell.attrs, textAlign: "left" });
          return true;
        }
        return false;
      }).run();
      break;
    case "table-align-center":
      editor.chain().focus().command(({ tr, state }) => {
        const { $from } = state.selection;
        const cell = $from.node(-1);
        if (cell && (cell.type.name === "tableCell" || cell.type.name === "tableHeader")) {
          tr.setNodeMarkup($from.before(-1), undefined, { ...cell.attrs, textAlign: "center" });
          return true;
        }
        return false;
      }).run();
      break;
    case "table-align-right":
      editor.chain().focus().command(({ tr, state }) => {
        const { $from } = state.selection;
        const cell = $from.node(-1);
        if (cell && (cell.type.name === "tableCell" || cell.type.name === "tableHeader")) {
          tr.setNodeMarkup($from.before(-1), undefined, { ...cell.attrs, textAlign: "right" });
          return true;
        }
        return false;
      }).run();
      break;

    // 内容目录：插入 [TOC] 节点（IR 模式下由 toc 扩展的 NodeView 渲染真实目录）
    case "toc":
      chain.insertContent({ type: "toc" }).run();
      break;

    // 编辑
    case "undo":
      chain.undo().run();
      break;
    case "redo":
      chain.redo().run();
      break;
    // 删除行：需要按块结构自己建事务，不走上面的 chain（见函数注释）
    case "delete-line":
      deleteCurrentLine(editor);
      break;

    // 其他
    case "footnotes":
      chain.insertContent("[^1]: ").run();
      break;
    case "math": {
      // 打开公式编辑弹窗（含实时预览），确认后插入块级公式
      window.dispatchEvent(
        new CustomEvent("math-dialog-open", {
          detail: { latex: "", block: true },
        })
      );
      break;
    }
    case "wiki-link": {
      const { from } = editor.state.selection;
      chain.insertContent("[[").run();
      // 手动触发 WikiLink 自动补全
      // from 是 [[ 插入前的位置，即 [[ 的起始位置
      let screenPos: { x: number; y: number } | null = null;
      try {
        const coords = editor.view.coordsAtPos(from);
        if (coords) {
          screenPos = { x: coords.left, y: coords.bottom };
        }
      } catch {}
      window.dispatchEvent(new CustomEvent("wiki-link-trigger", {
        detail: {
          query: "",
          editorPosition: from,
          screenPosition: screenPos,
        }
      }));
      break;
    }

    // 剪贴板
    case "cut":
      document.execCommand("cut");
      break;
    case "copy":
      document.execCommand("copy");
      break;
    case "paste":
      document.execCommand("paste");
      break;
    case "delete":
      chain.deleteSelection().run();
      break;

    // 上传图像
    case "upload": {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.multiple = true;
      input.onchange = async () => {
        const files = input.files;
        if (!files) return;
        for (const file of Array.from(files)) {
          // 触发自定义事件让父组件处理
          window.dispatchEvent(new CustomEvent("image-upload-file", {
            detail: { file }
          }));
        }
      };
      input.click();
      break;
    }
  }
}
