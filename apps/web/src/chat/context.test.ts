import { test, expect } from "bun:test";
import { contextMeter, lastInputTokens, fmtTokens } from "./context";
import type { ChatMessage } from "./types";

test("fmtTokens: plain, k with one decimal under 100k, k rounded above", () => {
  expect(fmtTokens(950)).toBe("950");
  expect(fmtTokens(14200)).toBe("14.2k");
  expect(fmtTokens(200000)).toBe("200k");
  expect(fmtTokens(1_000_000)).toBe("1M");
});

test("meter: percent clamped to 0..100, unknown window gives null", () => {
  expect(contextMeter(14200, 200000)).toEqual({ used: 14200, max: 200000, pct: 7.1, label: "14.2k / 200k" });
  expect(contextMeter(300000, 200000).pct).toBe(100);
  expect(contextMeter(10, undefined)).toBeNull();
  expect(contextMeter(null, 200000)).toBeNull();
});

test("last input tokens come from the newest assistant usage", () => {
  const m = (role: "user" | "assistant", usage: any): ChatMessage => ({ id: Math.random().toString(), seq: 0, role, text: "", reasoning: null, tools: [], usage, status: "complete", runId: null, model: null, attachments: [], createdAt: 0, error: null });
  expect(lastInputTokens([m("assistant", { input: 100, output: 1 }), m("user", null), m("assistant", { input: 900, output: 5 }), m("assistant", null)])).toBe(900);
  expect(lastInputTokens([])).toBeNull();
});

import { estimateContextTokens, BASE_CONTEXT_TOKENS } from "./context";
test("estimateContextTokens: base + chars/4, capped by last reported input, never the cumulative sum", () => {
  const mk = (role: "user" | "assistant", text: string, usage: { input: number; output: number } | null = null) =>
    ({ id: "x", seq: 1, role, text, reasoning: null, tools: [], usage, status: "complete", runId: null, model: null, attachments: [], createdAt: 0, error: null }) as any;
  expect(estimateContextTokens([])).toBeNull();
  expect(estimateContextTokens([mk("user", "x".repeat(4000)), mk("assistant", "y".repeat(400))])).toBe(BASE_CONTEXT_TOKENS + 1100);
  // 3.1M cumulative input must not read as context
  expect(estimateContextTokens([mk("user", "hi"), mk("assistant", "ok", { input: 3_184_043, output: 5 })])).toBe(BASE_CONTEXT_TOKENS + 1);
  expect(estimateContextTokens([mk("user", "x".repeat(400000)), mk("assistant", "ok", { input: 30_000, output: 5 })])).toBe(30_000);
});
