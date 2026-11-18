import type { Database } from "bun:sqlite";
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
  const rows = db.query(
    `SELECT u.id, u.name, COALESCE(SUM(e.wh),0) wh FROM units u LEFT JOIN energy_intervals e ON e.unit_id=u.id AND e.end_ts>=? AND e.end_ts<? AND e.end_ts>=? WHERE u.enabled=1 GROUP BY u.id ORDER BY u.id`
  ).all(monthStart(month), now + 1, now - BILLING_KEEP_S) as { id: number; name: string; wh: number }[];
  const units = rows.map(r => ({ id: r.id, name: r.name, kwh: r.wh / 1000, php: (r.wh / 1000) * rate }));
  return { month, rate, total_kwh: units.reduce((a, u) => a + u.kwh, 0), total_php: units.reduce((a, u) => a + u.php, 0), units };
}
