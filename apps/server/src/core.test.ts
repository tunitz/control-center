import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { monthKey, monthStart, setCurrentRate, getRate, monthCost } from "./cost";
import { dayStart, getTimezone, getCurrency, isValidTimezone } from "./tz";
import { ingestLines, computeEnergy } from "./ingest";
import { sumEnergy } from "./energy";
import { rollup, purge } from "./rollup";
import { queryMetrics } from "./metrics";
import { fingerprintOfKey, targetOf, pollUnit, Scheduler } from "./poller";
import { encrypt } from "./crypto";
import { hostFingerprintFromKnownHosts } from "./crypto";

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(":memory:"); db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'a','h','pk','sk',0)").run(); });

const line = (ts: number, o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, ts, cpu_pct: 10, cpu_mhz: 3000, cpu_w: 20, cpu_uj: null, gpu_pct: 5, gpu_mhz: 300, vram_used_mb: 500, gpu_w: 10, gpu_uj: null, ram_used_mb: 4000, ram_cached_mb: 2000, swap_used_mb: 0, ...o });

test("monthKey and monthStart respect configured IANA timezones (UTC, Asia/Manila, DST)", () => {
  // Default UTC
  expect(monthKey(Date.UTC(2026, 8, 30, 23, 30) / 1000)).toBe("2026-09");
  expect(monthStart("2026-10")).toBe(Date.UTC(2026, 9, 1, 0, 0) / 1000);
  // 2026-09-30T16:30:00Z is 2026-10-01 00:30 in Asia/Manila (UTC+8)
  expect(monthKey(Date.UTC(2026, 8, 30, 16, 30) / 1000, "Asia/Manila")).toBe("2026-10");
  expect(monthKey(Date.UTC(2026, 8, 30, 15, 30) / 1000, "Asia/Manila")).toBe("2026-09");
  expect(monthStart("2026-10", "Asia/Manila")).toBe(Date.UTC(2026, 8, 30, 16, 0) / 1000);
  // DST transition: America/New_York switches EDT (-04:00) -> EST (-05:00) on 2026-11-01
  expect(dayStart("2026-11-01", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 4, 0) / 1000);
  expect(dayStart("2026-11-02", "America/New_York")).toBe(Date.UTC(2026, 10, 2, 5, 0) / 1000);
});

