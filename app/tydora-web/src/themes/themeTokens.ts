import type { ThemeVariable } from "./CustomThemeManager";
import type { BuiltinThemeName } from "./ThemeManager";
import { BUILTIN_THEMES } from "./ThemeManager";

/** 涓婚缂栬緫鍣ㄥ垎缁勶細鎸夌紪杈戝櫒/鐣岄潰鍏冪礌鍒嗙被 */
export type ThemeEditorSectionId =
  | "chrome"
  | "body"
  | "codeBlock"
  | "codeInline"
  | "blockquote"
  | "metadata"
  | "table"
  | "tag"
  | "scrollbar";

/** @deprecated 浣跨敤 ThemeEditorSectionId锛涗繚鐣欏埆鍚嶄互鍏嶅閮ㄥ紩鐢ㄦ柇瑁?*/
export type ThemeColorGroup = ThemeEditorSectionId;

export interface ThemeColorToken {
  name: string;
  section: ThemeEditorSectionId;
  /** i18n key under settings.theme.token.* */
  labelKey: string;
  /** Hidden from color editor UI (auto-derived) */
  hidden?: boolean;
}

export interface ThemeSizeToken {
  name: string;
  section: ThemeEditorSectionId;
  /** i18n key under settings.theme.token.* */
  labelKey: string;
  min: number;
  max: number;
  step?: number;
  /** CSS 鍗曚綅锛涢粯璁?`px`銆傜┖瀛楃涓茶〃绀烘棤鍗曚綅锛堝 0鈥? 涓嶉€忔槑搴︼級 */
  unit?: "px" | "";
  /**
   * 缂栬緫鍣ㄦ寜 0鈥?00% 鏄剧ず锛屼絾 CSS 瀛?0鈥?锛堜粎 unit 涓?"" 鏃舵湁鏁堬級銆?   * min/max/step 浠嶆寜鐧惧垎姣斿埢搴﹀～鍐欙紙濡?0鈥?00锛夈€?   */
  asPercent?: boolean;
}

export interface ThemeEditorSectionDef {
  id: ThemeEditorSectionId;
  /** i18n key under settings.theme.* */
  titleKey: string;
}

/** 缂栬緫鍣?UI 鍒嗙粍椤哄簭 */
export const THEME_EDITOR_SECTIONS: ThemeEditorSectionDef[] = [
  { id: "chrome", titleKey: "groupChrome" },
  { id: "body", titleKey: "groupBody" },
  { id: "codeBlock", titleKey: "groupCodeBlock" },
  { id: "codeInline", titleKey: "groupCodeInline" },
  { id: "blockquote", titleKey: "groupBlockquote" },
  { id: "metadata", titleKey: "groupMetadata" },
  { id: "table", titleKey: "groupTable" },
  { id: "tag", titleKey: "groupTag" },
  { id: "scrollbar", titleKey: "groupScrollbar" },
];

/** @deprecated 浣跨敤 THEME_EDITOR_SECTIONS */
export const THEME_COLOR_GROUPS: ThemeEditorSectionId[] = THEME_EDITOR_SECTIONS.map((s) => s.id);

