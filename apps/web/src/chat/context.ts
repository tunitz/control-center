import type { ChatMessage } from "./types";

/** Compact token count: 950, 14.2k, 200k, 1M. */
export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`.replace(/\.0M$/, "M");
  if (n >= 100_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${Math.round(n / 100) / 10}k`.replace(/\.0k$/, "k");
  return String(n);
}

export function contextMeter(input: number | null, windowSize: number | undefined) {
  if (input == null || !windowSize) return null;
  const pct = Math.min(100, Math.max(0, Math.round((input / windowSize) * 1000) / 10));
  return { used: input, max: windowSize, pct, label: `${fmtTokens(input)} / ${fmtTokens(windowSize)}` };
}

/** Input tokens of the newest assistant message that reported usage. */
export function lastInputTokens(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.usage) return m.usage.input;
  }
  return null;
}

/** The prompt size of the newest reply that reported one (Pi sends it as `usage.context`). */
export function reportedContext(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && typeof m.usage?.context === "number" && m.usage.context > 0) return m.usage.context;
  }
  return null;
}

/** Fixed prompt Hermes sends every call (system prompt + tool schemas); measured: a one-word chat reports ~23k input. */
export const BASE_CONTEXT_TOKENS = 23_000;

/**
 * Size of the current context.
 *
 * Pi reports the real figure: the prompt of its last model call, cache included. Use it as-is. A Pi chat whose
 * replies predate that field has nothing trustworthy, so the meter stays hidden rather than showing a tiny number
 * (`input` alone is just the uncached tail, often single digits).
 *
 * Hermes reports input tokens summed over every model call (each tool call re-sends the whole chat), so that
 * figure is not the context. There it is an estimate: base prompt + visible chat text at ~4 chars per token,
 * capped by the last turn's reported input (a true upper bound). Only loaded messages count; tool output is not
 * in the mirror, so long tool-heavy chats read low.
 */
export function estimateContextTokens(messages: ChatMessage[], backend: "hermes" | "pi" = "hermes"): number | null {
  if (messages.length === 0) return null;
  const reported = reportedContext(messages);
  if (reported !== null) return reported;
  if (backend === "pi") return null;
  let chars = 0;
  for (const m of messages) {
    chars += m.text.length + (m.reasoning?.length ?? 0);
    for (const t of m.tools) chars += JSON.stringify(t.args ?? {}).length + (t.preview?.length ?? 0);
  }
  const est = BASE_CONTEXT_TOKENS + Math.ceil(chars / 4);
  const last = lastInputTokens(messages);
  return last != null ? Math.min(est, last) : est;
}