test("timezone and currency settings validate and default to UTC / USD", () => {
  expect(getTimezone(db)).toBe("UTC");
  expect(getCurrency(db)).toEqual({ code: "USD", symbol: "$" });
  expect(isValidTimezone("UTC")).toBe(true);
  expect(isValidTimezone("America/New_York")).toBe(true);
  expect(isValidTimezone("Mars/Olympus_Mons")).toBe(false);
  db.query("INSERT INTO settings(key,value) VALUES('timezone','Europe/Berlin'),('currency_code','EUR'),('currency_symbol','€') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  expect(getTimezone(db)).toBe("Europe/Berlin");
  expect(getCurrency(db)).toEqual({ code: "EUR", symbol: "€" });
  const c = monthCost(db, Date.UTC(2026, 9, 15) / 1000);
  expect(c.timezone).toBe("Europe/Berlin");
  expect(c.currency_code).toBe("EUR");
  expect(c.currency_symbol).toBe("€");
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

test("changing the polling interval re-arms the scheduler without a restart", () => {
  let interval = 5;
  const pool = { exec: async () => "", drop: () => {}, closeAll: () => {}, hostKey: () => undefined } as any;
  const sched = new Scheduler(db, pool, "m", () => interval, () => {}, { pollTimeoutMs: 50 });
  sched.start();
  const first = (sched as any).currentIntervalS;
  interval = 60; sched.refreshInterval();
  expect((sched as any).currentIntervalS).toBe(60);
  expect(first).toBe(5);
  sched.stop();
});

test("an incomplete read is never acknowledged", async () => {
  const u = { id: 1, name: "u", host: "h", ssh_port: 62478, ssh_user: "ccagent", privkey_enc: encrypt("m", "private"), sample_interval_s: 5, enabled: 1, host_fingerprint: null } as any;
  const calls: string[] = [];
  const f = { exec: async (_id: number, _t: any, cmd: string) => { calls.push(cmd); return "#F metrics.1.reading\n{\"ts\":1000}\n"; } };
  await expect(pollUnit(db, f, u, "m", 1000)).rejects.toThrow(/end marker/);
  expect(calls.filter(c => c.startsWith("ack "))).toEqual([]);
});

test("a pinned host key is enforced and known_hosts lines parse to the same fingerprint", () => {
  const key = Buffer.from("test-host-key-bytes");
  const expected = fingerprintOfKey(key);
  const u = { id: 1, name: "u", host: "h", ssh_port: 62478, ssh_user: "ccagent", privkey_enc: encrypt("m", "private"), sample_interval_s: 5, enabled: 1, host_fingerprint: expected };
  const target = targetOf(u as any, "m");
  expect(target.hostVerifier!(key)).toBe(true);
  expect(target.hostVerifier!(Buffer.from("wrong-key"))).toBe(false);
  const knownHosts = `h ssh-ed25519 ${key.toString("base64")} comment`;
  expect(hostFingerprintFromKnownHosts(knownHosts)).toBe(expected);
});

test("six-hour energy includes the first partial hour and excludes future buckets", () => {
  const base = Date.UTC(2026, 10, 18, 6, 5) / 1000;
  ingestLines(db, 1, Array.from({ length: 361 }, (_, i) => JSON.stringify({ v: 1, ts: base + i * 60, cpu_w: 60 })), 60);
  const now = base + 21600;
  expect(queryMetrics(db, 1, "6h", now).energy_wh).toBeCloseTo(360, 6);
  expect(sumEnergy(db, 1, now + 1, now + 2)).toBe(0);
  db.query("INSERT INTO energy_intervals(unit_id,end_ts,wh) VALUES(1,?,1000)").run(now + 86400);
  expect(queryMetrics(db, 1, "6h", now).energy_wh).toBeCloseTo(360, 6);
});

test("a late sample recomputes both adjacent intervals instead of inflating energy", () => {
  const base = 1000;
  const line = (ts: number) => JSON.stringify({ v: 1, ts, cpu_w: 360 });
  ingestLines(db, 1, [line(base), line(base + 10)], 5);
  expect(sumEnergy(db, 1, base, base + 11)).toBeCloseTo(1, 6);
  ingestLines(db, 1, [line(base + 5)], 5);
  expect(sumEnergy(db, 1, base, base + 11)).toBeCloseTo(1, 6);
  // Billing retention is independent of the raw/rollup setting.
  purge(db, base + 2 * 86400, 1);
  expect(sumEnergy(db, 1, base, base + 11)).toBeCloseTo(1, 6);
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

test("raw replay cannot double-count energy after raw rows expire", () => {
  const base = Date.UTC(2026, 9, 7, 0, 0) / 1000;
  const lines = [0, 5, 10].map(i => JSON.stringify({ v: 1, ts: base + i, cpu_w: 360 }));
  ingestLines(db, 1, lines, 5);
  expect(sumEnergy(db, 1, base, base + 11)).toBeCloseTo(1, 6);
  purge(db, base + 49 * 3600, 90);
  ingestLines(db, 1, lines, 5);
  expect(sumEnergy(db, 1, base, base + 11)).toBeCloseTo(1, 6);
});

test("rolled-up summaries ignore buckets where a metric is absent", () => {
  const base = Date.UTC(2026, 9, 7, 0, 0) / 1000;
  const line = (ts: number, cpu_w: number | null) => JSON.stringify({ v: 1, ts, cpu_pct: 5, cpu_w });
  const lines: string[] = [];
  for (let i = 0; i < 20; i++) lines.push(line(base + i * 5, i < 10 ? 100 : null));
  ingestLines(db, 1, lines, 5);
  rollup(db, base + 120);
  expect(queryMetrics(db, 1, "6h", base + 120).summary.cpu_w.avg).toBe(100);
  expect(queryMetrics(db, 1, "6h", base + 120).summary.cpu_pct.avg).toBe(5);
});

test("late data rebuilds the affected rollup bucket", () => {
  const base = Date.UTC(2026, 9, 7, 0, 0) / 1000;
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: base, cpu_pct: 10 })], 5);
  rollup(db, base + 3600);
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: base + 5, cpu_pct: 90 })], 5);
  rollup(db, base + 3660);
  expect(db.query("SELECT n,cpu_pct_avg avg FROM samples_1m WHERE ts=?").get(base)).toEqual({ n: 2, avg: 50 });
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
