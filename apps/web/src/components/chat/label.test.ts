import { test, expect } from "bun:test";
import { shortModelLabel } from "./label";

test("shortModelLabel strips the Claude prefix for the phone pill", () => {
  expect(shortModelLabel("Claude Sonnet 5.5")).toBe("Sonnet 5.5");
  expect(shortModelLabel("claude Opus 4")).toBe("Opus 4");
});

test("shortModelLabel keeps labels without the prefix and never returns empty", () => {
  expect(shortModelLabel("Haiku 4")).toBe("Haiku 4");
  expect(shortModelLabel("Claude")).toBe("Claude");
  expect(shortModelLabel("Claude  ")).toBe("Claude  ".trim());
});
