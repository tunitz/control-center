import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phone layout: the chat must fit one screen with no page scroll.
const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
const mobile = /@media \(max-width:760px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

test("phone chat sits in the viewport height (dvh with vh fallback)", () => {
  expect(mobile).toMatch(/height:\s*calc\(100dvh - \d+px\)/);
});

test("phone session list is a horizontal strip, not a stacked column", () => {
  expect(mobile).toMatch(/\.chat-list\{[^}]*flex-direction:\s*row/);
});

test("phone session list scrolls sideways instead of growing the page", () => {
  expect(mobile).toMatch(/\.chat-list\{[^}]*overflow-x:\s*auto/);
});
