import { test, expect } from "bun:test";
import { parseThemeMode, resolveTheme, themeColor, THEME_COLORS, THEME_KEY } from "./theme";

test("storage key is cc-theme", () => {
  expect(THEME_KEY).toBe("cc-theme");
});

test("parseThemeMode accepts only the three modes", () => {
  expect(parseThemeMode("light")).toBe("light");
  expect(parseThemeMode("dark")).toBe("dark");
  expect(parseThemeMode("system")).toBe("system");
});

test("parseThemeMode falls back to system for missing or invalid values", () => {
  expect(parseThemeMode(null)).toBe("system");
  expect(parseThemeMode(undefined)).toBe("system");
  expect(parseThemeMode("")).toBe("system");
  expect(parseThemeMode("DARK")).toBe("system");
  expect(parseThemeMode("blue")).toBe("system");
  expect(parseThemeMode(1)).toBe("system");
});

test("resolveTheme follows an explicit mode regardless of the OS preference", () => {
  expect(resolveTheme("light", true)).toBe("light");
  expect(resolveTheme("light", false)).toBe("light");
  expect(resolveTheme("dark", true)).toBe("dark");
  expect(resolveTheme("dark", false)).toBe("dark");
});

test("resolveTheme follows the OS preference in system mode", () => {
  expect(resolveTheme("system", true)).toBe("dark");
  expect(resolveTheme("system", false)).toBe("light");
});

test("themeColor returns the page background for each theme", () => {
  expect(THEME_COLORS.dark).toBe("#0d0e11");
  expect(THEME_COLORS.light).toBe("#f5f6f8");
  expect(themeColor("dark")).toBe("#0d0e11");
  expect(themeColor("light")).toBe("#f5f6f8");
});
