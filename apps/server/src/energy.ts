import type { Database } from "bun:sqlite";
import { computeEnergy } from "./ingest";
import { getRate } from "./cost";

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

// ---- Daily per-unit energy history (Asia/Manila, UTC+8 with no DST) ----

const TZ_OFFSET_S = 8 * 3600;
const DAY_S = 86400;

export type EnergyDay = { day: string; kwh: number; php: number };

/** Calendar midnight of a YYYY-MM-DD day as a UTC epoch-second timestamp. */
function utcMidnight(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return dt.getTime() / 1000;
}

/** Start of a Manila calendar day in UTC epoch seconds (00:00 Manila = 16:00 previous UTC day). */
export function dayStart(day: string): number {
  return utcMidnight(day) - TZ_OFFSET_S;
}

function nextDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d + 1);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

/** Strict YYYY-MM-DD validation of a real calendar date. Returns the input or null. */
export function parseDay(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return value;
}

/** Validate an inclusive day range; rejects invalid dates and from > to. */
export function parseRange(from: string | null, to: string | null): { from: string; to: string } | null {
  const f = parseDay(from), t = parseDay(to);
  if (!f || !t || f > t) return null;
  return { from: f, to: t };
}

/** Per-day kWh and PHP cost over an inclusive Manila-day range. `unitId=null` aggregates all units. */
export function dailyEnergy(db: Database, from: string, to: string, unitId: number | null, now: number): EnergyDay[] {
  const out: EnergyDay[] = [];
  const all = db.query("SELECT COALESCE(SUM(wh),0) s FROM energy_intervals WHERE end_ts>=? AND end_ts<?");
  const one = db.query("SELECT COALESCE(SUM(wh),0) s FROM energy_intervals WHERE unit_id=? AND end_ts>=? AND end_ts<?");
  for (let day = from; day <= to; day = nextDay(day)) {
    const start = dayStart(day), end = start + DAY_S;
    const row = (unitId == null ? all.get(start, end) : one.get(unitId, start, end)) as { s: number };
    const wh = row.s;
    const kwh = wh / 1000;
    const rate = getRate(db, day.slice(0, 7), now);
    out.push({ day, kwh, php: kwh * rate });
  }
  return out;
}

/** Quote a CSV field when it contains a comma, quote or newline; double embedded quotes. */
export function csvEscape(value: string | number): string {
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV with a `day,kwh,php` header row and one row per day. */
export function energyCsv(rows: EnergyDay[]): string {
  const lines = ["day,kwh,php"];
  for (const r of rows) lines.push([r.day, r.kwh, r.php].map(csvEscape).join(","));
  return lines.join("\r\n") + "\r\n";
}
