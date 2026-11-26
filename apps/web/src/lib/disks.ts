import type { Sample } from "../api";

export type DiskMount = { mount: string; fs: string; total_mb: number; used_mb: number; available_mb?: number };
export type DiskSnapshot = { ts: number; mounts: DiskMount[] } | null;
export type DiskTone = "ok" | "warn" | "err";

const TONE_VAR: Record<DiskTone, string> = { ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)" };

/** Used share of a mount, 0–100. Zero-size or bad numbers read as 0. */
export function usagePct(m: DiskMount): number {
  if (!(m.total_mb > 0) || !isFinite(m.used_mb)) return 0;
  return Math.min(100, Math.max(0, (m.used_mb / m.total_mb) * 100));
}

/** Under 80% ok, 80–90% warn, over 90% err. */
export function usageTone(pct: number): DiskTone {
  if (pct > 90) return "err";
  if (pct >= 80) return "warn";
  return "ok";
}

export const toneColor = (t: DiskTone): string => TONE_VAR[t];

/** Space actually available to the user, never negative. `df` avail accounts for reserved blocks. */
export function freeMb(m: DiskMount): number {
  return Math.max(0, m.available_mb ?? (m.total_mb - m.used_mb));
}

// Values are MiB (divided by 1024), so use the binary suffix rather than calling them GB.
const gbText = (mb: number) => (mb / 1024).toFixed(1) + " GiB";

/** "120.5 GiB available of 500.0 GiB" */
export function freeLine(m: DiskMount): string {
  return `${gbText(freeMb(m))} available of ${gbText(m.total_mb)}`;
}

/** Picks KiB/s or MiB/s for a rate chart from the highest value seen. */
export function rateUnit(peakKbs: number | null | undefined): { scale: number; unit: string } {
  return peakKbs != null && peakKbs >= 1024 ? { scale: 1 / 1024, unit: " MiB/s" } : { scale: 1, unit: " KiB/s" };
}

/** True when at least one sample in the range has a value for this key. */
export function hasSeries(points: Sample[], key: string): boolean {
  return points.some(p => p[key] != null);
}
