import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDb } from "./db";
import { ingestLines } from "./ingest";
import { rollup } from "./rollup";
import { queryMetrics } from "./metrics";
import { unitView } from "./unitview";
import { deleteUnit } from "./units";
import { latestDisks } from "./disks";

const DISK = ["disk_read_kbs", "disk_write_kbs", "disk_temp_c", "disk_used_pct"];
const OLD = ["cpu_pct", "cpu_mhz", "cpu_w", "gpu_pct", "gpu_mhz", "gpu_w", "vram_used_mb", "ram_used_mb", "ram_cached_mb", "swap_used_mb"];

const cols = (db: Database, t: string) => (db.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);

let db: ReturnType<typeof openDb>;
const fresh = () => {
  db = openDb(":memory:");
  db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'a','h','pk','sk',0)").run();
  return db;
};

const oldLine = (ts: number) => JSON.stringify({ v: 1, ts, cpu_pct: 10, cpu_mhz: 3000, cpu_w: 20, gpu_pct: 5, gpu_mhz: 300, vram_used_mb: 500, gpu_w: 10, ram_used_mb: 4000, ram_cached_mb: 2000, swap_used_mb: 0 });
const newLine = (ts: number, o: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(oldLine(ts)), disk_read_kbs: 120, disk_write_kbs: 40, disk_temp_c: 51, disk_used_pct: 22, ...o });

// ---- schema migration -------------------------------------------------------

test("openDb migrates an old-schema file: adds disk columns to all three sample tables, keeps old rows", () => {
  const path = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ccdb-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(`
    CREATE TABLE samples_raw (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, ${OLD.map(m => `${m} REAL`).join(", ")}, cpu_uj INTEGER, gpu_uj INTEGER, e_wh REAL, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;
    CREATE TABLE samples_1m (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, n INTEGER NOT NULL, ${OLD.map(m => `${m}_avg REAL, ${m}_min REAL, ${m}_max REAL`).join(", ")}, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;
    CREATE TABLE samples_15m (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, n INTEGER NOT NULL, ${OLD.map(m => `${m}_avg REAL, ${m}_min REAL, ${m}_max REAL`).join(", ")}, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;
    INSERT INTO samples_raw(unit_id,ts,cpu_pct) VALUES(1,1000,42);
    INSERT INTO samples_1m(unit_id,ts,n,cpu_pct_avg,cpu_pct_min,cpu_pct_max) VALUES(1,960,12,40,1,90);
  `);
  old.close();

  const db = openDb(path);
  for (const t of ["samples_raw", "samples_1m", "samples_15m"]) {
    const c = cols(db, t);
    for (const d of DISK) {
      const want = t === "samples_raw" ? [d] : [`${d}_avg`, `${d}_min`, `${d}_max`];
      for (const w of want) expect(c).toContain(w);
    }
  }
  expect(db.query("SELECT cpu_pct v FROM samples_raw WHERE ts=1000").get()).toEqual({ v: 42 });
  expect(db.query("SELECT disk_read_kbs v FROM samples_raw WHERE ts=1000").get()).toEqual({ v: null });
  expect(db.query("SELECT cpu_pct_avg v, disk_read_kbs_max v2 FROM samples_1m WHERE ts=960").get()).toEqual({ v: 40, v2: null });
  db.close();

  // idempotent: reopening an migrated DB adds nothing and does not throw
  const again = openDb(path);
  expect(cols(again, "samples_raw").filter(c => c === "disk_read_kbs").length).toBe(1);
  again.close();
});

test("old agents (no disk fields) still ingest; disk columns stay null", () => {
  const db = fresh();
  expect(ingestLines(db, 1, [oldLine(1000), oldLine(1005)], 5)).toBe(2);
  expect(db.query("SELECT cpu_pct v, disk_read_kbs v2, disk_temp_c v3 FROM samples_raw WHERE ts=1005").get()).toEqual({ v: 10, v2: null, v3: null });
  expect(latestDisks(db, 1)).toBeNull();
});

test("new agent fields are stored in raw samples", () => {
  const db = fresh();
  ingestLines(db, 1, [newLine(1000, { disk_read_kbs: 7.5, disk_temp_c: 48, disk_used_pct: 33 })], 5);
  expect(db.query("SELECT disk_read_kbs, disk_write_kbs, disk_temp_c, disk_used_pct FROM samples_raw").get()).toEqual({ disk_read_kbs: 7.5, disk_write_kbs: 40, disk_temp_c: 48, disk_used_pct: 33 });
});

// ---- latest-only disk snapshot ---------------------------------------------

