import { test, expect } from "bun:test";
import { autoTitle } from "./title";
import { sumUsage, contextPct } from "./usage";
import { toMarkdown, exportFilename } from "./export";

test("autoTitle: first 8 words of the first user message, whitespace collapsed", () => {
  expect(autoTitle("one two  three\nfour five six seven eight nine ten")).toBe("one two three four five six seven eight");
  expect(autoTitle("short")).toBe("short");
  expect(autoTitle("   ")).toBe("New chat");
  expect(autoTitle("x".repeat(300)).length).toBeLessThanOrEqual(80);
});

test("usage helpers", () => {
  expect(sumUsage([{ input: 1, output: 2 }, { input: 10, output: 20 }, null])).toEqual({ input: 11, output: 22 });
  expect(sumUsage([])).toEqual({ input: 0, output: 0 });
  expect(contextPct(50000, 200000)).toBe(25);
  expect(contextPct(300000, 200000)).toBe(100);
  expect(contextPct(10, 0)).toBe(0);
});

test("toMarkdown renders title, roles, text, attachments and non-complete markers, not reasoning", () => {
  const md = toMarkdown({
    title: "My chat", model: "claude-sonnet-5-5", createdAt: Date.UTC(2026, 9, 11),
    messages: [
      { role: "user", text: "hi", status: "complete", reasoning: null, attachments: [{ name: "a.png" }] },
      { role: "assistant", text: "hello", status: "complete", reasoning: "secret thoughts", attachments: [] },
      { role: "assistant", text: "partial", status: "interrupted", reasoning: null, attachments: [] },
    ],
  });
  expect(md.startsWith("# My chat")).toBe(true);
  expect(md).toContain("## You");
  expect(md).toContain("hi");
  expect(md).toContain("Attachment: a.png");
  expect(md).toContain("## Assistant");
  expect(md).toContain("hello");
  expect(md).not.toContain("secret thoughts");
  expect(md).toContain("_(interrupted)_");
});

test("exportFilename is safe and unicode-friendly", () => {
  expect(exportFilename("My chat / ../x")).toBe("My-chat-x.md");
  expect(exportFilename("资料 笔记")).toBe("资料-笔记.md");
  expect(exportFilename("")).toBe("chat.md");
  expect(exportFilename("a\r\n\"b\"")).toMatch(/^[\p{L}\p{N}-]+\.md$/u);
});
