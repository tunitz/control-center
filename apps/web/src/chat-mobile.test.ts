import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Phone layout: the chat must fit one screen with no page scroll.
const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
const mobile = /@media \(max-width:760px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

test("phone chat sits in the viewport height (dvh with vh fallback)", () => {
  expect(mobile).toMatch(/height:\s*calc\(100dvh - \d+px\)/);
});

test("phone session list is a vertical column inside the drawer", () => {
  expect(mobile).toMatch(/\.chat-list\{[^}]*flex-direction:\s*column/);
});

test("phone session list scrolls vertically inside the drawer", () => {
  expect(mobile).toMatch(/\.chat-list\{[^}]*overflow-y:\s*auto/);
});
