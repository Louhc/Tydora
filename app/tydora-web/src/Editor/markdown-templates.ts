import { getHTMLFromFragment } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import { installMarkdownRuleOnce } from "./extensions/markdown-setup";

/**
 * Tydora 行内模板语法 `{{模板|参数|内容}}` 的**公共部件**。
 *
 * 设计要点（与 `ruby.ts` 的既有做法保持一致，便于第二步把 Ruby 也迁进来）：
 *
 * 1. **配平扫描，而不是正则**。正则无法处理嵌套（`{{Color|red|a{{Hilite|yellow|b}}c}}`），
 *    现在 ruby 那条规则遇到嵌套只是"外层不匹配"，属于碰巧安全。这里统一用深度计数扫描。
 * 2. **同一套分隔符**：`|`，以及表格管道保护把 `|` 换成的 `\u0001`（解析 Markdown 表格时，
 *    行内的 `|` 会先被 `md_wrapper_pipe_guard` 替换成 `\u0001`，所以两种都要认）。
 * 3. **写保守、读宽松**：
 *    - 写入时，内容里若含 `|`、`\u0001`、`}}`、`{{`，模板无法无歧义表达 → 调用方**退回 HTML 形式**；
 *    - 解析时按"第一个分隔符切出参数，其余全部是内容"来处理，内容里再多几个 `|` 也照收。
 * 4. 这一步只服务 `Color` / `Hilite`（mark）；`Ruby` 由它自己的规则处理 —— 本模块的
 *    `render` 对 `Ruby` 返回 null 表示"原样留给 ruby 的规则"，因为 Ruby 是叶子节点、
 *    参数必须是纯文本，走的是另一条 emitter。
 */

/** 目前认识的模板名。`Ruby` 只用于"识别并跳过"，实际转换仍由 ruby.ts 负责。 */
export const TEMPLATE_NAMES = ["Ruby", "Color", "Hilite"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

/** 参数分隔符：竖线，或表格管道保护产生的 `\u0001`。 */
const SEPARATORS = ["|", "\u0001"];

export interface TemplateMatch {
  /** 模板名（已按 TEMPLATE_NAMES 校验过大小写敏感匹配） */
  name: TemplateName;
  /** 第一个分隔符之后的**全部**原文（含后续分隔符与嵌套模板），交给调用方自行切分 */
  inner: string;
  /** 在源文本里的区间 `[start, end)` */
  start: number;
  end: number;
}

/**
 * 在 `text[pos]` 处尝试匹配一个模板，返回**最外层**的匹配（内容里的嵌套不在这里展开）。
 * 不匹配返回 null。
 */
export function matchTemplateAt(text: string, pos: number): TemplateMatch | null {
  if (text.charCodeAt(pos) !== 123 /* { */ || text.charCodeAt(pos + 1) !== 123) return null;

  // 读模板名：只允许字母（Ruby / Color / Hilite）
  let i = pos + 2;
  const nameStart = i;
  while (i < text.length && /[A-Za-z]/.test(text[i])) i++;
  if (i === nameStart) return null;
  const rawName = text.slice(nameStart, i);
  const name = TEMPLATE_NAMES.find((n) => n === rawName);
  if (!name) return null;

  // 名字后必须是分隔符
  if (!SEPARATORS.includes(text[i] ?? "")) return null;
  i++;

  // 从第一个分隔符之后开始，配平扫描到与本模板配对的 `}}`
  const innerStart = i;
  let depth = 0;
  while (i < text.length) {
    if (text.charCodeAt(i) === 123 && text.charCodeAt(i + 1) === 123) {
      depth++;
      i += 2;
      continue;
    }
    if (text.charCodeAt(i) === 125 /* } */ && text.charCodeAt(i + 1) === 125) {
      if (depth === 0) {
        return { name, inner: text.slice(innerStart, i), start: pos, end: i + 2 };
      }
      depth--;
      i += 2;
      continue;
    }
    i++;
  }
  return null; // 没有配对的 }} → 不成立
}

/** 把 `inner` 按第一个分隔符切成 `[第一个参数, 其余内容]`（没有分隔符时参数为空、内容为全部） */
export function splitFirstParam(inner: string): { param: string; content: string } {
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "|" || inner[i] === "\u0001") {
      return { param: inner.slice(0, i).trim(), content: inner.slice(i + 1) };
    }
  }
  return { param: inner.trim(), content: "" };
}

