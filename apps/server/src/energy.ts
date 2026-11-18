import type { Database } from "bun:sqlite";
import { computeEnergy } from "./ingest";

type Sample = { ts: number; cpu_w: number | null; gpu_w: number | null; cpu_uj: number | null; gpu_uj: number | null };

/** Energy rows for each valid interval ending at `ts`: end timestamp, Wh. */
export function energyFor(db: Database, unitId: number, ts: number, interval: number): { end: number; wh: number }[] {
  const row = db.query("SELECT ts,cpu_w,gpu_w,cpu_uj,gpu_uj FROM samples_raw WHERE unit_id=? AND ts<=? ORDER BY ts DESC LIMIT 2").all(unitId, ts) as Sample[];
  if (row.length < 2) return [];
  const [current, previous] = row;
  if (current.ts !== ts || current.ts <= previous.ts) return [];
  const wh = computeEnergy({
    dt: current.ts - previous.ts, cpuW: current.cpu_w, gpuW: current.gpu_w,
    dCpuUj: current.cpu_uj != null && previous.cpu_uj != null ? current.cpu_uj - previous.cpu_uj : null,
    dGpuUj: current.gpu_uj != null && previous.gpu_uj != null ? current.gpu_uj - previous.gpu_uj : null,
    interval,
  });
  return wh > 0 ? [{ end: current.ts, wh }] : [];
}

/** Replace the energy accounting for one affected interval. Deletes then inserts in one transaction. */
export function replaceEnergy(db: Database, unitId: number, ts: number, interval: number) {
  const prev = db.query("SELECT ts FROM samples_raw WHERE unit_id=? AND ts<? ORDER BY ts DESC LIMIT 1").get(unitId, ts) as { ts: number } | null;
  const rows = energyFor(db, unitId, ts, interval);
  const hours = new Set<number>([Math.floor(ts / 3600) * 3600]);
  if (prev) hours.add(Math.floor(prev.ts / 3600) * 3600);
  db.query("DELETE FROM energy_intervals WHERE unit_id=? AND end_ts=?").run(unitId, ts);
  for (const h of hours) db.query("DELETE FROM energy_hourly WHERE unit_id=? AND hour_ts=?").run(unitId, h);
  const insertInterval = db.query("INSERT INTO energy_intervals(unit_id,end_ts,wh) VALUES(?,?,?)");
  for (const r of rows) insertInterval.run(unitId, r.end, r.wh);
  const insHour = db.query("INSERT INTO energy_hourly(unit_id,hour_ts,wh) VALUES(?,?,?) ON CONFLICT(unit_id,hour_ts) DO UPDATE SET wh=excluded.wh");
  for (const h of hours) {
    const sum = db.query("SELECT COALESCE(SUM(wh),0) s FROM energy_intervals WHERE unit_id=? AND end_ts>=? AND end_ts<?").get(unitId, h, h + 3600) as { s: number };
    insHour.run(unitId, h, sum.s);
  }
}

/** Aggregated energy between inclusive lower and exclusive upper bounds. */
export function sumEnergy(db: Database, unitId: number, from: number, to: number): number {
  if (to <= from) return 0;
  const r = db.query("SELECT COALESCE(SUM(wh),0) s FROM energy_intervals WHERE unit_id=? AND end_ts>=? AND end_ts<?").get(unitId, from, to) as { s: number };
  return r.s;
}
