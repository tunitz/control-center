import { expect, test } from "bun:test";
import { creditsMarkdown } from "./credits";

test("Discord small-text lines become italics and the rest is untouched", () => {
  const raw = "**🐋 DeepSeek · $0.34 left**\nTopped up $0.34\n-# Checked 2026-10-12 07:31 PST\n";
  expect(creditsMarkdown(raw)).toBe("**🐋 DeepSeek · $0.34 left**\nTopped up $0.34\n*Checked 2026-10-12 07:31 PST*");
});

test("a dash line that is not Discord small text is left alone", () => {
  expect(creditsMarkdown("- item\n-#tag")).toBe("- item\n-#tag");
});