/**
 * 内容是否**不能**安全写成模板。
 * 返回原因字符串（用于日志/调试）或 null（安全）。
 */
export function templateUnsafeReason(text: string): string | null {
  if (text.includes("\u0001")) return "含表格管道占位符";
  /**
   * 竖线：**只有出现在模板之外才有歧义**。
   *
   * 模板内部的竖线（如嵌套的 `{{Ruby|屎狗|狗屎}}`）是安全的 —— 它由嵌套那条规则自己消费，
   * 而我的参数切分"只认第一个分隔符、其余全是内容"，并且同样接受表格保护用的 \u0001。
   * 之前的写法把所有 `|` 都当成不安全，后果是：给「高亮 + 文字颜色」的选区插入注音时
   *（注音此刻还是字面量 `{{Ruby|…}}`），两个 mark 双双退回 HTML ✗。
   *
   * `{{` / `}}` 同理：配平即安全（扫描器是配平的），只有**不配平**才真的表达不了。
   */
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      i++;
      if (depth < 0) return "花括号不配平";
      continue;
    }
    if (text[i] === "|" && depth === 0) return "含模板外的 |";
  }
  return depth === 0 ? null : "花括号不配平";
}

/** 收集 parent.child(index) 起（dir=1）或 index-1 起（dir=-1）与 mark 相同的连续文本，拼成 run 文本 */
export function collectMarkRunText(
  parent: any,
  index: number,
  mark: any,
  dir: 1 | -1,
): string {
  const parts: string[] = [];
  let i = dir === 1 ? index : index - 1;
  while (i >= 0 && i < parent.childCount) {
    const child = parent.child(i);
    if (!child.isText) break;
    const has = (child.marks ?? []).some((m: any) => m.eq(mark));
    if (!has) break;
    if (dir === 1) parts.push(child.text ?? "");
    else parts.unshift(child.text ?? "");
    i += dir;
  }
  return parts.join("");
}

/**
 * Ruby 的"本体恰好是一个完整模板"时，**翻转嵌套方向**：
 *
 *   `{{Ruby|{{Hilite|yellow|狗屎}}|goushi}}`  →  `{{Hilite|yellow|{{Ruby|狗屎|goushi}}}}`
 *
 * 为什么：ruby 的本体/读音是**纯文本属性**，模板塞不进本体里 ✗；但高亮落在 ruby
 * 节点上是完全可表达的 ✓，而且渲染结果一模一样 ✓。翻转后正好是支持的链顺序
 *（Hilite/Color 在外、Ruby 最内），所以还能正常往返。
 *
 * 返回 null 表示"不适用"（本体不是单个模板、或读音里还有东西）→ 交给原逻辑保持原样。
 */
function flipRubyBaseTemplate(m: TemplateMatch): string | null {
  if (m.name !== "Ruby") return null;
  // ⚠️ 分隔符必须是**深度 0** 的那个：本体内层模板自身也含 `|`
  //（`{{Hilite|yellow|狗屎}}` 里就有两个），按"第一个 |"切会把本体切成 `{{Hilite`。
  const sep = findTopLevelSeparator(m.inner);
  if (!sep) return null;
  const baseRaw = m.inner.slice(0, sep.index).trim();
  const rest = m.inner.slice(sep.index + 1);
  const innerTmpl = matchTemplateAt(baseRaw, 0);
  // 本体必须**正好**是一个模板（前后没有别的字），否则表达不了 → 不翻转
  if (!innerTmpl || innerTmpl.end !== baseRaw.length) return null;
  const rt = rest.trim();
  if (!rt || findTopLevelSeparator(rt)) return null; // 读音必须是简单文本
  const { param, content } = splitFirstParam(innerTmpl.inner);
  if (!content) return null;
  return `{{${innerTmpl.name}${sep.char}${param}${sep.char}{{Ruby${sep.char}${content}${sep.char}${rt}}}}}`;
}

