/**
 * 导出用的「编辑器排版」样式表 + 注音读音实体化。
 *
 * ## 为什么需要这份样式
 *
 * 编辑器的标题、链接、注音等排版都写在 `Editor/theme.css` 里，而且选择器都挂在
 * `.tiptap-editor .tiptap ...` 之下（例如 `.tiptap-editor .tiptap h2 { … }`）✓。
 *
 * 导出时内容虽然是从编辑器克隆的（保留 `.tiptap` 类 ✓），但**外层容器不再有
 * `.tiptap-editor`** ✗ —— 于是这些规则一条都不生效 ✗：
 *   - 标题退回浏览器默认（大小/字重/主题色短线全丢）
 *   - 链接退回默认蓝色下划线
 *   - 注音读音（`.md-ruby::after`）连伪元素规则都拿不到
 *
 * 所以这里把这三块**镜像**成一份作用域为 `.tiptap-export-content` 的样式，
 * 由 `prepareExportElement` 注入一次 ✓。作用域用 `.tiptap-export-content` 而不是
 * `.tiptap-editor`，是为了**不**引入编辑器的布局规则（`padding: 2rem 3rem`、
 * `max-width`、flex gap 等）✗ —— 导出有自己的页面/卡片排版 ✓。
 *
 * ⚠️ 这里的数值改动必须与 `Editor/theme.css` 对应规则**同步** ✓，
 * 否则导出的标题/链接又会和编辑器不一致。
 *
 * ## 为什么注音要实体化
 *
 * 读音是 `.md-ruby::after` 用 `content: attr(data-rt)` 画的 ✓；
 * 而「图文卡片 / PNG / PDF」走的是 `html-to-image`（SVG foreignObject）✓ ——
 * 它**不克隆伪元素** ✗，读音会整个消失 ✓。
 * 所以导出前把 `data-rt` 变成真实的 `<span class="md-ruby-rt">`，
 * 并把伪元素关掉（`md-ruby-materialized`）✓ —— 这样：
 *   - foreignObject 截图能看到读音 ✓
 *   - 公众号（把 computed style 内联成行内样式）也能保留 ✓
 *   - 导出的 HTML 里读音是真实文本，可搜索/可选中 ✓
 */

/** 注入到 document.head 的 <style> 的 id（幂等注入用） */
export const EXPORT_TYPOGRAPHY_STYLE_ID = "tydora-export-typography";

/** 导出内容区的排版（与编辑器对齐；作用域 .tiptap-export-content） */
export const EXPORT_TYPOGRAPHY_CSS = `
/* ── 标题：与 .tiptap-editor .tiptap h1–h6 一致 ✓ ── */
.tiptap-export-content h1,
.tiptap-export-content h2,
.tiptap-export-content h3,
.tiptap-export-content h4,
.tiptap-export-content h5,
.tiptap-export-content h6 {
  padding-top: 0;
  line-height: 1.25;
  /* 用 rem 而不是 em：em 按元素自身字号算，H2 的 1.5em 会变成 36px，与编辑器不一致 */
  margin: 1.5rem 0 0.5rem;
}
.tiptap-export-content h1 {
  font-size: 2.2em;
  font-weight: 700;
  letter-spacing: -0.011em;
  margin-top: 0.6rem;
  padding-bottom: 0.35em;
  border-bottom: 1px solid var(--border, rgba(128, 128, 128, 0.35));
}
.tiptap-export-content h2 {
  font-size: 1.5em;
  font-weight: 700;
  letter-spacing: -0.006em;
  padding-bottom: 0.28em;
  background-image: linear-gradient(var(--accent, #0969da), var(--accent, #0969da));
  background-repeat: no-repeat;
  background-position: left bottom;
  background-size: 2.5em 2px;
}
.tiptap-export-content h3 {
  font-size: 1.25em;
  font-weight: 600;
}
.tiptap-export-content h4 {
  font-size: 1.08em;
  font-weight: 600;
}
.tiptap-export-content h5 {
  font-size: 0.95em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-secondary, #6b7280);
}
.tiptap-export-content h6 {
  font-size: 0.88em;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-secondary, #6b7280);
  opacity: 0.85;
}

/* ── 链接：与 .tiptap-editor a 一致 ✓ ──
   编辑器里下划线默认 0%、hover 才长满；导出的是静态产物（HTML/PNG/PDF），
   没有 hover，所以下划线常驻显示 ✓（否则链接和普通文字分不开）。 */
.tiptap-export-content a {
  color: var(--text-link, var(--accent, #0969da));
  text-decoration: none;
  background-image: linear-gradient(currentColor, currentColor);
  background-repeat: no-repeat;
  background-position: 0 100%;
  background-size: 100% 1px;
}
/* Wiki 链接：与编辑器一致的"药丸底" ✓ */
.tiptap-export-content .wiki-link {
  color: var(--accent, #0969da);
  text-decoration: none;
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.15);
  background-image: none;
  padding: 1px 4px;
  border-radius: 3px;
}
.tiptap-export-content .wiki-link[data-exists="false"] {
  color: var(--text-secondary, #999);
  background: transparent;
  opacity: 0.6;
}

/* ── 注音：与 .tiptap-editor .md-ruby 一致 ✓ ── */
.tiptap-export-content .md-ruby {
  position: relative;
  /* 读音比本体宽时向两侧让出空间（变量由 Editor/ruby-measure.ts 实测写入） */
  padding-inline: calc(
    max(0px, var(--ruby-rt-w, 0px) - var(--ruby-base-w, 0px)) / 2
  );
}
/* 实体化后关掉伪元素，避免读音画两遍 ✗ */
.tiptap-export-content .md-ruby.md-ruby-materialized::after {
  content: none;
}
/* 实体化的读音：位置/字号与 ::after 完全一致 ✓ */
.tiptap-export-content .md-ruby-rt {
  position: absolute;
  left: 50%;
  top: -0.5em;
  transform: translateX(-50%);
  font-size: 0.5em;
  font-weight: 500;
  line-height: 1;
  white-space: nowrap;
  color: inherit;
  pointer-events: none;
}
`;

/** 幂等注入导出排版样式（多次调用只注入一次） */
export function ensureExportTypographyStyle(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(EXPORT_TYPOGRAPHY_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = EXPORT_TYPOGRAPHY_STYLE_ID;
  style.textContent = EXPORT_TYPOGRAPHY_CSS;
  document.head.appendChild(style);
}

/**
 * 把注音读音从「伪元素」变成「真实 DOM」✓。
 * 返回实体化的数量（便于测试/诊断）。
 */
export function materializeRubyReadings(root: HTMLElement): number {
  let count = 0;
  root.querySelectorAll<HTMLElement>(".md-ruby").forEach((el) => {
    const rt = (el.getAttribute("data-rt") ?? "").trim();
    if (!rt) return;
    // 已经实体化过（同一份 DOM 可能被多次导出）→ 跳过
    if (el.querySelector(":scope > .md-ruby-rt")) return;
    const note = document.createElement("span");
    note.className = "md-ruby-rt";
    note.textContent = rt;
    el.appendChild(note);
    el.classList.add("md-ruby-materialized");
    count += 1;
  });
  return count;
}
