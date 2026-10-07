import type { Database } from "bun:sqlite";
import { METRICS } from "./db";

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
  const prevQ = db.query("SELECT ts, cpu_uj, gpu_uj FROM samples_raw WHERE unit_id=? AND ts<? ORDER BY ts DESC LIMIT 1");
  const hour = db.query("INSERT INTO energy_hourly(unit_id,hour_ts,wh) VALUES(?,?,?) ON CONFLICT(unit_id,hour_ts) DO UPDATE SET wh=wh+excluded.wh");
  let added = 0;
  db.transaction(() => {
    for (const o of parsed) {
      const ts = o.ts as number;
      const prev = prevQ.get(unitId, ts) as { ts: number; cpu_uj: number | null; gpu_uj: number | null } | null;
      const cpuUj = num(o.cpu_uj), gpuUj = num(o.gpu_uj);
      const e = prev ? computeEnergy({
        dt: ts - prev.ts, cpuW: num(o.cpu_w), gpuW: num(o.gpu_w),
        dCpuUj: cpuUj != null && prev.cpu_uj != null ? cpuUj - prev.cpu_uj : null,
        dGpuUj: gpuUj != null && prev.gpu_uj != null ? gpuUj - prev.gpu_uj : null, interval,
      }) : 0;
      const r = ins.run(unitId, ts, ...METRICS.map(m => num(o[m])), cpuUj, gpuUj, e);
      if (r.changes > 0) {
        added++;
        if (e > 0) hour.run(unitId, Math.floor(ts / 3600) * 3600, e);
      }
    }
  })();
  return added;
}
