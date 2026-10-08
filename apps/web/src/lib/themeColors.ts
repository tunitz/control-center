import { useEffect, useState } from "react";

/** Reads a CSS custom property from :root (theme tokens). Falls back when unset or outside a browser. */
export function cssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** Turns #rgb, #rrggbb, rgb() or rgba() into rgba() with the given alpha. Other input is returned unchanged. */
export function withAlpha(color: string, alpha: number): string {
  const c = color.trim();
  let r: number, g: number, b: number;
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map(x => x + x).join("");
    r = parseInt(h.slice(0, 2), 16); g = parseInt(h.slice(2, 4), 16); b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*[\d.]+\s*)?\)$/i.exec(c);
    if (!m) return color;
    [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (r > 255 || g > 255 || b > 255) return color;
  }
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Re-renders the caller whenever the effective theme changes ('cc-theme-change' on window). */
export function useThemeTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const on = () => setTick(t => t + 1);
    window.addEventListener("cc-theme-change", on);
    return () => window.removeEventListener("cc-theme-change", on);
  }, []);
  return tick;
}
