import type { Database } from "bun:sqlite";
import { getSetting } from "./db";
import { wallEnergySum } from "./wall";
import { getCurrency, getTimezone, monthKey, monthStart } from "./tz";

export { monthKey, monthStart };
const BILLING_KEEP_S = 400 * 86400;

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
export function setCurrentRate(db: Database, rate: number, now: number, tz: string = getTimezone(db)) {
  if (!(rate >= 0) || !isFinite(rate)) throw new Error("invalid rate");
  const month = monthKey(now, tz);
  getRate(db, month, now);
  db.query("UPDATE rates SET php_per_kwh=?, set_at=? WHERE month=?").run(rate, now, month);
}
export function monthCost(db: Database, now: number, tz: string = getTimezone(db)) {
  const month = monthKey(now, tz);
  const rate = getRate(db, month, now);
  const currency = getCurrency(db);
  const start = monthStart(month, tz), end = now + 1, floor = now - BILLING_KEEP_S;
  const rows = db.query(
    `SELECT u.id, u.name, COALESCE(SUM(e.wh),0) wh FROM units u LEFT JOIN energy_intervals e ON e.unit_id=u.id AND e.end_ts>=? AND e.end_ts<? AND e.end_ts>=? WHERE u.enabled=1 GROUP BY u.id ORDER BY u.id`
  ).all(start, end, floor) as { id: number; name: string; wh: number }[];
  const includeWall = getSetting(db, "cost_include_wall", "0") === "1";
  const units = rows.map(r => {
    // Never add both: a unit with measured wall energy uses it instead of the estimate.
    const wallWh = includeWall ? wallEnergySum(db, r.id, Math.max(start, floor), end) : 0;
    const measured = wallWh > 0;
    const wh = measured ? wallWh : r.wh;
    const cost = (wh / 1000) * rate;
    return {
      id: r.id, name: r.name, kwh: wh / 1000, cost, php: cost,
      currency_code: currency.code, currency_symbol: currency.symbol,
      basis: measured ? "measured wall" : "estimated CPU+GPU", wall_kwh: wallWh / 1000,
    };
  });
  const wallKwh = units.reduce((a, u) => a + u.wall_kwh, 0);
  const totalCost = units.reduce((a, u) => a + u.cost, 0);
  return {
    month, rate, timezone: tz,
    currency_code: currency.code, currency_symbol: currency.symbol,
    total_kwh: units.reduce((a, u) => a + u.kwh, 0),
    total_cost: totalCost,
    total_php: totalCost,
    wall_kwh: wallKwh,
    cost_include_wall: includeWall,
    cost_basis: includeWall
      ? (wallKwh > 0 ? "measured wall where available, CPU+GPU estimate elsewhere" : "estimated CPU+GPU (no wall meter data)")
      : "estimated CPU+GPU power",
    units,
  };
}
