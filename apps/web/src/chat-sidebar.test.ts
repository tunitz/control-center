import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chat sidebar: a fixed sidebar on desktop, a slide-in drawer on phones.
const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");
const page = readFileSync(join(import.meta.dir, "pages", "Chat.tsx"), "utf8");
const mobile = /@media \(max-width:760px\)\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";

test("chat page has a menu button that opens the chat list", () => {
  expect(page).toMatch(/className="btn chat-menu"[^>]*aria-label="Open chats"/);
});

test("chat page has a scrim that closes the drawer", () => {
  expect(page).toMatch(/className="chat-scrim"/);
});

test("phone sidebar is an off-canvas drawer", () => {
  expect(mobile).toMatch(/\.chat-side\{[^}]*position:\s*fixed/);
  expect(mobile).toMatch(/\.chat-side\{[^}]*transform:\s*translateX\(-/);
});

test("phone drawer slides in when open", () => {
  expect(mobile).toMatch(/\.chat-side\.open\{[^}]*transform:\s*none/);
});

test("phone session list is a vertical column inside the drawer", () => {
  expect(mobile).toMatch(/\.chat-list\{[^}]*flex-direction:\s*column/);
  expect(mobile).toMatch(/\.chat-list\{[^}]*overflow-y:\s*auto/);
});

test("menu button and scrim are hidden on desktop", () => {
  expect(css).toMatch(/\.chat-menu,\.chat-close,\.chat-scrim\{display:none\}/);
});
