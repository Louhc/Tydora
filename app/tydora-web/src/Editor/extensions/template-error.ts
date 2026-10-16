import { Extension, Node } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

/**
 * 「模板无法解析」错误块。
 *
 * 需求：不可解析的模板（注音本体里再放模板、花括号不配平…）**默认整块显示为报错信息**，
 * 光标移到附近时**展开成源码**供修改。
 *
 * 设计要点（这是它安全的原因）：
 * - **源码原样存在节点的文本内容里**（`content: "text*"`），序列化就是 `state.write(node.textContent)`
 *   → 文件里一个字符都不会变 ✓（往返逐字节一致）；
 * - "报错块 ↔ 源码"两种呈现**只靠 CSS 切换**（`font-size: 0` 藏文本 + `::before` 显示 attr）
 *   → **不换节点、不动文本**，所以不像"节点 ↔ 字面量"那套有损坏风险 ✓；
 * - 展开判据用**装饰**（光标贴住两端就加 class），纯显示层 ✓。
 */
export const TemplateError = Node.create({
  name: "templateError",

  group: "inline",
  inline: true,
  content: "text*",
  marks: "",
  selectable: true,
  atom: false,

  addAttributes() {
    return {
      /**
       * 报错文案（CSS 用 content: attr(data-reason) 显示）。
       * **不参与序列化** —— 序列化只写文本内容，所以它只是"呈现层"的附加信息，
       * 重新打开时会按同样的规则重算。
       */
      reason: {
        default: "⚠ 错误：模板写法无法解析",
        parseHTML: (element) => element.getAttribute("data-reason") || "⚠ 错误：模板写法无法解析",
        renderHTML: (attributes) => ({ "data-reason": attributes.reason }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "span[data-template-error]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return ["span", { "data-template-error": "", ...HTMLAttributes }, 0];
  },

  addStorage() {
    return {
      markdown: {
        // 关键：**原样写出**节点内容（就是那段没法解析的源码），不做任何转义/包装
        serialize(state: any, node: any) {
          state.write(node.textContent);
        },
        parse: {
          // 由 markdown-it 规则（Editor/markdown-templates.ts）负责包成这个节点
        },
      },
    };
  },
});

const KEY = new PluginKey("tydoraTemplateErrorExpand");

/** 光标贴住（含两端）就展开成源码 —— 与注音 / 链接字面量用的是同一条"闭区间"判据 */
function buildDecorations(doc: any, selection: any): DecorationSet {
  const decos: Decoration[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.type.name !== "templateError") return;
    const from = pos;
    const to = pos + node.nodeSize;
    if (selection.from <= to && selection.to >= from) {
      decos.push(Decoration.node(from, to, { class: "is-expanded" }));
    }
  });
  return DecorationSet.create(doc, decos);
}

/** 展开/收起的装饰（纯显示层；不改变文档内容） */
export const TemplateErrorExpand = Extension.create({
  name: "templateErrorExpand",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: KEY,
        state: {
          init: (_config, state) => buildDecorations(state.doc, state.selection),
          apply: (tr, value, _oldState, newState) =>
            tr.docChanged || tr.selectionSet
              ? buildDecorations(newState.doc, newState.selection)
              : value,
        },
        props: {
          decorations(state) {
            return KEY.getState(state);
          },
        },
      }),
    ];
  },
});

export default TemplateError;
