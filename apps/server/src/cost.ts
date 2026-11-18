import type { Database } from "bun:sqlite";
import { getSetting } from "./db";
import { wallEnergySum } from "./wall";
const TZ_OFFSET_S = 8 * 3600; // Asia/Manila, no DST
const BILLING_KEEP_S = 400 * 86400;

export function monthKey(ts: number): string {
  const d = new Date((ts + TZ_OFFSET_S) * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
export function monthStart(month: string): number {
  const [y, m] = month.split("-").map(Number);
  return Date.UTC(y, m - 1, 1) / 1000 - TZ_OFFSET_S;
}
export const DEFAULT_RATE = 10;

/** Rate for a month. A month with no row is created by copying the latest earlier rate (rollover). */
export function getRate(db: Database, month: string, now: number): number {
  const row = db.query("SELECT php_per_kwh p FROM rates WHERE month=?").get(month) as { p: number } | null;
  if (row) return row.p;
  const prev = db.query("SELECT php_per_kwh p FROM rates WHERE month<? ORDER BY month DESC LIMIT 1").get(month) as { p: number } | null;
  const p = prev ? prev.p : DEFAULT_RATE;
  db.query("INSERT INTO rates(month,php_per_kwh,set_at) VALUES(?,?,?)").run(month, p, now);
  return p;
}
/** Only ever writes the current month's row. */
export function setCurrentRate(db: Database, rate: number, now: number) {
  if (!(rate >= 0) || !isFinite(rate)) throw new Error("invalid rate");
  const month = monthKey(now);
  getRate(db, month, now);
  db.query("UPDATE rates SET php_per_kwh=?, set_at=? WHERE month=?").run(rate, now, month);
}
export function monthCost(db: Database, now: number) {
  const month = monthKey(now);
  const rate = getRate(db, month, now);
  const start = monthStart(month), end = now + 1, floor = now - BILLING_KEEP_S;
  const rows = db.query(
    `SELECT u.id, u.name, COALESCE(SUM(e.wh),0) wh FROM units u LEFT JOIN energy_intervals e ON e.unit_id=u.id AND e.end_ts>=? AND e.end_ts<? AND e.end_ts>=? WHERE u.enabled=1 GROUP BY u.id ORDER BY u.id`
  ).all(start, end, floor) as { id: number; name: string; wh: number }[];
  const includeWall = getSetting(db, "cost_include_wall", "0") === "1";
  const units = rows.map(r => {
    // Never add both: a unit with measured wall energy uses it instead of the estimate.
    const wallWh = includeWall ? wallEnergySum(db, r.id, Math.max(start, floor), end) : 0;
    const measured = wallWh > 0;
    const wh = measured ? wallWh : r.wh;
    return { id: r.id, name: r.name, kwh: wh / 1000, php: (wh / 1000) * rate, basis: measured ? "measured wall" : "estimated CPU+GPU", wall_kwh: wallWh / 1000 };
  });
  const wallKwh = units.reduce((a, u) => a + u.wall_kwh, 0);
  return {
    month, rate,
    total_kwh: units.reduce((a, u) => a + u.kwh, 0),
    total_php: units.reduce((a, u) => a + u.php, 0),
    wall_kwh: wallKwh,
    cost_include_wall: includeWall,
    cost_basis: includeWall
      ? (wallKwh > 0 ? "measured wall where available, CPU+GPU estimate elsewhere" : "estimated CPU+GPU (no wall meter data)")
      : "estimated CPU+GPU power",
    units,
  };
}
