/** One place for relative time and sample-freshness labels used across the dashboard. */
export function relativeTime(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Prominent label for a unit's last sample. `ts` is epoch seconds. */
export function sampleLabel(ts: number | null | undefined, fresh: boolean | undefined, now = Date.now()): string {
  if (ts == null || !isFinite(ts)) return "No sample yet";
  const age = relativeTime(ts * 1000, now);
  return fresh === false ? `Stale sample · ${age}` : `Sample ${age}`;
}

export function localTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}
