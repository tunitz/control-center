import type { Database } from "bun:sqlite";
import { METRICS, getSetting, setSetting } from "./db";

const allCols = METRICS.flatMap(m => [`${m}_avg`, `${m}_min`, `${m}_max`, `${m}_count`]);

function build(db: Database, table: string, size: number, now: number, key: string) {
  const end = Math.floor(now / size) * size; // only completed buckets
  const since = Number(getSetting(db, key, "0"));
  if (end <= since) return;
  const counts = METRICS.map(m => `COUNT(${m}) ${m}_count`).join(", ");
  const aggs = METRICS.flatMap(m => [
    `CASE WHEN SUM(${m}_count)>0 THEN SUM(${m}_sum)/SUM(${m}_count) ELSE NULL END ${m}_avg`,
    `MIN(${m}_min) ${m}_min`,
    `MAX(${m}_max) ${m}_max`,
    `SUM(${m}_count) ${m}_count`,
  ]).join(", ");
  db.query(
    `INSERT OR REPLACE INTO ${table}(unit_id, ts, n, ${allCols.join(",")})
     SELECT unit_id, b, SUM(n), ${aggs} FROM (
       SELECT unit_id, (ts/${size})*${size} b, COUNT(*) n, ${counts},
         ${METRICS.flatMap(m => [`SUM(${m}) ${m}_sum`, `MIN(${m}) ${m}_min`, `MAX(${m}) ${m}_max`]).join(",")}
       FROM samples_raw WHERE ts>=? AND ts<? GROUP BY unit_id, b
     ) GROUP BY unit_id, b`
  ).run(since, end);
  setSetting(db, key, String(Math.max(since, end - 2 * size))); // overlap for late data
}
export function rollup(db: Database, now: number) {
  db.transaction(() => { build(db, "samples_1m", 60, now, "wm_1m"); build(db, "samples_15m", 900, now, "wm_15m"); })();
}
export const RAW_KEEP_S = 48 * 3600, M1_KEEP_S = 30 * 86400;
export function purge(db: Database, now: number, retentionDays = 90) {
  const keep = retentionDays * 86400;
  db.transaction(() => {
    db.query("DELETE FROM samples_raw WHERE ts<?").run(now - Math.min(RAW_KEEP_S, keep));
    db.query("DELETE FROM samples_1m WHERE ts<?").run(now - Math.min(M1_KEEP_S, keep));
    db.query("DELETE FROM samples_15m WHERE ts<?").run(now - keep);
    db.query("DELETE FROM energy_hourly WHERE hour_ts<?").run(now - Math.max(keep, 400 * 86400));
    db.query("DELETE FROM energy_intervals WHERE end_ts<?").run(now - Math.max(keep, 400 * 86400));
    db.query("DELETE FROM audit WHERE ts<?").run(now - 365 * 86400);
    db.query("DELETE FROM sessions WHERE expires_at<?").run(now);
  })();
}
