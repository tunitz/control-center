import { test, expect } from "bun:test";
import { openDb, setSetting } from "./db";
import { monthStart } from "./cost";
import { monthCost } from "./cost";
import { validateWallSample, ingestWall, latestWall, wallEnergySum, purgeWall, WALL_MAX_WATTS } from "./wall";
import { deleteUnit } from "./units";

const NOW = 1_800_000_000;
const db = () => {
  const d = openDb(":memory:");
  d.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'u','h','pk','sk',0)").run();
  return d;
};
test("wall samples are validated: unit, watts range and timestamp skew", () => {
  expect(validateWallSample({ unit_id: 1, watts: 120 }, NOW).ok).toBe(true);
  expect(validateWallSample({ unit_id: 0, watts: 10 }, NOW).ok).toBe(false);
  expect(validateWallSample({ unit_id: 1, watts: -1 }, NOW).ok).toBe(false);
  expect(validateWallSample({ unit_id: 1, watts: WALL_MAX_WATTS + 1 }, NOW).ok).toBe(false);
  expect(validateWallSample({ unit_id: 1, watts: 10, ts: NOW - 400 }, NOW).ok).toBe(false);
  const ok = validateWallSample({ unit_id: 1, watts: 10 }, NOW);
  expect(ok.ok && ok.sample.ts).toBe(NOW);
});

test("wall energy is integrated between readings and recomputed for late arrivals", () => {
  const d = db();
  ingestWall(d, { unit_id: 1, ts: NOW, watts: 100 });
  ingestWall(d, { unit_id: 1, ts: NOW + 300, watts: 300 });
  expect(wallEnergySum(d, 1, NOW, NOW + 301)).toBeCloseTo(((100 + 300) / 2) * 300 / 3600, 6);
  // A late reading changes both adjacent trapezoids; the total must not double-count.
  ingestWall(d, { unit_id: 1, ts: NOW + 150, watts: 200 });
  expect(wallEnergySum(d, 1, NOW, NOW + 301)).toBeCloseTo(
    ((100 + 200) / 2) * 150 / 3600 + ((200 + 300) / 2) * 150 / 3600, 6);
  // Replaying the same reading is idempotent.
  ingestWall(d, { unit_id: 1, ts: NOW + 150, watts: 200 });
  expect(wallEnergySum(d, 1, NOW, NOW + 301)).toBeCloseTo(
    ((100 + 200) / 2) * 150 / 3600 + ((200 + 300) / 2) * 150 / 3600, 6);
});

test("gaps over the max are not integrated", () => {
  const d = db();
  ingestWall(d, { unit_id: 1, ts: NOW, watts: 100 });
  ingestWall(d, { unit_id: 1, ts: NOW + 301, watts: 100 });
  expect(wallEnergySum(d, 1, NOW, NOW + 400)).toBe(0);
});

test("latest wall reading is hidden when stale", () => {
  const d = db();
  ingestWall(d, { unit_id: 1, ts: NOW - 30, watts: 150 });
  expect(latestWall(d, 1, NOW)).toEqual({ ts: NOW - 30, watts: 150 });
  expect(latestWall(d, 1, NOW + 120)).toBeNull();
});

test("cost uses measured wall instead of the estimate when opted in, never both", () => {
  const d = db();
  const start = monthStart("2027-01");
  const ts = start + 3600;
  d.query("INSERT INTO energy_intervals(unit_id,end_ts,wh) VALUES(1,?,1000)").run(ts);
  ingestWall(d, { unit_id: 1, ts: ts - 300, watts: 100 });
  ingestWall(d, { unit_id: 1, ts, watts: 100 });
  setSetting(d, "cost_include_wall", "0");
  let c = monthCost(d, ts + 10);
  expect(c.total_kwh).toBeCloseTo(1, 6);
  expect(c.cost_basis).toBe("estimated CPU+GPU power");
  setSetting(d, "cost_include_wall", "1");
  c = monthCost(d, ts + 10);
  expect(c.wall_kwh).toBeCloseTo((100 * 300 / 3600) / 1000, 6);
  expect(c.total_kwh).toBeCloseTo(c.wall_kwh, 6); // estimate not added on top
  expect(c.cost_basis).toContain("measured wall");
  expect(c.units[0].basis).toBe("measured wall");
});

test("purge and unit deletion remove wall data", () => {
  const d = db();
  ingestWall(d, { unit_id: 1, ts: NOW, watts: 100 });
  ingestWall(d, { unit_id: 1, ts: NOW + 60, watts: 100 });
  purgeWall(d, NOW + 500 * 86400);
  expect(d.query("SELECT COUNT(*) n FROM wall_power").get()).toEqual({ n: 0 });
  ingestWall(d, { unit_id: 1, ts: NOW + 60, watts: 100 });
  ingestWall(d, { unit_id: 1, ts: NOW + 120, watts: 100 });
  deleteUnit(d, 1);
  expect(d.query("SELECT COUNT(*) n FROM wall_energy").get()).toEqual({ n: 0 });
});
