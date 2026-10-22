import MarkdownIt from 'markdown-it';
import anchor from 'markdown-it-anchor';
import footnote from 'markdown-it-footnote';
import taskLists from 'markdown-it-task-lists';
import hljs from 'highlight.js';
import GithubSlugger from 'github-slugger';
import type { Heading, LinkRef } from '@shared/content-model';

// Non-stateful github slugify (no dedup counter) — used both for heading
// anchor ids and for resolving #Heading fragments in wikilinks (§5/§14).
export function slugifyHeading(text: string): string {
  return new GithubSlugger().slug(text);
}

const CALLOUT_TYPES = new Set([
  'note', 'abstract', 'summary', 'tldr', 'info', 'todo', 'tip', 'hint',
  'important', 'success', 'check', 'done', 'question', 'help', 'faq',
  'warning', 'caution', 'attention', 'failure', 'fail', 'missing', 'danger',
  'error', 'bug', 'example', 'quote', 'cite',
]);

export interface ResolveResult {
  /** Resolved target slug, or null if unresolved (broken link). */
  slug: string | null;
  title: string;
}

export interface MarkdownEnv {
  /** Resolve a wikilink/embed target (page name) to a note. */
  resolveLink(target: string): ResolveResult;
  /** Resolve an asset reference (e.g. "diagram.png") to a public URL or null. */
  resolveAsset(target: string): { url: string; ext: string } | null;
  /** Render an embedded note/section to an HTML fragment (cycle-guarded). */
  renderEmbed(target: string, heading: string | null): string | null;
  /** Resolve a YouTube video id to its note, for video→note linking. */
  resolveVideo(id: string): LinkRef | null;
  /** Slug of the note being rendered (so its own URL field stays external). */
  selfSlug: string;
  /** Collected outgoing links (deduped by slug) for the current note. */
  outgoing: LinkRef[];
  /** Collected headings for the current note. */
  headings: Heading[];
  /** Anchor slugger state for the current note. */
  slugger: GithubSlugger;
}

interface WikiParts {
  target: string;
  heading: string | null;
  block: string | null;
  alias: string | null;
}