const mountsA = [{ m: "/", fs: "ext4", total_mb: 1000, used_mb: 100 }];
const mountsB = [{ m: "/", fs: "ext4", total_mb: 1000, used_mb: 250 }, { m: "/srv/nas", fs: "xfs", total_mb: 5000, used_mb: 900 }];
const mountsC = [{ m: "/", fs: "ext4", total_mb: 1000, used_mb: 1 }];
const api = (xs: typeof mountsA) => xs.map(x => ({ mount: x.m, fs: x.fs, total_mb: x.total_mb, used_mb: x.used_mb }));

test("unit_disks keeps only the newest disks snapshot per unit, ignoring late older batches", () => {
  const db = fresh();
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: 100, disks: mountsA })], 5);
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: 200, disks: mountsB })], 5);
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: 150, disks: mountsC })], 5); // late, older
  expect(latestDisks(db, 1)).toEqual({ ts: 200, mounts: api(mountsB) });
  expect((db.query("SELECT COUNT(*) c FROM unit_disks").get() as any).c).toBe(1);
});

test("newest disks inside one batch wins; samples without disks do not clear the snapshot", () => {
  const db = fresh();
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: 300, disks: mountsA }), JSON.stringify({ v: 1, ts: 310, disks: mountsB }), JSON.stringify({ v: 1, ts: 320 })], 5);
  expect(latestDisks(db, 1)).toEqual({ ts: 310, mounts: api(mountsB) });
});

test("disk entries are normalised to {mount,fs,total_mb,used_mb}; malformed entries dropped", () => {
  const db = fresh();
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: 400, disks: [{ m: "/", fs: "ext4", total_mb: 10, used_mb: 2, extra: 1 }, { m: 5 }, { m: "/x", fs: "xfs", total_mb: "nope", used_mb: 1 }] })], 5);
  expect(latestDisks(db, 1)).toEqual({ ts: 400, mounts: [{ mount: "/", fs: "ext4", total_mb: 10, used_mb: 2 }] });
});

test("deleteUnit removes the disks snapshot too", () => {
  const db = fresh();
  ingestLines(db, 1, [JSON.stringify({ v: 1, ts: 100, disks: mountsA })], 5);
  deleteUnit(db, 1);
  expect((db.query("SELECT COUNT(*) c FROM unit_disks WHERE unit_id=1").get() as any).c).toBe(0);
});

// ---- unit detail API shape --------------------------------------------------

test("unit view exposes disks {ts,mounts} from the dep, or null when none", () => {
  const u = { id: 1, name: "u", host: "h", ssh_port: 22, mac: null, broadcast: null, enabled: 1, last_seen: 1000, last_error: null, fingerprint: null, sample_interval_s: 5 };
  const withDisks = unitView(u, { now: 1000, pollInterval: 5, latest: () => null, staticJson: () => null, disks: () => ({ ts: 999, mounts: api(mountsA) }) } as any) as any;
  expect(withDisks.disks).toEqual({ ts: 999, mounts: api(mountsA) });
  const none = unitView(u, { now: 1000, pollInterval: 5, latest: () => null, staticJson: () => null, disks: () => null } as any) as any;
  expect(none.disks).toBeNull();
  const legacy = unitView(u, { now: 1000, pollInterval: 5, latest: () => null, staticJson: () => null } as any) as any;
  expect(legacy.disks).toBeNull();
});

// ---- metrics endpoint serves the new series with no further changes --------

test("metrics endpoint serves disk series at raw and rolled-up tiers", () => {
  const db = fresh();
  const base = Math.floor(Date.now() / 1000) - 3600;
  const lines = Array.from({ length: 60 }, (_, i) => newLine(base + i * 5, { disk_read_kbs: i, disk_temp_c: 50 + (i % 3) }));
  ingestLines(db, 1, lines, 5);
  const raw = queryMetrics(db, 1, "1h", base + 300) as any;
  expect(raw.tier).toBe("raw");
  expect(raw.points[10].disk_read_kbs).toBe(10);
  expect(raw.summary.disk_read_kbs).toEqual({ min: 0, avg: 29.5, max: 59 });
  expect(raw.summary.disk_temp_c.max).toBe(52);

  rollup(db, base + 3600);
  const m1 = queryMetrics(db, 1, "6h", base + 3600) as any;
  expect(m1.tier).toBe("1m");
  expect(m1.points.length).toBeGreaterThan(0);
  expect(m1.points[0].disk_read_kbs_min).not.toBeNull();
  expect(m1.summary.disk_used_pct).toEqual({ min: 22, avg: 22, max: 22 });
});
