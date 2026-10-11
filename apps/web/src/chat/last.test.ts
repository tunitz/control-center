import { test, expect } from "bun:test";
import { lastChatHash, rememberChat, forgetChat } from "./last";

// Minimal in-memory Storage stand-in.
const store = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => { m.set(k, String(v)); },
    removeItem: (k: string) => { m.delete(k); },
  };
};

test("no stored id -> #/chat", () => {
  expect(lastChatHash(store())).toBe("#/chat");
});

test("stored id -> #/chat/<encoded id>", () => {
  const s = store();
  rememberChat(s, "s-abc/1 x");
  expect(lastChatHash(s)).toBe("#/chat/" + encodeURIComponent("s-abc/1 x"));
  expect(lastChatHash(s)).toBe("#/chat/s-abc%2F1%20x");
});

test("forgetChat clears the key -> back to #/chat", () => {
  const s = store();
  rememberChat(s, "s-1");
  forgetChat(s);
  expect(s.getItem("cc-chat-last")).toBeNull();
  expect(lastChatHash(s)).toBe("#/chat");
});

test("forgetChat with a different id keeps the stored id", () => {
  const s = store();
  rememberChat(s, "s-1");
  forgetChat(s, "s-2");
  expect(lastChatHash(s)).toBe("#/chat/s-1");
});

test("forgetChat with the stored id clears it", () => {
  const s = store();
  rememberChat(s, "s-1");
  forgetChat(s, "s-1");
  expect(lastChatHash(s)).toBe("#/chat");
});