/** Canonical editable color tokens for the theme editor. */
export const THEME_COLOR_SCHEMA: ThemeColorToken[] = [
  // 鐣岄潰
  { name: "--bg-secondary", section: "chrome", labelKey: "bgSecondary" },
  { name: "--bg-surface", section: "chrome", labelKey: "bgSurface" },
  { name: "--bg-hover", section: "chrome", labelKey: "bgHover" },
  { name: "--bg-tertiary", section: "chrome", labelKey: "bgTertiary" },
  { name: "--bg-input", section: "chrome", labelKey: "bgInput" },
  { name: "--border", section: "chrome", labelKey: "border" },
  { name: "--accent", section: "chrome", labelKey: "accent" },
  { name: "--accent-hover", section: "chrome", labelKey: "accentHover" },
  { name: "--accent-rgb", section: "chrome", labelKey: "accentRgb", hidden: true },
  { name: "--danger", section: "chrome", labelKey: "danger" },
  // 姝ｆ枃
  { name: "--bg-primary", section: "body", labelKey: "bgPrimary" },
  { name: "--text-primary", section: "body", labelKey: "textPrimary" },
  { name: "--text-secondary", section: "body", labelKey: "textSecondary" },
  { name: "--text-tertiary", section: "body", labelKey: "textTertiary" },
  { name: "--text-strong", section: "body", labelKey: "textStrong" },
  // 浠ｇ爜鍧?  { name: "--bg-code", section: "codeBlock", labelKey: "bgCode" },
  // 琛屽唴浠ｇ爜
  { name: "--bg-code-inline", section: "codeInline", labelKey: "bgCodeInline" },
  { name: "--text-code", section: "codeInline", labelKey: "textCode" },
  // 寮曠敤鍧?  { name: "--blockquote-border", section: "blockquote", labelKey: "blockquoteBorder" },
  { name: "--blockquote-bg", section: "blockquote", labelKey: "blockquoteBg" },
  { name: "--blockquote-text", section: "blockquote", labelKey: "blockquoteText" },
  // Metadata
  { name: "--metadata-bg", section: "metadata", labelKey: "metadataBg" },
  { name: "--metadata-border", section: "metadata", labelKey: "metadataBorder" },
  // 琛ㄦ牸
  { name: "--table-header-bg", section: "table", labelKey: "tableHeaderBg" },
  { name: "--table-cell-bg", section: "table", labelKey: "tableCellBg" },
  // 鏍囩
  { name: "--tag-bg", section: "tag", labelKey: "tagBg" },
  { name: "--tag-text", section: "tag", labelKey: "tagText" },
  { name: "--tag-border", section: "tag", labelKey: "tagBorder" },
  // 婊氬姩鏉?  { name: "--scrollbar-thumb", section: "scrollbar", labelKey: "scrollbarThumb" },
  { name: "--scrollbar-thumb-hover", section: "scrollbar", labelKey: "scrollbarThumbHover" },
  { name: "--scrollbar-track", section: "scrollbar", labelKey: "scrollbarTrack" },
];

/** Radius / padding / width tokens shown in the theme editor. */
export const THEME_SIZE_SCHEMA: ThemeSizeToken[] = [
  {
    name: "--sidebar-chrome-opacity",
    section: "chrome",
    labelKey: "sidebarChromeOpacity",
    min: 0,
    max: 100,
    step: 5,
    unit: "",
    asPercent: true,
  },
  { name: "--radius-code-block", section: "codeBlock", labelKey: "radiusCodeBlock", min: 0, max: 24 },
  { name: "--radius-code-inline", section: "codeInline", labelKey: "radiusCodeInline", min: 0, max: 16 },
  { name: "--padding-code-inline-y", section: "codeInline", labelKey: "paddingCodeInlineY", min: 0, max: 16 },
  { name: "--padding-code-inline-x", section: "codeInline", labelKey: "paddingCodeInlineX", min: 0, max: 24 },
  { name: "--blockquote-border-width", section: "blockquote", labelKey: "blockquoteBorderWidth", min: 0, max: 16 },
  { name: "--padding-blockquote-y", section: "blockquote", labelKey: "paddingBlockquoteY", min: 0, max: 32 },
  { name: "--padding-blockquote-x", section: "blockquote", labelKey: "paddingBlockquoteX", min: 0, max: 48 },
  { name: "--radius-metadata", section: "metadata", labelKey: "radiusMetadata", min: 0, max: 24 },
  { name: "--radius-table", section: "table", labelKey: "radiusTable", min: 0, max: 24 },
  { name: "--radius-tag", section: "tag", labelKey: "radiusTag", min: 0, max: 24 },
  { name: "--padding-tag-y", section: "tag", labelKey: "paddingTagY", min: 0, max: 16 },
  { name: "--padding-tag-x", section: "tag", labelKey: "paddingTagX", min: 0, max: 24 },
  { name: "--radius-scrollbar", section: "scrollbar", labelKey: "radiusScrollbar", min: 0, max: 16 },
  { name: "--scrollbar-size", section: "scrollbar", labelKey: "scrollbarSize", min: 4, max: 20 },
];