function parseWiki(inner: string): WikiParts {
  let alias: string | null = null;
  const pipe = inner.indexOf('|');
  if (pipe !== -1) {
    alias = inner.slice(pipe + 1).trim();
    inner = inner.slice(0, pipe);
  }
  let block: string | null = null;
  let heading: string | null = null;
  const caret = inner.indexOf('^');
  const hash = inner.indexOf('#');
  if (caret !== -1) {
    block = inner.slice(caret + 1).trim();
    inner = inner.slice(0, caret);
  } else if (hash !== -1) {
    heading = inner.slice(hash + 1).trim();
    inner = inner.slice(0, hash);
  }
  return { target: inner.trim(), heading, block, alias };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

// Extract the 11-char video id from a YouTube watch/short URL. `hasTime` marks
// links that point at a timestamp (a clip) — those stay external.
function parseYouTubeId(href: string): { id: string; hasTime: boolean } | null {
  const short = /^https?:\/\/(?:www\.)?youtu\.be\/([A-Za-z0-9_-]{11})(?:[?#].*)?$/i.exec(href);
  if (short) return { id: short[1], hasTime: /[?&]t=/.test(href) };
  const watch =
    /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:[^#]*&)?v=([A-Za-z0-9_-]{11})(?:[&#].*)?$/i.exec(
      href,
    );
  if (watch) return { id: watch[1], hasTime: /[?&]t=/.test(href) };
  return null;
}

// ---- custom inline rule: wikilinks & embeds ----

// ---- Tydora 行内模板：{{Ruby|…}} / {{Hilite|…}} / {{Color|…}} ----

/** 高亮底色（与编辑器 Editor/highlighter.ts 的 HIGHLIGHT_COLORS 一致 ✓） */
const TYDORA_HILITE_COLORS: Record<string, string> = {
  yellow: '#ffe58f',
  green: '#b7ebc6',
  blue: '#b3ddff',
  pink: '#ffc9de',
  purple: '#dcc9ff',
  orange: '#ffd6a5',
};

/** 文字色（与编辑器 Editor/extensions/text-color.ts 的 TEXT_COLORS 一致 ✓） */
const TYDORA_TEXT_COLORS: Record<string, string> = {
  red: '#e03131',
  orange: '#e8590c',
  green: '#2f9e44',
  blue: '#1c7ed6',
  violet: '#7048e8',
  pink: '#d6336c',
};

/** 高亮底色透明度（与编辑器 mark 的 0.38 一致 ✓） */
const TYDORA_HILITE_ALPHA = 0.38;

/** #rgb / #rrggbb → rgba() ✓（不支持时原样返回） */
function hexToRgba(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  let h = m[1];
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** 参数既可以是调色板 id，也可以直接写 #hex ✓（与编辑器一致） */
function resolveTydoraColor(param: string, palette: Record<string, string>, fallback: string): string {
  const key = param.trim();
  if (!key) return fallback;
  const byId = palette[key.toLowerCase()];
  if (byId) return byId;
  if (/^#[0-9a-f]{3,8}$/i.test(key)) return key;
  return fallback;
}

/** 从 start 处的 `{{` 找到配对的 `}}`（支持嵌套），返回**结束位置之后**的下标；找不到返回 -1 */
function findTemplateEnd(src: string, start: number): number {
  let depth = 0;
  for (let i = start; i < src.length - 1; i++) {
    if (src[i] === '{' && src[i + 1] === '{') {
      depth++;
      i++;
      continue;
    }
    if (src[i] === '}' && src[i + 1] === '}') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 模板 → 纯文本（正文取本体、Hilite/Color 取文字）✓，供标题 slug / TOC 使用 */
function tydoraPlainText(s: string): string {
  let out = s;
  for (let i = 0; i < 2; i++) {
    out = out
      .replace(/\{\{Ruby\|([^|{}]+)\|[^|{}]*\}\}/g, '$1')
      .replace(/\{\{(?:Hilite|Color)\|[^|{}]*\|([^{}]*)\}\}/g, '$1');
  }
  return out;
}

/** 按 `|` 切分模板参数，但**忽略嵌套 `{{…}}` 内部的 `|`** ✓ */
function splitTemplateArgs(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] === '{' && body[i + 1] === '{') {
      depth++;
      i++;
      continue;
    }
    if (body[i] === '}' && body[i + 1] === '}') {
      depth--;
      i++;
      continue;
    }
    if (body[i] === '|' && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

/** 单个模板体（已去掉外层 {{ }}）→ HTML；不认识的写法返回 null（由调用方原样转义输出） */
function renderTydoraTemplate(body: string): string | null {
  const parts = splitTemplateArgs(body);
  if (parts.length < 3) return null; // 至少 name + 两个参数
  const name = parts[0].trim();
  const param = parts[1];
  const inner = parts.slice(2).join('|');

  if (name === 'Ruby') {
    const base = param;
    const rt = inner;
    /**
     * 本体恰好是**一个模板**时自动翻转 ✓（与编辑器一致）：
     * `{{Ruby|{{Hilite|yellow|心構}}|こころがま}}` → `{{Hilite|yellow|{{Ruby|心構|こころがま}}}}`
     */
    if (base.startsWith('{{') && findTemplateEnd(base, 0) === base.length) {
      const innerParts = splitTemplateArgs(base.slice(2, -2));
      const innerName = (innerParts[0] ?? '').trim();
      if ((innerName === 'Hilite' || innerName === 'Color') && innerParts.length >= 3) {
        const flipped =
          `{{${innerName}|${innerParts[1]}|{{Ruby|${innerParts.slice(2).join('|')}|${rt}}}}}`;
        return renderTydoraInline(flipped);
      }
    }
    return `<ruby>${renderTydoraInline(base)}<rt>${renderTydoraInline(rt)}</rt></ruby>`;
  }
  if (name === 'Hilite') {
    const hex = resolveTydoraColor(param, TYDORA_HILITE_COLORS, TYDORA_HILITE_COLORS.yellow);
    return `<mark class="td-hilite" style="background-color:${hexToRgba(hex, TYDORA_HILITE_ALPHA)}">${renderTydoraInline(inner)}</mark>`;
  }
  if (name === 'Color') {
    const hex = resolveTydoraColor(param, TYDORA_TEXT_COLORS, TYDORA_TEXT_COLORS.red);
    return `<span class="td-color" style="color:${hex}">${renderTydoraInline(inner)}</span>`;
  }
  return null;
}
function renderTydoraInline(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) {
      out += escapeHtml(text.slice(i));
      break;
    }
    if (open > i) out += escapeHtml(text.slice(i, open));
    const end = findTemplateEnd(text, open);
    if (end < 0) {
      out += escapeHtml(text.slice(open));
      break;
    }
    const html = renderTydoraTemplate(text.slice(open + 2, end - 2));
    out += html ?? escapeHtml(text.slice(open, end));
    i = end;
  }
  return out;
}

/**
 * 行内规则：把 Tydora 的 `{{模板}}` 语法渲染成 HTML ✓
 *
 * 站点之前把这类字面量原样输出 ✗（生成的 HTML 里是 `<p>{{Ruby|素早|すばや}}く</p>`），
 * 于是发布出来的网站看不到注音 / 高亮 / 文字色 ✓。
 *
 * 支持 `{{Ruby|本体|读音}}`、`{{Hilite|yellow|文字}}`、`{{Color|red|文字}}`，
 * 以及它们的嵌套（`{{Hilite|…|{{RubY…}}}}` 这类）✓。
 * 代码块 / 行内代码里的内容不会走到行内规则 ✓，因此不会被误解析 ✓。
 */
function tydoraTemplateRule(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'tydora_template', (state, silent) => {
    const start = state.pos;
    const src = state.src;
    if (src[start] !== '{' || src[start + 1] !== '{') return false;
    const end = findTemplateEnd(src, start);
    if (end < 0) return false;
    if (silent) {
      state.pos = end;
      return true;
    }
    const html = renderTydoraTemplate(src.slice(start + 2, end - 2));
    if (html === null) return false; // 不认识的模板 → 不当成模板处理
    const token = state.push('html_inline', '', 0);
    token.content = html;
    state.pos = end;
    return true;
  });
}

function wikilinkRule(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const start = state.pos;
    const src = state.src;
    const isEmbed = src[start] === '!';
    const bracketAt = isEmbed ? start + 1 : start;
    if (src[bracketAt] !== '[' || src[bracketAt + 1] !== '[') return false;
    const close = src.indexOf(']]', bracketAt + 2);
    if (close === -1) return false;
    const inner = src.slice(bracketAt + 2, close);
    if (silent) {
      state.pos = close + 2;
      return true;
    }
    const env = state.env as MarkdownEnv;
    const parts = parseWiki(inner);

    if (isEmbed) {
      const asset = env.resolveAsset(parts.target);
      if (asset) {
        const token = state.push('html_inline', '', 0);
        const alt = escapeAttr(parts.alias ?? parts.target);
        if (asset.ext === 'pdf') {
          token.content = `<embed class="embed-pdf" src="${asset.url}" type="application/pdf">`;
        } else {
          // alias may carry size: 400 or 400x300
          let sizeAttr = '';
          if (parts.alias && /^\d+(x\d+)?$/.test(parts.alias)) {
            const [w, h] = parts.alias.split('x');
            sizeAttr = ` width="${w}"${h ? ` height="${h}"` : ''}`;
            token.content = `<img class="embed-img" src="${asset.url}" alt=""${sizeAttr}>`;
          } else {
            token.content = `<img class="embed-img" src="${asset.url}" alt="${alt}">`;
          }
        }
        state.pos = close + 2;
        return true;
      }
      // note/section embed
      const fragment = env.renderEmbed(parts.target, parts.heading);
      const token = state.push('html_inline', '', 0);
      if (fragment != null) {
        token.content = `<div class="embed embed-note">${fragment}</div>`;
      } else {
        token.content = `<span class="embed broken">![[${escapeHtml(inner)}]]</span>`;
      }
      state.pos = close + 2;
      return true;
    }

    // plain wikilink
    const res = env.resolveLink(parts.target);
    const label = parts.alias ?? parts.target;
    if (res.slug == null) {
      const token = state.push('html_inline', '', 0);
      token.content = `<a class="wikilink broken" href="#">${escapeHtml(label)}</a>`;
    } else {
      let anchor = '';
      if (parts.heading) anchor = '#' + slugifyHeading(parts.heading);
      else if (parts.block) anchor = '#^' + parts.block;
      // Base-RELATIVE (no leading slash): every page carries <base href>, so
      // the browser resolves this against the site base — a root-absolute
      // "/slug" 404s for crawlers/middle-click on subpath deployments (e.g.
      // GitHub Pages project sites). The SPA click handler is unaffected:
      // the router treats "x/y" and "/x/y" identically.
      const href = `${res.slug}${anchor}`;
      const token = state.push('html_inline', '', 0);
      token.content = `<a class="wikilink" href="${escapeAttr(href)}">${escapeHtml(label)}</a>`;
      if (!env.outgoing.some((l) => l.slug === res.slug)) {
        env.outgoing.push({ slug: res.slug, title: res.title });
      }
    }
    state.pos = close + 2;
    return true;
  });
}

// ---- custom inline rule: tags ----

function tagRule(md: MarkdownIt): void {
  md.inline.ruler.before('text', 'tag', (state, silent) => {
    const pos = state.pos;
    const src = state.src;
    if (src[pos] !== '#') return false;
    // must be at start or preceded by whitespace
    if (pos > 0 && !/\s/.test(src[pos - 1])) return false;
    const rest = src.slice(pos + 1);
    const m = /^[A-Za-z0-9_\-/]*[A-Za-z][A-Za-z0-9_\-/]*/.exec(rest);
    if (!m || m[0].length === 0) return false;
    const tag = m[0];
    if (silent) {
      state.pos = pos + 1 + tag.length;
      return true;
    }
    const token = state.push('html_inline', '', 0);
    token.content = `<a class="tag" href="/tags/${escapeAttr(tag)}">#${escapeHtml(tag)}</a>`;
    state.pos = pos + 1 + tag.length;
    return true;
  });
}

// ---- custom block rule: callouts ----

function calloutRule(md: MarkdownIt): void {
  md.block.ruler.before('blockquote', 'callout', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    const max = state.eMarks[startLine];
    if (state.src.charCodeAt(start) !== 0x3e /* > */) return false;
    // first content line must look like: > [!type] ...
    const firstLine = state.src.slice(start + 1, max).replace(/^\s/, '');
    const m = /^\[!([A-Za-z]+)\]([+-]?)\s*(.*)$/.exec(firstLine);
    if (!m) return false;
    if (silent) return true;

    let type = m[1].toLowerCase();
    if (!CALLOUT_TYPES.has(type)) type = 'note';
    const titleText = m[3].trim();

    // collect subsequent quoted lines
    let nextLine = startLine + 1;
    const bodyLines: string[] = [];
    for (; nextLine < endLine; nextLine++) {
      const lstart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lmax = state.eMarks[nextLine];
      if (state.sCount[nextLine] < state.blkIndent) break;
      if (state.src.charCodeAt(lstart) !== 0x3e) {
        // blank line ends the callout
        if (lstart >= lmax) break;
        break;
      }
      bodyLines.push(state.src.slice(lstart + 1, lmax).replace(/^\s/, ''));
    }

    const titleHtml = titleText
      ? md.renderInline(titleText, state.env)
      : type.charAt(0).toUpperCase() + type.slice(1);
    const bodyHtml = bodyLines.length ? md.render(bodyLines.join('\n'), state.env) : '';

    const token = state.push('html_block', '', 0);
    token.map = [startLine, nextLine];
    token.content =
      `<div class="callout callout-${type}">` +
      `<div class="callout-title">${titleHtml}</div>` +
      `<div class="callout-body">${bodyHtml}</div>` +
      `</div>\n`;

    state.line = nextLine;
    return true;
  });
}

function highlight(str: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      const out = hljs.highlight(str, { language: lang }).value;
      return `<pre class="hljs"><code class="language-${lang}">${out}</code></pre>`;
    } catch {
      /* fall through */
    }
  }
  return `<pre class="hljs"><code>${escapeHtml(str)}</code></pre>`;
}

