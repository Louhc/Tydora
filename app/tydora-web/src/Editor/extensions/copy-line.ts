import { Extension } from "@tiptap/core";
import { Plugin } from "@tiptap/pm/state";

/**
 * 无选区时 Ctrl+C / Ctrl+X = 复制 / 剪切整行（VS Code 习惯）。
 *
 * IR（所见即所得）里没有"软换行"意义上的行，所以这里的"一行"取**光标所在的顶层块**
 * （段落 / 标题 / 列表项 / 引用等），复制时在末尾补一个换行，符合"复制整行"的预期。
 * 剪切的语义也对齐 VS Code：整块删掉，后面的内容上移；若它是文档里唯一一块，
 * 则只清空其内容 —— 否则文档会变空、ProseMirror 不允许。
 *
 * 有选区时一律返回 false，交回浏览器/系统的默认复制剪切行为。
 * （Vim 模式另有 yy / dd；这里只在系统剪贴板快捷键上补齐"整行"语义。）
 */
export const CopyLineOnEmptySelection = Extension.create({
  name: "copyLineOnEmptySelection",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        props: {
          handleKeyDown(view, event) {
            const mod = event.ctrlKey || event.metaKey;
            if (!mod || event.altKey || event.shiftKey) return false;
            const key = event.key.toLowerCase();
            const isCopy = key === "c";
            const isCut = key === "x";
            if (!isCopy && !isCut) return false;

            const sel = view.state.selection;
            if (!sel.empty) return false; // 有选区：交回默认行为
            const { $from } = sel;
            const depth = $from.depth;
            if (depth < 1) return false; // 不在任何文本块里（极少见）

            const start = $from.start(depth);
            const end = $from.end(depth);
            const text = `${view.state.doc.textBetween(start, end, "\n")}\n`;
            try {
              void navigator.clipboard.writeText(text);
            } catch {
              return false; // 剪贴板不可用就别吞掉这次按键
            }

            if (isCut) {
              const tr = view.state.tr;
              if (view.state.doc.childCount > 1) tr.delete($from.before(depth), $from.after(depth));
              else tr.delete(start, end);
              view.dispatch(tr);
            }
            event.preventDefault();
            return true;
          },
        },
      }),
    ];
  },
});
