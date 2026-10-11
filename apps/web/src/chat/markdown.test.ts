import { test, expect } from "bun:test";
import { renderMarkdownRaw } from "./markdown";

test("raw html is escaped, never emitted as a tag", () => {
  const out = renderMarkdownRaw("hi <script>alert(1)</script> <img src=x onerror=alert(1)>");
  expect(out).not.toContain("<script");
  expect(out).not.toContain("<img");
  expect(out).toContain("&lt;script&gt;");
});

test("javascript: links lose their href", () => {
  const out = renderMarkdownRaw("[click](javascript:alert(1))");
  expect(out).not.toContain("javascript:");
  expect(out).toContain("click");
});

test("remote images render as links, not images", () => {
  const out = renderMarkdownRaw("![pixel](https://tracker.example/p.png)");
  expect(out).not.toContain("<img");
  expect(out).toContain('href="https://tracker.example/p.png"');
});

test("https links get rel=noreferrer noopener and target=_blank", () => {
  const out = renderMarkdownRaw("[docs](https://example.com/a?b=1&c=2)");
  expect(out).toContain('rel="noreferrer noopener"');
  expect(out).toContain('target="_blank"');
  expect(out).toContain("https://example.com/a?b=1&amp;c=2");
});

test("attribute quotes in link hrefs are escaped", () => {
  const out = renderMarkdownRaw('[x](https://e.com/"onmouseover="a)');
  expect(out).not.toContain('"onmouseover="');
});

test("code block: language label, highlighted tokens, copy button", () => {
  const out = renderMarkdownRaw("```ts\nconst a = 1\n```");
  expect(out).toContain("codeblk");
  expect(out).toContain(">ts<");
  expect(out).toContain("hljs-keyword");
  expect(out).toContain("data-copy");
});

test("unknown code language is escaped plain text", () => {
  const out = renderMarkdownRaw("```nosuchlang\n<b>x</b>\n```");
  expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  expect(out).not.toContain("<b>");
});

test("tables are wrapped for horizontal scroll", () => {
  const out = renderMarkdownRaw("|a|b|\n|-|-|\n|1|2|");
  expect(out).toContain('<div class="tbl-wrap"><table>');
  expect(out).toContain("<td>2</td>");
});
