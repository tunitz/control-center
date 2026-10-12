import { test, expect } from "bun:test";
import { fmtCost, fmtMs, promptTokens, usageReportText, usageRows, usageSummary } from "./usage";
import { estimateContextTokens, reportedContext } from "./context";
import { parseUsage } from "./reduce";
import type { ChatMessage } from "./types";

const msg = (role: "user" | "assistant", usage: ChatMessage["usage"], text = ""): ChatMessage =>
  ({ id: "x", seq: 1, role, text, reasoning: null, tools: [], usage, status: "complete", runId: null, model: null, attachments: [], createdAt: 0, error: null });

// The numbers behind the "22 in" the chat showed: input is only the uncached tail.
const CACHED = { input: 22, output: 8700, cacheRead: 548_772, cacheWrite: 3_884, context: 552_678, calls: 12, ttftMs: 1_240, durationMs: 41_000 };

test("promptTokens is input plus cache read and write, so a cached prompt is not read as 22 tokens", () => {
  expect(promptTokens({ input: 22 })).toBe(22);
  expect(promptTokens(CACHED)).toBe(552_678);
});

test("fmtMs and fmtCost", () => {
  expect(fmtMs(420)).toBe("420ms");
  expect(fmtMs(1240)).toBe("1.2s");
  expect(fmtMs(59_949)).toBe("59.9s");
  expect(fmtMs(125_000)).toBe("2m 05s");
  expect(fmtCost(0.0012)).toBe("$0.0012");
  expect(fmtCost(0.456)).toBe("$0.46");
});

test("usageSummary: context when known, else the whole prompt; output", () => {
  expect(usageSummary(CACHED)).toEqual(["553k context", "8.7k out"]);
  expect(usageSummary({ input: 22960, output: 10 })).toEqual(["23k in", "10 out"]);
  // Hermes with cache counters: "in" counts the cache too.
  expect(usageSummary({ input: 100, output: 7, cacheRead: 8000, cacheWrite: 1000 })).toEqual(["9.1k in", "7 out"]);
});

test("usageRows lists only what was reported, with the cache share of the prompt", () => {
  const labels = (u: ChatMessage["usage"]) => usageRows(u!).map(r => r.label);
  expect(labels({ input: 5, output: 1 })).toEqual(["Input, uncached", "Output", "Total processed"]);
  expect(labels(CACHED)).toEqual(["Context now", "Input, uncached", "Cache read", "Cache write", "Output", "Total processed", "Model calls", "First token", "Duration"]);
  const rows = Object.fromEntries(usageRows(CACHED).map(r => [r.label, r.value]));
  expect(rows["Cache read"]).toBe("548,772 (99% of the prompt)");
  expect(rows["Total processed"]).toBe("561,378");
  expect(usageRows({ ...CACHED, costUsd: 0.5 }).at(-1)).toEqual({ label: "Cost", value: "$0.50" });
  // A zero cost (subscription) is not worth a row.
  expect(labels({ ...CACHED, costUsd: 0 })).not.toContain("Cost");
});

test("the Pi context meter reads the reported prompt, not the 22 uncached tokens", () => {
  const chat = [msg("user", null, "hi"), msg("assistant", CACHED, "ok")];
  expect(reportedContext(chat)).toBe(552_678);
  expect(estimateContextTokens(chat, "pi")).toBe(552_678);
  // Newest reply with a figure wins; a reply still running (no usage yet) is skipped.
  expect(estimateContextTokens([...chat, msg("user", null, "more"), msg("assistant", null)], "pi")).toBe(552_678);
});

test("a Pi chat whose replies carry no context hides the meter instead of showing a tiny number", () => {
  const old = [msg("user", null, "hi"), msg("assistant", { input: 22, output: 8700 }, "ok")];
  expect(estimateContextTokens(old, "pi")).toBeNull();
  // Hermes keeps its estimate, capped by the last reported input.
  expect(estimateContextTokens(old, "hermes")).toBe(22);
});

test("parseUsage keeps the two counters and only the numeric extras", () => {
  expect(parseUsage({ input: 3, output: 4 })).toEqual({ input: 3, output: 4 });
  expect(parseUsage({ input: "x", output: null, cacheRead: 9, context: 12, ttftMs: "fast", extra: 1 })).toEqual({ input: 0, output: 0, cacheRead: 9, context: 12 });
});

test("usageReportText: whole-chat totals, context against the window, replies vs calls", () => {
  const report = {
    totals: { input: 6, output: 1000, cacheRead: 1_010_000, cacheWrite: 4000, total: 1_015_006, calls: 4, costUsd: 0.5, replies: 2 },
    avgTtftMs: 2000, last: { context: 510_004, ttftMs: 3000, durationMs: 4000 },
  };
  expect(usageReportText(report, 1_000_000).split("\n")).toEqual([
    "Context now: 510,004 / 1M (51%)",
    "Input, uncached: 6",
    "Cache read: 1,010,000",
    "Cache write: 4,000",
    "Output: 1,000",
    "Total processed: 1,015,006",
    "Model calls: 4 across 2 replies",
    "Average first token: 2.0s",
    "Cost: $0.50",
  ]);
  // Hermes: no context, no calls, no cost.
  const hermes = { totals: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0, total: 105, calls: 0, costUsd: 0, replies: 1 }, avgTtftMs: null, last: { context: null, ttftMs: null, durationMs: null } };
  expect(usageReportText(hermes, 200_000)).toBe("Input, uncached: 100\nCache read: 0\nCache write: 0\nOutput: 5\nTotal processed: 105\nReplies: 1");
  expect(usageReportText({ ...hermes, totals: { ...hermes.totals, replies: 0 } })).toBe("No token usage recorded in this chat yet.");
});
