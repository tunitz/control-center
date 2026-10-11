/** Usage helpers. Hermes reports input/output tokens per run; there is no cost model in v1. */
export type Usage = { input: number; output: number };

export function sumUsage(list: (Usage | null | undefined)[]): Usage {
  const total = { input: 0, output: 0 };
  for (const u of list) {
    if (!u) continue;
    total.input += u.input;
    total.output += u.output;
  }
  return total;
}

/** Context meter percentage, clamped to 0..100. */
export function contextPct(usedTokens: number, windowTokens: number): number {
  if (windowTokens <= 0) return 0;
  return Math.min(100, Math.round((usedTokens / windowTokens) * 100));
}
