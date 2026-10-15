import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { findMarkdownMatches } from "../markdown-search";
import { getCachedPositionMap, inlineLeafRangeAt, mdOffsetToPmPos } from "../markdown-position-map";

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    searchHighlight: {
      setSearchHighlight: (query: string) => ReturnType;
      clearSearchHighlight: () => ReturnType;
      /** 标记"当前命中"（查找框里按回车/点下一个时用）：参数是 **Markdown 原文偏移** */
      setSearchHighlightCurrent: (mdFrom: number, mdTo: number) => ReturnType;
    };
  }
}

interface SearchHighlightStorage {
  query: string;
  /**
   * "当前命中"的范围，用 **Markdown 原文偏移**表示（与主高亮同一坐标系）。
   *
   * 为什么需要它：查找框保持焦点时，**焦点移入 <input> 会清空文档里的原生选区**
   *（浏览器既有行为）—— 于是"按回车/点下一个"跳到的那个匹配看不到选中效果，
   * 而点按钮时却正常（按钮不会清空选区）。所以不给焦点较劲，改为用一条装饰
   * 把当前命中单独画出来（VS Code 的做法）。
   *
   * 为什么存原文偏移而不是 PM 位置：命中可能落在注音字面量内部，Ruby 一展开/收起
   * 文档结构就变了，存 PM 位置的话那条装饰会错位（实测会落到字面量第一个字符上）。
   */
  current: { mdFrom: number; mdTo: number } | null;
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
      setSearchHighlightCurrent: (mdFrom: number, mdTo: number) => ({ editor }) => {
        (editor.storage as Record<string, any>).searchHighlight = {
          ...((editor.storage as Record<string, any>).searchHighlight ?? {}),
          current: { mdFrom, mdTo },
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
        apply: (tr, _old, _oldState, newState) => {
          // 检查是否是 forceUpdate
          if (tr.getMeta("forceUpdate") || tr.docChanged) {
            const query = (extension.editor?.storage as Record<string, any>)?.searchHighlight?.query;
            if (!query) return DecorationSet.empty;

            const decorations: Decoration[] = [];
            /**
             * ⚠️ 必须用**新** state 的 doc。
             *
             * `apply(tr, value, oldState, newState)` 的**第 3 个参数是 oldState** ——
             * 用它就等于"拿事务之前的文档算装饰、再把结果挂到事务之后的文档上"。
             * 平时看不出来（forceUpdate 那次 oldState === newState），
             * 但只要事务改了文档（打字、Ruby 字面量的展开/收起），装饰就会错位：
             * 输入 `{{Ruby|前歯|まえば}}` 展开后，装饰仍停在旧的注音节点区间 [248,249)，
             * 在新文档里那只是一个 `{` —— 用户看到的就是"Ruby 展开后没有高亮"。
             */
            const doc = newState.doc;

            /**
             * 匹配的**真理源是 Markdown 原文**（与 SV 模式同一套语义）：
             * 这里不自己扫文档，而是复用 markdown-search 的原文命中，再把命中的偏移
             * 映射成 PM 坐标来画装饰。
             *
             * ⚠️ 原文与映射表都必须基于 **newState.doc**：`apply` 阶段视图状态还没换成
             * 新 state，从 editor 上取会拿到**旧文档**（表现：Ruby 展开后装饰仍停在旧
             * 节点区间，只盖住一个字面量首字符）。
             */
            const map = getCachedPositionMap(extension.editor, newState.doc);
            const seen = new Set<string>();
            const size = doc.content.size;
            /** 原文偏移 → 显示区间；落在行内原子节点内部时扩到整个节点 */
            const mapRange = (mdFrom: number, mdTo: number) => {
              let from = mdOffsetToPmPos(map, mdFrom);
              let to = mdOffsetToPmPos(map, mdTo);
              if (to <= from) {
                // PM 里没有字面量内部的坐标 → 整块高亮该节点（未展开的注音就是这种）
                const leaf = inlineLeafRangeAt(doc, from, size);
                if (!leaf) return null;
                from = leaf.from;
                to = leaf.to;
              }
              return { from, to };
            };
            if (map.markdown && map.markers.length > 0) {
              for (const m of findMarkdownMatches(map.markdown, query)) {
                const range = mapRange(m.mdFrom, m.mdTo);
                if (!range) continue;
                // 多处原文命中可能映射到同一个显示区间（例如同一注音里的两次 rt 命中）→ 去重
                const key = `${range.from}-${range.to}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const node = doc.nodeAt(range.from);
                if (node && node.isLeaf && range.from + node.nodeSize === range.to) {
                  decorations.push(Decoration.node(range.from, range.to, { class: "search-highlight" }));
                } else {
                  decorations.push(Decoration.inline(range.from, range.to, { class: "search-highlight" }));
                }
              }
            }

            /**
             * 当前命中：单独一条装饰，样式更醒目。
             * 这样即使焦点在查找框（原生选区被清空），也能一眼看到"跳到哪了"。
             *
             * current 存的也是**原文偏移**，和主高亮一样按当前文档现算 ——
             * 这样 Ruby 展开 / 收起之后「当前命中」不会错位（旧实现存 PM 位置，
             * 展开后那条装饰会落在字面量的第一个字符上）。
             */
            const current = (extension.editor?.storage as Record<string, any>)?.searchHighlight?.current;
            if (current && typeof current.mdFrom === "number" && typeof current.mdTo === "number") {
              const range = mapRange(current.mdFrom, current.mdTo);
              if (range && range.to > range.from) {
                decorations.push(
                  Decoration.inline(range.from, range.to, { class: "search-highlight-current" }),
                );
              }
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
