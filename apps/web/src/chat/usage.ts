// Formatting for token usage: the per-reply details row and the `/usage` report. Pure, so it is unit-tested.
import { fmtTokens } from "./context";
import type { TokenUsage, UsageReport } from "./types";

const exact = (n: number): string => Math.round(n).toLocaleString("en-US");

/** Everything the prompt held: the uncached part plus what came from, or went into, the provider's cache. */
export const promptTokens = (u: Pick<TokenUsage, "input" | "cacheRead" | "cacheWrite">): number =>
  u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);

/** 420ms, 1.2s, 2m 05s. */
export function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(Math.round(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/** $0.0012 for fractions of a cent, $0.45 above that. */
export const fmtCost = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;

/** The short line under a reply. Context when known (Pi), otherwise the whole prompt; then output and first-token time. */
export function usageSummary(u: TokenUsage): string[] {
  const parts: string[] = [];
  if (typeof u.context === "number") parts.push(`${fmtTokens(u.context)} context`);
  else parts.push(`${fmtTokens(promptTokens(u))} in`);
  parts.push(`${fmtTokens(u.output)} out`);
  if (typeof u.ttftMs === "number") parts.push(`first token ${fmtMs(u.ttftMs)}`);
  return parts;
}

export type UsageRow = { label: string; value: string };

/** The expanded breakdown for one reply: only the figures the backend actually reported. */
export function usageRows(u: TokenUsage): UsageRow[] {
  const rows: UsageRow[] = [];
  if (typeof u.context === "number") rows.push({ label: "Context now", value: exact(u.context) });
  rows.push({ label: "Input, uncached", value: exact(u.input) });
  if (typeof u.cacheRead === "number") {
    const p = promptTokens(u);
    const pct = p > 0 ? ` (${Math.round((u.cacheRead / p) * 100)}% of the prompt)` : "";
    rows.push({ label: "Cache read", value: `${exact(u.cacheRead)}${pct}` });
  }
  if (typeof u.cacheWrite === "number") rows.push({ label: "Cache write", value: exact(u.cacheWrite) });
  rows.push({ label: "Output", value: exact(u.output) });
  rows.push({ label: "Total processed", value: exact(promptTokens(u) + u.output) });
  if (typeof u.calls === "number") rows.push({ label: "Model calls", value: exact(u.calls) });
  if (typeof u.ttftMs === "number") rows.push({ label: "First token", value: fmtMs(u.ttftMs) });
  if (typeof u.durationMs === "number") rows.push({ label: "Duration", value: fmtMs(u.durationMs) });
  if (typeof u.costUsd === "number" && u.costUsd > 0) rows.push({ label: "Cost", value: fmtCost(u.costUsd) });
  return rows;
}

/** The text of the `/usage` command row: totals over the whole chat. `windowSize` is the model's context window. */
export function usageReportText(r: UsageReport, windowSize?: number | null): string {
  if (r.totals.replies === 0) return "No token usage recorded in this chat yet.";
  const t = r.totals;
  const lines: string[] = [];
  const ctx = r.last?.context ?? null;
  if (ctx !== null) {
    const pct = windowSize ? ` (${Math.min(100, Math.round((ctx / windowSize) * 1000) / 10)}%)` : "";
    lines.push(`Context now: ${exact(ctx)}${windowSize ? ` / ${fmtTokens(windowSize)}` : ""}${pct}`);
  }
  if (r.compactions) lines.push(`Compacted: ${r.compactions} ${r.compactions === 1 ? "time" : "times"}`);
  lines.push(`Input, uncached: ${exact(t.input)}`);
  lines.push(`Cache read: ${exact(t.cacheRead)}`);
  lines.push(`Cache write: ${exact(t.cacheWrite)}`);
  lines.push(`Output: ${exact(t.output)}`);
  lines.push(`Total processed: ${exact(t.total)}`);
  lines.push(t.calls > 0 ? `Model calls: ${exact(t.calls)} across ${t.replies} ${t.replies === 1 ? "reply" : "replies"}` : `Replies: ${t.replies}`);
  if (r.avgTtftMs !== null) lines.push(`Average first token: ${fmtMs(r.avgTtftMs)}`);
  if (t.costUsd > 0) lines.push(`Cost: ${fmtCost(t.costUsd)}`);
  return lines.join("\n");
}
