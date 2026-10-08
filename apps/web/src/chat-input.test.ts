import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Chat inputs must be readable (explicit colour) and at least 16px, or iOS Safari zooms on focus.
const css = readFileSync(join(import.meta.dir, "styles.css"), "utf8");

function ruleBody(selector: string): string {
  const re = new RegExp(`(^|\\})\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "m");
  const m = re.exec(css);
  return m ? m[2] : "";
}

test("chat message textarea has an explicit text colour", () => {
  expect(ruleBody(".chat-compose textarea")).toMatch(/color\s*:/);
});

test("chat message textarea font is at least 16px so iOS does not zoom on focus", () => {
  const size = /font-size\s*:\s*(\d+)px/.exec(ruleBody(".chat-compose textarea"));
  expect(size).not.toBeNull();
  expect(Number(size![1])).toBeGreaterThanOrEqual(16);
});

test("chat rename input is at least 16px too", () => {
  const size = /font-size\s*:\s*(\d+)px/.exec(ruleBody(".chat-rename input"));
  expect(size).not.toBeNull();
  expect(Number(size![1])).toBeGreaterThanOrEqual(16);
});