/** 找出**深度 0**（不在任何嵌套模板里）的第一个分隔符 */function findTopLevelSeparator(text: string): { index: number; char: string } | null {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "}" && text[i + 1] === "}") {
      depth--;
      i++;
      continue;
    }
    if (depth === 0 && (text[i] === "|" || text[i] === "\u0001" || text[i] === ":")) {
      return { index: i, char: text[i] };
    }
  }
  return null;
}

/**
 * 文本里"看着像模板、但解析不了"的一段 → 包成错误块的 HTML。
 *
 * 判据：`{{` + 已知模板名 ✓ 但 `matchTemplateAt` 拒绝（花括号不配平、注音本体里塞了模板…）。
 * 生成的 `<span data-template-error data-reason="…">源码</span>` 会被 TipTap 建成
 * `templateError` 节点（见 extensions/template-error.ts）：默认显示报错信息，
 * 光标靠近时展开成源码；**源码原样作为节点文本**，所以序列化回文件逐字节一致 ✓。
 */
function matchTemplateErrorAt(text: string, pos: number): { html: string; end: number } | null {
  if (text.charCodeAt(pos) !== 123 || text.charCodeAt(pos + 1) !== 123) return null;
  const head = /^\{\{\s*(Ruby|Color|Hilite)\b/.exec(text.slice(pos));
  if (!head) return null;
  const closeIdx = text.indexOf("}}", pos);
  const end = closeIdx >= 0 ? closeIdx + 2 : text.length;
  const raw = text.slice(pos, end);
  // 注音本体/读音里出现嵌套模板是最常见的一种；其余给通用文案
  const reason =
    head[1] === "Ruby" && raw.includes("{{", 4)
      ? "⚠ 错误：本体里不能再放模板"
      : "⚠ 错误：模板写法无法解析";
  // 转义 `&` 与 `<`：markdown-it 会把这些实体解回原文，节点文本仍是原始源码 ✓
  const safe = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return { html: `<span data-template-error data-reason="${reason}">${safe}</span>`, end };
}

/**
 * 递归地把文本里的模板重写掉。
 *
 * `render(match, rewrittenInner)` 返回该模板对应的 HTML（或 null 表示"保持原样"，
 * 例如 Ruby 交给它自己的规则）。内容里的嵌套模板会**先被递归重写**，再交给 render。
 */
export function rewriteTemplates(
  text: string,
  render: (match: TemplateMatch, rewrittenInner: string) => string | null,
): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const m = matchTemplateAt(text, i);
    if (!m) {
      // 「看着像模板但解析不了」→ 包成错误块节点
      //（默认显示报错信息，光标靠近时展开成源码；文本原样存在节点里，序列化逐字节一致）
      const err = matchTemplateErrorAt(text, i);
      if (err) {
        out += err.html;
        i = err.end;
        continue;
      }
      out += text[i];
      i++;
      continue;
    }
    // 先看是不是"Ruby 本体是个模板"→ 翻转后递归重写（翻转结果里外层是 Hilite/Color）
    const flipped = flipRubyBaseTemplate(m);
    if (flipped) {
      out += rewriteTemplates(flipped, render);
      i = m.end;
      continue;
    }
    const rendered = render(m, rewriteTemplates(m.inner, render));
    if (rendered === null) {
      /**
       * 匹配上了、但**没人愿意渲染**它。
       *
       * Ruby 是这一支的常客：它由 ruby 规则处理（本模块返回 null），而 ruby 规则的
       * 本体/读音里不允许出现花括号 —— 所以 `{{Ruby|狗{{Hilite|yellow|屎}}|goushi}}`
       * 虽然"配平"（扫描器能匹配），但**真的解析不了** ✓。
       * 这类必须变成错误块（默认报错、光标靠近展开源码），不能默默留在正文里 ✗。
       *
       * 反过来，普通 `{{Ruby|狗屎|goushi}}` 的 inner 里没有嵌套模板 → 保持原样，
       * 交给 ruby 规则正常渲染 ✓。
       */
      if (m.inner.includes("{{")) {
        const raw = text.slice(m.start, m.end);
        const reason = m.name === "Ruby" ? "⚠ 错误：本体里不能再放模板" : "⚠ 错误：模板写法无法解析";
        const safe = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;");
        out += `<span data-template-error data-reason="${reason}">${safe}</span>`;
      } else {
        out += text.slice(m.start, m.end);
      }
      i = m.end;
      continue;
    }
    out += rendered;
    i = m.end;
  }
  return out;
}