export function createMarkdown(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight,
  });

  md.use(anchor, {
    slugify: (s: string) => slugifyHeading(s),
    permalink: false,
  });
  md.use(footnote);
  md.use(taskLists, { enabled: true, label: false });

  tydoraTemplateRule(md);
  wikilinkRule(md);
  tagRule(md);
  calloutRule(md);

  // capture headings during the heading_open render so we can build TOC
  const defaultHeadingOpen =
    md.renderer.rules.heading_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.heading_open = (tokens, idx, options, env: MarkdownEnv, self) => {
    const token = tokens[idx];
    const level = Number(token.tag.slice(1));
    const inline = tokens[idx + 1];
    const text = inline && inline.type === 'inline' ? tydoraPlainText(inline.content) : '';
    const slug = slugifyHeading(text);
    if (env && env.headings) env.headings.push({ level, text, slug });
    return defaultHeadingOpen(tokens, idx, options, env, self);
  };

  // rewrite standard markdown images (![](path)) to hashed asset URLs, the same
  // way Obsidian embeds (![[..]]) are handled. Remote / data URIs pass through.
  const defaultImage =
    md.renderer.rules.image ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env: MarkdownEnv, self) => {
    const token = tokens[idx];
    const srcIdx = token.attrIndex('src');
    if (srcIdx >= 0) {
      const src = token.attrs![srcIdx][1];
      if (!/^([a-z]+:)?\/\//i.test(src) && !src.startsWith('data:')) {
        const resolved = env.resolveAsset(src);
        if (resolved) {
          token.attrs![srcIdx][1] = resolved.url;
          // Animated GIF with a sibling poster (<name>.jpg): tag it so the
          // canvas can show the static poster when zoomed out / off-screen and
          // animate the real GIF only up close (avoids dozens of GIFs decoding
          // at once). No poster sibling -> unchanged, so other vaults are safe.
          if (resolved.ext === 'gif') {
            const posterBase = (src.split('/').pop() ?? src).replace(/\.gif$/i, '.jpg');
            const poster = env.resolveAsset(posterBase);
            if (poster) {
              token.attrSet('data-src', resolved.url);
              token.attrSet('data-poster', poster.url);
              const ci = token.attrIndex('class');
              token.attrSet('class', (ci >= 0 ? token.attrs![ci][1] + ' ' : '') + 'clip-gif');
            }
          }
        }
      }
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  // external links (markdown links + linkified bare URLs) open in a new tab so
  // following one does not navigate away from the published site.
  const defaultLinkOpen =
    md.renderer.rules.link_open ||
    ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env: MarkdownEnv, self) => {
    const token = tokens[idx];
    const hrefIdx = token.attrIndex('href');
    const href = hrefIdx >= 0 ? token.attrs![hrefIdx][1] : '';
    if (/^https?:\/\//i.test(href)) {
      const yt = parseYouTubeId(href);
      const note = yt && !yt.hasTime ? env.resolveVideo(yt.id) : null;
      if (note && note.slug !== env.selfSlug) {
        // a link to a video we publish → route to its note instead of YouTube
        token.attrs![hrefIdx][1] = `${note.slug}`;
        token.attrSet('class', 'wikilink');
        if (!env.outgoing.some((l) => l.slug === note.slug)) {
          env.outgoing.push({ slug: note.slug, title: note.title });
        }
      } else {
        token.attrSet('target', '_blank');
        token.attrSet('rel', 'noopener noreferrer');
      }
    } else if (
      href &&
      !/^(#|\/\/|\/)/.test(href) &&
      !/^[a-z][a-z0-9+.-]*:/i.test(href)
    ) {
      // Relative internal markdown link, e.g. [text](01-build.md) or
      // [text](sub/note.md#heading). Obsidian resolves these like wikilinks;
      // without this they 404 and get no hover preview. Anchor-only (#x),
      // root-absolute (/x), protocol (mailto:, http:) and // are left alone.
      const hashIdx = href.indexOf('#');
      const rawPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
      const frag = hashIdx >= 0 ? href.slice(hashIdx) : '';
      const target = decodeURIComponent(rawPath)
        .replace(/\.md$/i, '')
        .replace(/^\.\//, '');
      const res = target ? env.resolveLink(target) : { slug: null, title: '' };
      if (res.slug != null) {
        token.attrs![hrefIdx][1] = `${res.slug}${frag}`;
        token.attrSet('class', 'wikilink');
        if (!env.outgoing.some((l) => l.slug === res.slug)) {
          env.outgoing.push({ slug: res.slug, title: res.title });
        }
      } else if (/\.md$/i.test(rawPath)) {
        // looked like an internal note link but didn't resolve → mark broken
        token.attrs![hrefIdx][1] = '#';
        token.attrSet('class', 'wikilink broken');
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

  return md;
}