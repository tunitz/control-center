import type { Database } from "bun:sqlite";

export type Mount = { mount: string; fs: string; total_mb: number; used_mb: number };
export type DiskSnapshot = { ts: number; mounts: Mount[] } | null;

const finite = (v: unknown): v is number => typeof v === "number" && isFinite(v);

/** Keeps only well-formed mount entries, renamed to the API shape {mount,fs,total_mb,used_mb}. */
export function normaliseMounts(raw: unknown): Mount[] {
  if (!Array.isArray(raw)) return [];
  const out: Mount[] = [];
  for (const d of raw) {
    if (!d || typeof d !== "object") continue;
    const o = d as Record<string, unknown>;
    if (typeof o.m !== "string" || typeof o.fs !== "string" || !finite(o.total_mb) || !finite(o.used_mb)) continue;
    out.push({ mount: o.m, fs: o.fs, total_mb: o.total_mb, used_mb: o.used_mb });
  }
  return out;
}

/**
 * Stores the newest `disks` snapshot seen for a unit (latest-only). A snapshot older than the stored
 * one (late batch) never overwrites it. Samples without `disks` leave the stored snapshot untouched.
 */
export function storeDisks(db: Database, unitId: number, ts: number, raw: unknown) {
  const mounts = normaliseMounts(raw);
  if (!mounts.length && !Array.isArray(raw)) return;
  db.query(
    `INSERT INTO unit_disks(unit_id, ts, json) VALUES(?,?,?)
     ON CONFLICT(unit_id) DO UPDATE SET ts=excluded.ts, json=excluded.json WHERE excluded.ts >= unit_disks.ts`
  ).run(unitId, ts, JSON.stringify(mounts));
}

/** Latest disk snapshot for a unit, or null when the agent has never reported one. */
export function latestDisks(db: Database, unitId: number): DiskSnapshot {
  const r = db.query("SELECT ts, json FROM unit_disks WHERE unit_id=?").get(unitId) as { ts: number; json: string } | null;
  return r ? { ts: r.ts, mounts: JSON.parse(r.json) as Mount[] } : null;
}