export type ThemeEditorField =
  | { kind: "color"; variable: ThemeVariable; meta: ThemeColorToken }
  | { kind: "size"; variable: ThemeVariable; meta: ThemeSizeToken };

export interface ThemeEditorSectionView {
  id: ThemeEditorSectionId;
  titleKey: string;
  fields: ThemeEditorField[];
}

/** Non-color vars preserved when forking / rebuilding CSS. */
const PRESERVED_NON_COLOR = [
  "--font-mono",
  "--font-ui",
  "--editor-font",
  "--editor-font-size",
  "--font-mono-size",
  "--sidebar-chrome-opacity",
  "--radius-code-block",
  "--radius-code-inline",
  "--padding-code-inline-y",
  "--padding-code-inline-x",
  "--radius-metadata",
  "--blockquote-border-width",
  "--padding-blockquote-y",
  "--padding-blockquote-x",
  "--radius-table",
  "--radius-tag",
  "--padding-tag-y",
  "--padding-tag-x",
  "--radius-scrollbar",
  "--scrollbar-size",
] as const;

const LIGHT_DEFAULTS: Record<string, string> = {
  "--bg-primary": "#ffffff",
  "--bg-secondary": "#d9ede5",
  "--bg-surface": "#ecf6f2",
  "--bg-hover": "rgba(78, 178, 137, 0.12)",
  "--bg-tertiary": "#c5e3d7",
  "--bg-code": "#f0f7f4",
  "--bg-code-inline": "rgba(78, 178, 137, 0.08)",
  "--bg-input": "#ffffff",
  "--text-primary": "#1e293b",
  "--text-secondary": "#6B6B6B",
  "--text-tertiary": "#9ca3af",
  "--text-strong": "#bd387d",
  "--text-code": "#e83e8c",
  "--accent": "#4eb289",
  "--accent-rgb": "78, 178, 137",
  "--accent-hover": "#3a9e6e",
  "--danger": "#e06c75",
  "--border": "#a5cfc0",
  "--scrollbar-thumb": "#a5cfc0",
  "--scrollbar-thumb-hover": "#6B6B6B",
  "--scrollbar-track": "transparent",
  "--metadata-bg": "#d9ede5",
  "--metadata-border": "#a5cfc0",
  "--blockquote-border": "#a5cfc0",
  "--blockquote-bg": "transparent",
  "--blockquote-text": "#6B6B6B",
  "--table-header-bg": "#d9ede5",
  "--table-cell-bg": "transparent",
  "--tag-bg": "rgba(78, 178, 137, 0.15)",
  "--tag-text": "#4eb289",
  "--tag-border": "rgba(78, 178, 137, 0.2)",
};

