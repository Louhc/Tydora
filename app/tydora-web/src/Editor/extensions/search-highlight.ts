import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    searchHighlight: {
      setSearchHighlight: (query: string) => ReturnType;
      clearSearchHighlight: () => ReturnType;
      /** 标记"当前命中"（查找框里按回车/点下一个时用） */
      setSearchHighlightCurrent: (from: number, to: number) => ReturnType;
    };
  }
}

interface SearchHighlightStorage {
  query: string;
  /**
   * "当前命中"的范围。
   *
   * 为什么需要它：查找框保持焦点时，**焦点移入 <input> 会清空文档里的原生选区**
   *（浏览器既有行为）—— 于是"按回车/点下一个"跳到的那个匹配看不到选中效果，
   * 而点按钮时却正常（按钮不会清空选区）。所以不给焦点较劲，改为用一条装饰
   * 把当前命中单独画出来（VS Code 的做法）。
   */
  current: { from: number; to: number } | null;
}

export const SearchHighlight = Extension.create<SearchHighlightStorage>({
  name: "searchHighlight",

  addStorage() {
    return { query: "", current: null };
  },

  addCommands() {
    return {
      setSearchHighlight: (query) => ({ editor }) => {
        // 保留 current（切换查询时由下面的命令/清空逻辑负责重置）
        (editor.storage as Record<string, any>).searchHighlight = {
          ...((editor.storage as Record<string, any>).searchHighlight ?? {}),
          query,
          current: null,
        };
        // 触发重新渲染
        try {
          if (!editor.isDestroyed && editor.view) {
            editor.view.dispatch(editor.view.state.tr.setMeta("forceUpdate", true));
          }
        } catch {
          /* 视图未就绪/已销毁时忽略 */
        }
        return true;
      },
      clearSearchHighlight: () => ({ editor }) => {
        (editor.storage as Record<string, any>).searchHighlight = { query: "", current: null };
        try {
          if (!editor.isDestroyed && editor.view) {
            editor.view.dispatch(editor.view.state.tr.setMeta("forceUpdate", true));
          }
        } catch {
          /* 视图未就绪/已销毁时忽略 */
        }
        return true;
      },
      /** 标记"当前命中"：只更新 storage 里的 current 并重画装饰（不动查询） */
      setSearchHighlightCurrent: (from: number, to: number) => ({ editor }) => {
        (editor.storage as Record<string, any>).searchHighlight = {
          ...((editor.storage as Record<string, any>).searchHighlight ?? {}),
          current: { from, to },
        };
        try {
          if (!editor.isDestroyed && editor.view) {
            editor.view.dispatch(editor.view.state.tr.setMeta("forceUpdate", true));
          }
        } catch {
          /* 视图未就绪/已销毁时忽略 */
        }
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    const extension = this;

    const plugin = new Plugin({
      key: new PluginKey("searchHighlight"),
      state: {
        init: () => DecorationSet.empty,
        apply: (tr, _old, state) => {
          // 检查是否是 forceUpdate
          if (tr.getMeta("forceUpdate") || tr.docChanged) {
            const query = (extension.editor?.storage as Record<string, any>)?.searchHighlight?.query;
            if (!query) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            const doc = state.doc;

            doc.descendants((node, pos) => {
              /**
               * 注音节点：它是叶子（非文本），文字存在属性里，所以上面的文本遍历看不到它。
               * 这里按 base 命中就加**节点装饰** —— 否则 Ctrl+F 能计数、能跳过去，却没有高亮。
               */
              if (node.type.name === "ruby") {
                const base = String(node.attrs.base ?? "");
                if (base && base.toLowerCase().includes(query.toLowerCase())) {
                  decorations.push(
                    Decoration.node(pos, pos + node.nodeSize, { class: "search-highlight" }),
                  );
                }
                return;
              }
              if (!node.isText) return;

              const text = node.text || "";
              const lowerText = text.toLowerCase();
              const lowerQuery = query.toLowerCase();

              let index = 0;
              while (index < text.length) {
                const found = lowerText.indexOf(lowerQuery, index);
                if (found === -1) break;

                decorations.push(
                  Decoration.inline(pos + found, pos + found + query.length, {
                    class: "search-highlight",
                  })
                );

                index = found + 1;
              }
            });

            /**
             * 当前命中：单独一条装饰，样式更醒目。
             * 这样即使焦点在查找框（原生选区被清空），也能一眼看到"跳到哪了"。
             */
            const current = (extension.editor?.storage as Record<string, any>)?.searchHighlight?.current;
            if (current && typeof current.from === "number" && typeof current.to === "number") {
              decorations.push(
                Decoration.inline(current.from, current.to, { class: "search-highlight-current" }),
              );
            }

            return DecorationSet.create(doc, decorations);
          }
          return _old;
        },
      },
      props: {
        decorations(state) {
          return this.getState(state);
        },
      },
    });

    return [plugin];
  },
});
