import type { PiCompaction } from "../chat/types";

/** Same bounds the bridge enforces (pi-bridge/src/pi-config.ts). The UI checks first; the bridge is the authority. */
export const COMPACTION_LIMITS = {
  compactAtTokens: { min: 50000, max: 900000 },
  keepRecentTokens: { min: 5000, max: 100000 },
} as const;

/** The fields that differ from the saved value, or undefined when nothing changed. */
export function compactionPatch(saved: PiCompaction, next: PiCompaction): Partial<PiCompaction> | undefined {
  const patch: Partial<PiCompaction> = {};
  if (next.enabled !== saved.enabled) patch.enabled = next.enabled;
  if (next.compactAtTokens !== saved.compactAtTokens) patch.compactAtTokens = next.compactAtTokens;
  if (next.keepRecentTokens !== saved.keepRecentTokens) patch.keepRecentTokens = next.keepRecentTokens;
  return Object.keys(patch).length > 0 ? patch : undefined;
}

/** A user-facing reason the draft cannot be saved, or null when it is valid. */
export function compactionError(c: PiCompaction): string | null {
  const { compactAtTokens: a, keepRecentTokens: k } = COMPACTION_LIMITS;
  if (!Number.isInteger(c.compactAtTokens)) return "Compact threshold must be a whole number.";
  if (c.compactAtTokens < a.min || c.compactAtTokens > a.max) return `Compact threshold must be from ${a.min} to ${a.max} tokens.`;
  if (!Number.isInteger(c.keepRecentTokens)) return "Keep recent must be a whole number.";
  if (c.keepRecentTokens < k.min || c.keepRecentTokens > k.max) return `Keep recent must be from ${k.min} to ${k.max} tokens.`;
  return null;
}
