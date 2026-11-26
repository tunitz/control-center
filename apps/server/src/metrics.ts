import type { Database } from "bun:sqlite";
import { METRICS } from "./db";
import { sumEnergy } from "./energy";

export const RANGES = { "1h": 3600, "6h": 6 * 3600, "12h": 12 * 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 } as const;
export type Range = keyof typeof RANGES;
const TIER: Record<Range, "raw" | "1m" | "15m"> = { "1h": "raw", "6h": "1m", "12h": "1m", "24h": "1m", "7d": "15m", "30d": "15m" };

export function queryMetrics(db: Database, unitId: number, range: Range, now: number) {
  const span = RANGES[range];
  if (!span) throw new Error("bad range");
  const tier = TIER[range], from = now - span;
  let points: Record<string, number | null>[];
  const summary: Record<string, { min: number | null; avg: number | null; max: number | null }> = {};
  const acc: Record<string, { mn: number; mx: number; sum: number; n: number }> = {};
  const feed = (m: string, mn: number | null, avg: number | null, mx: number | null, w: number) => {
    if (avg == null) return;
    const a = (acc[m] ??= { mn: Infinity, mx: -Infinity, sum: 0, n: 0 });
    a.mn = Math.min(a.mn, mn ?? avg); a.mx = Math.max(a.mx, mx ?? avg); a.sum += avg * w; a.n += w;
  };
  if (tier === "raw") {
    const rows = db.query(`SELECT ts, ${METRICS.join(",")} FROM samples_raw WHERE unit_id=? AND ts>=? AND ts<=? ORDER BY ts`).all(unitId, from, now) as any[];
    points = rows.map(r => {
      const p: Record<string, number | null> = { ts: r.ts };
      for (const m of METRICS) { p[m] = r[m]; p[m + "_min"] = r[m]; p[m + "_max"] = r[m]; feed(m, r[m], r[m], r[m], 1); }
      return p;
    });
  } else {
    const t = tier === "1m" ? "samples_1m" : "samples_15m";
    const cols = METRICS.flatMap(m => [`${m}_avg`, `${m}_min`, `${m}_max`, `${m}_count`]).join(",");
    const rows = db.query(`SELECT ts, n, ${cols} FROM ${t} WHERE unit_id=? AND ts>=? AND ts<=? ORDER BY ts`).all(unitId, from, now) as any[];
    points = rows.map(r => {
      const p: Record<string, number | null> = { ts: r.ts };
      for (const m of METRICS) {
        p[m] = r[m + "_avg"]; p[m + "_min"] = r[m + "_min"]; p[m + "_max"] = r[m + "_max"];
        // The rollup stores per-metric valid counts, so a sparse sensor does not
        // get weighted by every row in the bucket.
        const weight = Number((r as any)[m + "_count"] ?? r.n);
        feed(m, r[m + "_min"], r[m + "_avg"], r[m + "_max"] ?? r[m + "_avg"], weight);
      }
      return p;
    });
  }
  for (const m of METRICS) {
    const a = acc[m];
    summary[m] = a && a.n ? { min: a.mn, avg: a.sum / a.n, max: a.mx } : { min: null, avg: null, max: null };
  }
  const energy_wh = sumEnergy(db, unitId, from, now + 1);
  return { range, tier, from, to: now, points, summary, energy_wh };
}
