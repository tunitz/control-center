import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { monthKey, monthStart, setCurrentRate, getRate, monthCost } from "./cost";
import { ingestLines, computeEnergy } from "./ingest";
import { rollup, purge } from "./rollup";
import { queryMetrics } from "./metrics";

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(":memory:"); db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'a','h','pk','sk',0)").run(); });

const line = (ts: number, o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ts, cpu_pct: 10, cpu_mhz: 3000, cpu_w: 20, cpu_uj: null, gpu_pct: 5, gpu_mhz: 300, vram_used_mb: 500, gpu_w: 10, gpu_uj: null, ram_used_mb: 4000, ram_cached_mb: 2000, swap_used_mb: 0, ...o });

test("monthKey uses Asia/Manila", () => {
  // 2026-09-30T16:30:00Z is 2026-10-01 00:30 in Manila
  expect(monthKey(Date.UTC(2026, 8, 30, 16, 30) / 1000)).toBe("2026-10");
  expect(monthKey(Date.UTC(2026, 8, 30, 15, 30) / 1000)).toBe("2026-09");
  expect(monthStart("2026-10")).toBe(Date.UTC(2026, 8, 30, 16, 0) / 1000);
});

test("rate editing never touches past months and rollover copies previous rate", () => {
  const sep = Date.UTC(2026, 8, 15) / 1000, oct = Date.UTC(2026, 9, 15) / 1000;
  setCurrentRate(db, 10, sep);
  expect(getRate(db, "2026-10", oct)).toBe(10); // rollover copy
  setCurrentRate(db, 12, oct);
  expect(db.query("SELECT php_per_kwh p FROM rates WHERE month='2026-09'").get()).toEqual({ p: 10 });
  expect(db.query("SELECT php_per_kwh p FROM rates WHERE month='2026-10'").get()).toEqual({ p: 12 });
});

test("energy from counter delta, wrap and reset fall back to watts", () => {
  expect(computeEnergy({ dt: 5, cpuW: 20, gpuW: 10, dCpuUj: 5_000_000, dGpuUj: null, interval: 5 })).toBeCloseTo((5 + 10 * 5) / 3600, 6); // 5 J + 50 J
  expect(computeEnergy({ dt: 5, cpuW: 20, gpuW: null, dCpuUj: -1, dGpuUj: null, interval: 5 })).toBeCloseTo(100 / 3600, 6);
  expect(computeEnergy({ dt: 60, cpuW: 20, gpuW: 10, dCpuUj: null, dGpuUj: null, interval: 5 })).toBe(0); // gap
});

test("ingest dedupes and accumulates energy_hourly; cost is current month only", () => {
  const base = Math.floor(Date.UTC(2026, 9, 7, 0, 0) / 1000);
  const lines = [0, 5, 10, 15].map(i => line(base + i));
  expect(ingestLines(db, 1, lines, 5)).toBe(4);
  expect(ingestLines(db, 1, lines, 5)).toBe(0);
  const wh = (db.query("SELECT SUM(wh) s FROM energy_hourly").get() as any).s;
  expect(wh).toBeCloseTo(3 * 30 * 5 / 3600, 6);
  setCurrentRate(db, 10, base);
  const c = monthCost(db, base + 20);
  expect(c.month).toBe("2026-10");
  expect(c.units[0].kwh).toBeCloseTo(wh / 1000, 9);
  expect(c.total_php).toBeCloseTo(wh / 1000 * 10, 9);
});

test("rollup 1m/15m min avg max, then purge honours tiers", () => {
  const base = Math.floor(Date.UTC(2026, 9, 7, 0, 0) / 1000);
  const ls: string[] = [];
  for (let i = 0; i < 24; i++) ls.push(line(base + i * 5, { cpu_pct: i }));
  ingestLines(db, 1, ls, 5);
  rollup(db, base + 3600);
  const r = db.query("SELECT n, cpu_pct_avg a, cpu_pct_min mn, cpu_pct_max mx FROM samples_1m WHERE ts=?").get(base) as any;
  expect(r).toEqual({ n: 12, a: 5.5, mn: 0, mx: 11 });
  const q = db.query("SELECT n, cpu_pct_min mn, cpu_pct_max mx FROM samples_15m WHERE ts=?").get(base) as any;
  expect(q).toEqual({ n: 24, mn: 0, mx: 23 });
  purge(db, base + 3 * 86400);
  expect((db.query("SELECT COUNT(*) c FROM samples_raw").get() as any).c).toBe(0);
  expect((db.query("SELECT COUNT(*) c FROM samples_1m").get() as any).c).toBe(2);
  purge(db, base + 91 * 86400);
  expect((db.query("SELECT COUNT(*) c FROM samples_15m").get() as any).c).toBe(0);
});

test("queryMetrics picks tier per range and returns summary + energy", () => {
  const now = Math.floor(Date.UTC(2026, 9, 7, 1, 0) / 1000), base = now - 600;
  ingestLines(db, 1, Array.from({ length: 120 }, (_, i) => line(base + i * 5, { cpu_pct: i % 10 })), 5);
  rollup(db, now);
  const a = queryMetrics(db, 1, "1h", now);
  expect(a.tier).toBe("raw");
  expect(a.points.length).toBe(120);
  expect(a.summary.cpu_pct.max).toBe(9);
  expect(a.summary.cpu_pct.min).toBe(0);
  expect(a.energy_wh).toBeGreaterThan(0);
  expect(queryMetrics(db, 1, "24h", now).tier).toBe("1m");
  expect(queryMetrics(db, 1, "7d", now).tier).toBe("15m");
  expect(() => queryMetrics(db, 1, "5y" as any, now)).toThrow();
});