/** Full color maps for each built-in theme (for fork). Keep in sync with themes.css. */
export const BUILTIN_THEME_COLORS: Record<BuiltinThemeName, Record<string, string>> = {
  white: {
    "--bg-primary": "#ffffff",
    "--bg-secondary": "#f5f7fa",
    "--bg-surface": "#f1f5f9",
    "--bg-hover": "rgba(0, 0, 0, 0.06)",
    "--bg-tertiary": "#e8ecf1",
    "--bg-code": "#f6f8fa",
    "--bg-code-inline": "rgba(0, 0, 0, 0.06)",
    "--bg-input": "#ffffff",
    "--text-primary": "#1e293b",
    "--text-secondary": "#64748b",
    "--text-tertiary": "#94a3b8",
    "--text-strong": "#bd387d",
    "--text-code": "#e83e8c",
    "--accent": "#2563eb",
    "--accent-rgb": "37, 99, 235",
    "--accent-hover": "#1d4ed8",
    "--danger": "#dc2626",
    "--border": "#d1d9e6",
  },
  "black-yellow": {
    "--bg-primary": "#272729",
    "--bg-secondary": "#232325",
    "--bg-surface": "#333336",
    "--bg-hover": "rgba(255, 255, 255, 0.08)",
    "--bg-tertiary": "#2e2e31",
    "--bg-code": "#2d2d30",
    "--bg-code-inline": "rgba(78, 178, 137, 0.12)",
    "--bg-input": "#272729",
    "--text-primary": "#cccccc",
    "--text-secondary": "#818286",
    "--text-tertiary": "#5c5e63",
    "--text-strong": "#f6d679",
    "--text-code": "#f5c2e7",
    "--accent": "#f6d679",
    "--accent-rgb": "246, 214, 121",
    "--accent-hover": "#f6d679",
    "--danger": "#e06c75",
    "--border": "#39393a",
    "--blockquote-border": "#39393a",
    "--blockquote-bg": "transparent",
    "--blockquote-text": "#818286",
    "--metadata-bg": "#232325",
    "--metadata-border": "#39393a",
    "--table-header-bg": "#232325",
    "--table-cell-bg": "transparent",
    "--tag-bg": "rgba(78, 178, 137, 0.18)",
    "--tag-text": "#f6d679",
    "--tag-border": "rgba(78, 178, 137, 0.25)",
    "--scrollbar-thumb": "#39393a",
    "--scrollbar-thumb-hover": "#818286",
    "--scrollbar-track": "transparent",
  },};

const DEFAULT_FONTS: ThemeVariable[] = [
  {
    name: "--font-mono",
    value: '"Cascadia Code", "JetBrains Mono", "Fira Code", "Consolas", monospace',
    type: "font",
  },
  {
    name: "--font-ui",
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    type: "font",
  },
  {
    name: "--editor-font",
    value: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    type: "font",
  },
  { name: "--editor-font-size", value: "16px", type: "size" },
  { name: "--font-mono-size", value: "14px", type: "size" },
];

const DEFAULT_SIZES: ThemeVariable[] = [
  { name: "--sidebar-chrome-opacity", value: "1", type: "size" },
  { name: "--radius-code-block", value: "8px", type: "size" },
  { name: "--radius-code-inline", value: "4px", type: "size" },
  { name: "--padding-code-inline-y", value: "3px", type: "size" },
  { name: "--padding-code-inline-x", value: "6px", type: "size" },
  { name: "--radius-metadata", value: "8px", type: "size" },
  { name: "--blockquote-border-width", value: "3px", type: "size" },
  { name: "--padding-blockquote-y", value: "4px", type: "size" },
  { name: "--padding-blockquote-x", value: "16px", type: "size" },
  { name: "--radius-table", value: "0px", type: "size" },
  { name: "--radius-tag", value: "10px", type: "size" },
  { name: "--padding-tag-y", value: "1px", type: "size" },
  { name: "--padding-tag-x", value: "8px", type: "size" },
  { name: "--radius-scrollbar", value: "4px", type: "size" },
  { name: "--scrollbar-size", value: "8px", type: "size" },
];