/**
 * 各模板的"渲染器"注册表：把 `{{Name|…}}` 转成既有 parseHTML 认识的 HTML。
 *
 * 为什么要注册表：markdown-it 规则只需装**一次**，而 Color / Hilite 分属两个扩展
 * （各自的 `parse.setup` 时机不同）—— 用注册表合并，避免一个规则只能服务一个模板。
 */
const renderers = new Map<TemplateName, (match: TemplateMatch, rewrittenInner: string) => string | null>();

/** 注册某个模板名的渲染器（在各自的 parse.setup 里调用） */
export function registerTemplateRenderer(
  name: TemplateName,
  render: (match: TemplateMatch, rewrittenInner: string) => string | null,
): void {
  renderers.set(name, render);
}

/**
 * 幂等标记**挂在 markdown-it 实例上**（复用 ruby 那套 installMarkdownRuleOnce）——
 * 曾经用模块级 Set 按规则名去重，结果第一个编辑器装完，后续新建的编辑器（各自的
 * markdown-it 实例）就再也装不上规则了：模板整段留在正文、一个 mark 都解析不出来。
 */

/**
 * 安装 markdown-it 规则：在 inline 解析**之前**把模板重写成既有 parseHTML 认识的 HTML，
 * 这样 mark / 节点都无需改动，且内容里的行内 Markdown（粗体、链接、Ruby…）仍会被正常解析。
 *
 * 幂等：同一 markdown-it 实例只装一次（Color 与 Hilite 都会尝试调用它）。
 */
export function installTemplateRuleOnce(markdownit: any, id = "md_template"): boolean {
  if (!installMarkdownRuleOnce(markdownit, id)) return false;
  markdownit.core.ruler.before("inline", id, (state: any) => {
    /**
     * ⚠️ 必须改写**每个 inline token 的 `content`**，不能改 `state.src`：
     * core 链里 block 阶段早就把行内文本抽进了 token.content，改 src 已经来不及
     *（第一版实现就踩了这个坑：模板整段留在正文里，一个 mark 都没解析出来）。
     * 这正是 ruby.ts 的 md_wrapper 的做法。
     */
    for (const token of state.tokens ?? []) {
      if (token?.type !== "inline" || typeof token.content !== "string") continue;
      if (!token.content.includes("{{")) continue; // 便宜的预筛
      token.content = rewriteTemplates(token.content, (m, inner) => renderers.get(m.name)?.(m, inner) ?? null);
    }
  });
  return true;
}

// ── 颜色的参数编解码 + 两个 mark 的 HTML 形式 ──────────────────────────────
// 放在文件末尾，供 text-color.ts 与 Highlight 扩展各自使用。

/** 调色板条目（text-color.ts / highlighter.ts 的选项结构都满足这个形状） */
export interface PaletteEntry {
  id: string;
  color: string;
}

/** 转义 HTML 属性值 */
function escAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 颜色 → 模板参数：**命中调色板就写 id**（短，且以后能随主题微调），否则写原样 CSS 值。 */
export function encodeColorParam(color: string, palette: PaletteEntry[]): string {
  const c = String(color ?? "").trim();
  const hit = palette.find((p) => p.color.toLowerCase() === c.toLowerCase());
  return hit ? hit.id : c;
}

