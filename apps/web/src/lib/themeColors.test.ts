import { test, expect } from "bun:test";
import { withAlpha } from "./themeColors";

test("withAlpha converts #rrggbb", () => {
  expect(withAlpha("#38e1ff", 0.5)).toBe("rgba(56, 225, 255, 0.5)");
});

test("withAlpha expands #rgb shorthand", () => {
  expect(withAlpha("#fff", 0.14)).toBe("rgba(255, 255, 255, 0.14)");
});

test("withAlpha accepts rgb()", () => {
  expect(withAlpha("rgb(1,2,3)", 0.3)).toBe("rgba(1, 2, 3, 0.3)");
});

test("withAlpha overrides the alpha of rgba()", () => {
  expect(withAlpha("rgba(1,2,3,.5)", 0.2)).toBe("rgba(1, 2, 3, 0.2)");
});

test("withAlpha returns invalid input unchanged", () => {
  expect(withAlpha("var(--s1)", 0.5)).toBe("var(--s1)");
  expect(withAlpha("notacolor", 0.5)).toBe("notacolor");
});
