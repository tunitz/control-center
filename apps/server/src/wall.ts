import type { Database } from "bun:sqlite";

/** Generic wall-meter input: external systems POST {unit_id, watts, ts?} to /api/metrics/wall. */
export const WALL_MAX_GAP_S = 300;
export const WALL_MAX_WATTS = 100_000;
export type WallSample = { unit_id: number; ts: number; watts: number };

export function validateWallSample(body: any, now: number): { ok: true; sample: WallSample } | { ok: false; error: string } {
  const unitId = Number(body?.unit_id);
  if (!Number.isInteger(unitId) || unitId < 1) return { ok: false, error: "unit_id must be a positive integer" };
  const watts = Number(body?.watts);
  if (!isFinite(watts) || watts < 0 || watts > WALL_MAX_WATTS) return { ok: false, error: `watts must be 0..${WALL_MAX_WATTS}` };
  const ts = body?.ts == null ? now : Number(body.ts);
  if (!Number.isInteger(ts) || Math.abs(ts - now) > 300) return { ok: false, error: "ts must be within 5 minutes of now" };
  return { ok: true, sample: { unit_id: unitId, ts, watts } };
}

/** Recompute one interval from the two readings ending at `ts`. Idempotent on the primary key. */
function recomputeWallEnergy(db: Database, unitId: number, ts: number, maxGapS: number) {
  const rows = db.query("SELECT ts,watts FROM wall_power WHERE unit_id=? AND ts<=? ORDER BY ts DESC LIMIT 2").all(unitId, ts) as { ts: number; watts: number }[];
  if (rows.length < 2 || rows[0].ts !== ts) return;
  const dt = rows[0].ts - rows[1].ts;
  if (dt <= 0 || dt > maxGapS) { db.query("DELETE FROM wall_energy WHERE unit_id=? AND end_ts=?").run(unitId, ts); return; }
  // Trapezoidal integration of two instantaneous readings; gaps are never interpolated.
  const wh = ((rows[0].watts + rows[1].watts) / 2) * dt / 3600;
  db.query("INSERT OR REPLACE INTO wall_energy(unit_id,end_ts,wh) VALUES(?,?,?)").run(unitId, ts, wh);
}

/** Insert a reading and recompute the interval ending here and the next one (late arrivals). */
export function ingestWall(db: Database, sample: WallSample, maxGapS = WALL_MAX_GAP_S) {
  const ins = db.query("INSERT OR REPLACE INTO wall_power(unit_id,ts,watts) VALUES(?,?,?)").run(sample.unit_id, sample.ts, sample.watts);
  recomputeWallEnergy(db, sample.unit_id, sample.ts, maxGapS);
  const next = db.query("SELECT ts FROM wall_power WHERE unit_id=? AND ts>? ORDER BY ts LIMIT 1").get(sample.unit_id, sample.ts) as { ts: number } | null;
  if (next) recomputeWallEnergy(db, sample.unit_id, next.ts, maxGapS);
  return ins.changes;
}

/** Latest wall reading if it is recent enough to call live. */
export function latestWall(db: Database, unitId: number, now: number, maxAgeS = 60): { ts: number; watts: number } | null {
  const row = db.query("SELECT ts,watts FROM wall_power WHERE unit_id=? AND ts<=? ORDER BY ts DESC LIMIT 1").get(unitId, now) as { ts: number; watts: number } | null;
  return row && now - row.ts <= maxAgeS ? row : null;
}

export function wallEnergySum(db: Database, unitId: number, from: number, to: number): number {
  if (to <= from) return 0;
  const row = db.query("SELECT COALESCE(SUM(wh),0) s FROM wall_energy WHERE unit_id=? AND end_ts>=? AND end_ts<?").get(unitId, from, to) as { s: number };
  return row.s;
}

export function purgeWall(db: Database, now: number, keepS = 400 * 86400) {
  db.query("DELETE FROM wall_power WHERE ts<?").run(now - keepS);
  db.query("DELETE FROM wall_energy WHERE end_ts<?").run(now - keepS);
}
