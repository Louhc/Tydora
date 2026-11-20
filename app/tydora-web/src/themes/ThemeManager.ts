/**
 * 内置应用主题仅保留两套（用户要求）：云白（浅）+ 黑黄（深）。
 * 黑黄由用户自定义主题 custom-8cmdpx91 提升而来（变量见 themes.css / themeTokens）。
 */
export const BUILTIN_THEMES = ["white", "black-yellow"] as const;

/** 已提升为内置的旧自定义主题 id → 新内置 id（偏好迁移用） */
export const PROMOTED_CUSTOM_THEMES: Record<string, BuiltinThemeName> = {
  "custom-8cmdpx91": "black-yellow",
};

export type BuiltinThemeName = (typeof BUILTIN_THEMES)[number];

export function isBuiltinTheme(theme: string): theme is BuiltinThemeName {
  return (BUILTIN_THEMES as readonly string[]).includes(theme);
}

export function isCustomTheme(theme: string): boolean {
  return theme.startsWith("custom-");
}

export function getThemeIdFromCustom(customTheme: string): string | null {
  if (!customTheme.startsWith("custom-")) return null;
  return customTheme.replace("custom-", "");
}
