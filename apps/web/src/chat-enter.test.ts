import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chat textarea: Enter inserts a newline; only the Send button sends.
const page = readFileSync(join(import.meta.dir, "pages", "Chat.tsx"), "utf8");

test("chat textarea has no Enter-to-send key handler", () => {
  expect(page).not.toMatch(/onKeyDown=\{[^}]*Enter/);
  expect(page).not.toMatch(/e\.key === "Enter"/);
});
