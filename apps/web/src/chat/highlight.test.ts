import { test, expect } from "bun:test";
import { highlightCode, escapeHtml } from "./highlight";

test("escapeHtml escapes the five dangerous characters", () => {
  expect(escapeHtml(`<a href="x">&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
});

test("known language is highlighted, alias resolves", () => {
  const r = highlightCode("const a = 1", "ts");
  expect(r.lang).toBe("typescript");
  expect(r.html).toContain("hljs-keyword");
});

test("unknown language falls back to escaped text with null lang", () => {
  const r = highlightCode("<x>", "brainfuck");
  expect(r.lang).toBeNull();
  expect(r.html).toBe("&lt;x&gt;");
});