/** 模板参数里允许出现的颜色写法（防注入：参数会被拼进生成的 HTML 属性） */
const COLOR_PARAM_RE = /^(#[0-9a-fA-F]{3,8}|[a-zA-Z]+|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%deg]+\))$/;

/** 模板参数 → CSS 颜色：命中调色板 id → 调色板 hex；否则按原样 CSS 值用；不合法返回 null。 */
export function decodeColorParam(param: string, palette: PaletteEntry[]): string | null {
  const p = String(param ?? "").trim();
  if (!p) return null;
  const hit = palette.find((c) => c.id === p);
  if (hit) return hit.color;
  return COLOR_PARAM_RE.test(p) ? p : null;
}

/**
 * 把"调色板 id"归一化成它对应的 CSS 颜色。
 *
 * 为什么需要：id（如 `blue`）本身也是合法的 CSS 颜色名，一旦它出现在颜色值的位置
 * （实测：文档里高亮 mark 的 `color` 属性变成了 `blue`），`background-color: blue`
 * 会渲染成**纯蓝**，看起来就是"高亮颜色错了"。所以凡是把颜色写进 HTML/样式的地方，
 * 都先过这一层：是 id 就换成调色板里的 hex。
 */
export function normalizePaletteColor(color: string, palette: PaletteEntry[]): string {
  const c = String(color ?? "").trim();
  const hit = palette.find((p) => p.id === c);
  return hit ? hit.color : c;
}

/** `Color`（文字颜色）的 mark HTML：与 text-color.ts 的 renderHTML 一致（`data-color` 优先） */
export function colorTemplateHtml(color: string, inner: string): string {
  return `<span data-color="${escAttr(color)}">${inner}</span>`;
}

/**
 * mark 的 HTML 形式（给"内容不能写成模板"时用），**刻意不带 style**。
 *
 * 为什么：应用的 `#标签` 规则（tag.ts）匹配"空白/行首 + #名字"，
 * 而 `style="background-color: #b3ddff"` 里的 ` #b3ddff` 正好命中 →
 * 它会在我的标签中间插入 `<span data-tag="b3ddff">`，把 `<mark …>` 劈开，
 * 整串退化成文本（实测到的 `&lt;mark …&gt;小飞机` 就是这么来的）。
 * 只写 `data-color` 即可：两个 mark 的 parseHTML 都优先读它，渲染时由各自
 * 的 renderHTML 补回样式。
 */
export function colorHtmlTags(color: string | null | undefined, palette: PaletteEntry[]): [string, string] {
  return [color ? `<span data-color="${escAttr(normalizePaletteColor(color, palette))}">` : "<span>", "</span>"];
}

export function hiliteHtmlTags(color: string | null | undefined, palette: PaletteEntry[]): [string, string] {
  return [color ? `<mark data-color="${escAttr(normalizePaletteColor(color, palette))}">` : "<mark>", "</mark>"];
}

/** `Hilite`（高亮）的 mark HTML：与 Highlight 的渲染一致（`data-color` + 背景色 + 继承前景） */
export function hiliteTemplateHtml(color: string, inner: string): string {
  return `<mark data-color="${escAttr(color)}">${inner}</mark>`;
}
/**
 * 取某个 mark 的 HTML 开/闭标签（用于"内容含 `|`/`}}` 时退回 HTML 形式"）。
 * 与 tiptap-markdown 内置的 `getMarkTags` 同一套做法：借 renderHTML 生成再切分，
 * 这样 HTML 形式永远和 mark 自己的渲染保持一致。
 */
export function markHtmlTags(mark: any): [string, string] | null {
  try {
    const schema = mark.type.schema;
    const node = schema.text(" ", [mark]);
    const html = getHTMLFromFragment(Fragment.from(node), schema);
    const m = html.match(/^(<.*?>) (<\/.*?>)$/);
    return m ? [m[1], m[2]] : null;
  } catch {
    return null;
  }
}