function resolveColorTokenValue(
  token: ThemeColorToken,
  colors: Record<string, string>,
  defaults: Record<string, string>,
): string {
  if (colors[token.name]) return colors[token.name];
  if (token.name === "--scrollbar-thumb" && colors["--border"]) return colors["--border"];
  if (token.name === "--scrollbar-thumb-hover" && colors["--text-secondary"]) {
    return colors["--text-secondary"];
  }
  if (token.name === "--scrollbar-track") return colors[token.name] ?? "transparent";
  if (token.name === "--metadata-bg" && colors["--bg-secondary"]) return colors["--bg-secondary"];
  if (token.name === "--metadata-border" && colors["--border"]) return colors["--border"];
  if (token.name === "--blockquote-border" && colors["--border"]) return colors["--border"];
  if (token.name === "--blockquote-bg") return colors[token.name] ?? "transparent";
  if (token.name === "--blockquote-text" && colors["--text-secondary"]) {
    return colors["--text-secondary"];
  }
  if (token.name === "--table-header-bg" && colors["--bg-secondary"]) {
    return colors["--bg-secondary"];
  }
  if (token.name === "--table-cell-bg") return colors[token.name] ?? "transparent";
  if (token.name === "--tag-text" && colors["--accent"]) return colors["--accent"];
  if (token.name === "--tag-bg" && colors["--accent-rgb"]) {
    return `rgba(${colors["--accent-rgb"]}, 0.15)`;
  }
  if (token.name === "--tag-border" && colors["--accent-rgb"]) {
    return `rgba(${colors["--accent-rgb"]}, 0.2)`;
  }
  return defaults[token.name] ?? LIGHT_DEFAULTS[token.name] ?? "#ffffff";
}

export function getBuiltinColorMap(builtinId: string): Record<string, string> | null {
  if (!(BUILTIN_THEMES as readonly string[]).includes(builtinId)) return null;
  return BUILTIN_THEME_COLORS[builtinId as BuiltinThemeName];
}

export function colorMapToVariables(colors: Record<string, string>): ThemeVariable[] {
  return THEME_COLOR_SCHEMA.map((token) => ({
    name: token.name,
    value: resolveColorTokenValue(token, colors, LIGHT_DEFAULTS),
    type: "color" as const,
  }));
}

export function getBuiltinThemeVariables(builtinId: string): ThemeVariable[] | null {
  const colors = getBuiltinColorMap(builtinId);
  if (!colors) return null;
  return [...colorMapToVariables(colors), ...DEFAULT_FONTS, ...DEFAULT_SIZES];
}

export function getTemplateVariables(kind: "light" | "dark"): ThemeVariable[] {
  // 新建自定义主题的模板与仅存的两套内置主题对齐（云白 / 黑黄）
  const colors = BUILTIN_THEME_COLORS[kind === "dark" ? "black-yellow" : "white"];
  return [...colorMapToVariables(colors), ...DEFAULT_FONTS, ...DEFAULT_SIZES];
}

/**
 * Merge parsed CSS vars with the canonical color schema.
 * Missing color tokens get defaults from `fallback` or light template.
 * Non-schema vars (fonts, extras from imports) are preserved after schema colors.
 */
export function mergeWithSchema(
  parsed: ThemeVariable[],
  fallback?: Record<string, string>,
): ThemeVariable[] {
  const byName = new Map(parsed.map((v) => [v.name, v]));
  const defaults = fallback ?? LIGHT_DEFAULTS;
  const parsedColors: Record<string, string> = {};
  for (const v of parsed) {
    parsedColors[v.name] = v.value;
  }
  const colorDefaults: Record<string, string> = { ...LIGHT_DEFAULTS, ...defaults, ...parsedColors };
  const colors: ThemeVariable[] = THEME_COLOR_SCHEMA.map((token) => {
    const existing = byName.get(token.name);
    if (existing) {
      byName.delete(token.name);
      return { ...existing, type: "color" as const };
    }
    return {
      name: token.name,
      value: resolveColorTokenValue(token, colorDefaults, LIGHT_DEFAULTS),
      type: "color" as const,
    };
  });

  // Keep remaining non-color / extra vars (fonts etc.)
  const rest: ThemeVariable[] = [];
  for (const name of PRESERVED_NON_COLOR) {
    const v = byName.get(name);
    if (v) {
      rest.push(v);
      byName.delete(name);
    }
  }
  // Defaults fonts / sizes if missing
  for (const def of [...DEFAULT_FONTS, ...DEFAULT_SIZES]) {
    if (!rest.some((v) => v.name === def.name) && !colors.some((v) => v.name === def.name)) {
      rest.push(def);
    }
  }
  // Any other leftover vars from imported CSS
  for (const v of byName.values()) {
    if (!THEME_COLOR_SCHEMA.some((t) => t.name === v.name)) {
      rest.push(v);
    }
  }

  return [...colors, ...rest];
}

