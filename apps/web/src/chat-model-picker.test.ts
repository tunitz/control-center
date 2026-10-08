import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chat model picker: a Provider select, then a Model select filtered to that provider.
const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
const page = readFileSync(join(import.meta.dir, "pages", "Chat.tsx"), "utf8");

test("chat page builds provider groups from the model options payload", () => {
  expect(page).toMatch(/modelGroups\(r\)/);
});

test("chat page has a Provider select", () => {
  expect(page).toMatch(/aria-label="Provider"/);
});

test("model select only renders once a provider is chosen and has the pick class", () => {
  expect(page).toMatch(/providerSlug\s*!==\s*""\s*&&/);
  expect(page).toMatch(/className="chat-model-pick"/);
});

test("picking a provider resets the chosen model", () => {
  expect(page).toMatch(/setProviderSlug\([^)]*\);\s*setModelValue\(""\)/);
});

test("styles put the model pick on its own full-width row", () => {
  expect(css).toMatch(/\.chat-model \.chat-model-pick/);
});
