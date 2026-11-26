export type ThemeMode = "system" | "light" | "dark";
export type EffectiveTheme = "light" | "dark";

export const THEME_KEY = "cc-theme";
export const THEME_EVENT = "cc-theme-change";
export const THEME_COLORS: Record<EffectiveTheme, string> = { dark: "#0d0e11", light: "#f5f6f8" };
const MODES: readonly ThemeMode[] = ["system", "light", "dark"];

/** Pure: validate a stored value; anything unknown means "system". */
export function parseThemeMode(raw: unknown): ThemeMode {
  return typeof raw === "string" && (MODES as readonly string[]).includes(raw) ? (raw as ThemeMode) : "system";
}

/** Pure: resolve the theme that is actually shown for a mode. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): EffectiveTheme {
  if (mode === "system") return prefersDark ? "dark" : "light";
  return mode;
}

/** Pure: the page background colour used for <meta name="theme-color">. */
export function themeColor(theme: EffectiveTheme): string {
  return THEME_COLORS[theme];
}

const darkQuery = (): MediaQueryList | null =>
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function getThemeMode(): ThemeMode {
  try {
    return parseThemeMode(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

export function effectiveTheme(mode: ThemeMode = getThemeMode()): EffectiveTheme {
  return resolveTheme(mode, darkQuery()?.matches ?? false);
}

let lastEffective: EffectiveTheme | null = null;

/** Applies a mode to the document: data-theme attribute, theme-color meta, change event. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.dataset.theme = mode;
  const eff = effectiveTheme(mode);
  let meta = document.getElementById("theme-color") as HTMLMetaElement | null;
  if (!meta) {
    meta = document.createElement("meta");
    meta.id = "theme-color";
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = themeColor(eff);
  if (eff !== lastEffective) {
    lastEffective = eff;
    window.dispatchEvent(new Event(THEME_EVENT));
  }
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage unavailable: still apply for this session */
  }
  applyTheme(mode);
}

/** Applies the stored mode and re-applies when the OS preference changes while in system mode. */
export function initTheme(): void {
  applyTheme(getThemeMode());
  const mq = darkQuery();
  mq?.addEventListener?.("change", () => {
    if (getThemeMode() === "system") applyTheme("system");
    else lastEffective = effectiveTheme(getThemeMode());
  });
}