export function getEditableSizeVariables(variables: ThemeVariable[]): ThemeVariable[] {
  const byName = new Map(variables.map((v) => [v.name, v]));
  return THEME_SIZE_SCHEMA.map((token) => {
    const existing = byName.get(token.name);
    if (existing) return { ...existing, type: "size" as const };
    const fallback = DEFAULT_SIZES.find((d) => d.name === token.name);
    return {
      name: token.name,
      value: fallback?.value ?? "0px",
      type: "size" as const,
    };
  });
}

export function getSizeTokenMeta(name: string): ThemeSizeToken | undefined {
  return THEME_SIZE_SCHEMA.find((t) => t.name === name);
}

export function getEditableColorVariables(variables: ThemeVariable[]): ThemeVariable[] {
  const hidden = new Set(
    THEME_COLOR_SCHEMA.filter((t) => t.hidden).map((t) => t.name),
  );
  const schemaNames = new Set(THEME_COLOR_SCHEMA.map((t) => t.name));
  return variables.filter((v) => schemaNames.has(v.name) && !hidden.has(v.name));
}

/** 鎸夌紪杈戝櫒鍏冪礌鍒嗙粍锛岄鑹蹭笌灏哄瀛楁绌挎彃鍦ㄥ悓涓€ section 鍐?*/
export function buildThemeEditorSections(variables: ThemeVariable[]): ThemeEditorSectionView[] {
  const byName = new Map(variables.map((v) => [v.name, v]));

  const resolveColor = (token: ThemeColorToken): ThemeVariable => {
    const existing = byName.get(token.name);
    if (existing) return { ...existing, type: "color" };
    return {
      name: token.name,
      value: LIGHT_DEFAULTS[token.name] ?? "#ffffff",
      type: "color",
    };
  };

  const resolveSize = (token: ThemeSizeToken): ThemeVariable => {
    const existing = byName.get(token.name);
    if (existing) return { ...existing, type: "size" };
    const fallback = DEFAULT_SIZES.find((d) => d.name === token.name);
    return {
      name: token.name,
      value: fallback?.value ?? "0px",
      type: "size",
    };
  };

  return THEME_EDITOR_SECTIONS.map((section) => {
    const fields: ThemeEditorField[] = [];

    for (const token of THEME_COLOR_SCHEMA) {
      if (token.hidden || token.section !== section.id) continue;
      fields.push({ kind: "color", variable: resolveColor(token), meta: token });
    }
    for (const token of THEME_SIZE_SCHEMA) {
      if (token.section !== section.id) continue;
      fields.push({ kind: "size", variable: resolveSize(token), meta: token });
    }

    return {
      id: section.id,
      titleKey: section.titleKey,
      fields,
    };
  }).filter((s) => s.fields.length > 0);
}

/** @deprecated 浣跨敤 buildThemeEditorSections */
export function groupEditableColors(
  variables: ThemeVariable[],
): Record<ThemeEditorSectionId, ThemeVariable[]> {
  const sections = buildThemeEditorSections(variables);
  const result = Object.fromEntries(
    THEME_EDITOR_SECTIONS.map((s) => [s.id, [] as ThemeVariable[]]),
  ) as Record<ThemeEditorSectionId, ThemeVariable[]>;
  for (const section of sections) {
    result[section.id] = section.fields
      .filter((f) => f.kind === "color")
      .map((f) => f.variable);
  }
  return result;
}

export function getTokenMeta(name: string): ThemeColorToken | undefined {
  return THEME_COLOR_SCHEMA.find((t) => t.name === name);
}
