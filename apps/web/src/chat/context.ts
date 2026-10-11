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
