import type { Database } from "bun:sqlite";
import { METRICS } from "./db";
import { storeDisks } from "./disks";
import { replaceEnergy } from "./energy";

/** Energy for one interval in watt-hours; gaps and clock jumps contribute nothing. */
export function computeEnergy(o: { dt: number; cpuW: number | null; gpuW: number | null; dCpuUj: number | null; dGpuUj: number | null; interval: number }): number {
  if (o.dt <= 0 || o.dt > o.interval * 3) return 0; // gap or clock jump: never interpolate
  const part = (dUj: number | null, w: number | null) => dUj != null && dUj >= 0 ? dUj / 1e6 : w != null ? w * o.dt : 0;
  return (part(o.dCpuUj, o.cpuW) + part(o.dGpuUj, o.gpuW)) / 3600;
}

const num = (v: unknown): number | null => (typeof v === "number" && isFinite(v) ? v : null);

/** Insert JSONL samples; duplicates (unit_id, ts) are ignored. Returns number of new rows. */
export function ingestLines(db: Database, unitId: number, lines: string[], interval: number): number {
  const parsed: Record<string, unknown>[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    try { const o = JSON.parse(t); if (typeof o.ts === "number") parsed.push(o); } catch { /* skip corrupt line */ }
  }
  parsed.sort((a, b) => (a.ts as number) - (b.ts as number));
  const cols = ["unit_id", "ts", ...METRICS, "cpu_uj", "gpu_uj", "e_wh"];
  const ins = db.query(`INSERT OR IGNORE INTO samples_raw(${cols.join(",")}) VALUES(${cols.map(() => "?").join(",")})`);
  const updateSample = db.query("UPDATE units SET last_sample_ts=MAX(COALESCE(last_sample_ts,0),?) WHERE id=?");
  let added = 0;
  db.transaction(() => {
    for (const o of parsed) {
      const ts = o.ts as number;
      if (Array.isArray(o.disks)) storeDisks(db, unitId, ts, o.disks);
      const r = ins.run(unitId, ts, ...METRICS.map(m => num(o[m])), num(o.cpu_uj), num(o.gpu_uj), 0);
      if (r.changes === 0) continue;
      added++;
      updateSample.run(ts, unitId);
      // Backdated data invalidates its buckets. Delete them and rewind the watermark so
      // the next rollup pass rebuilds from before the late sample.
      const m1 = Math.floor(ts / 60) * 60, m15 = Math.floor(ts / 900) * 900;
      db.query("DELETE FROM samples_1m WHERE unit_id=? AND ts>=?").run(unitId, m1);
      db.query("DELETE FROM samples_15m WHERE unit_id=? AND ts>=?").run(unitId, m15);
      db.query("UPDATE settings SET value=? WHERE key='wm_1m' AND CAST(value AS INTEGER)>?").run(String(m1), m1);
      db.query("UPDATE settings SET value=? WHERE key='wm_15m' AND CAST(value AS INTEGER)>?").run(String(m15), m15);
      // Recompute the interval ending here and the following one: this sample may have
      // arrived late, changing both predecessor deltas. Idempotent via PRIMARY KEY.
      replaceEnergy(db, unitId, ts, interval);
      const next = db.query("SELECT ts FROM samples_raw WHERE unit_id=? AND ts>? ORDER BY ts LIMIT 1").get(unitId, ts) as { ts: number } | null;
      if (next) replaceEnergy(db, unitId, next.ts, interval);
    }
  })();
  return added;
}
