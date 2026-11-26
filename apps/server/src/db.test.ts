import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, getSetting } from "./db";

const tableNames = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);

test("a fresh database has no chat tables", () => {
  const db = openDb(":memory:");
  const tables = tableNames(db);
  expect(tables.filter(t => t.startsWith("chat_"))).toEqual([]);
  // The monitoring tables are still there.
  expect(tables).toContain("units");
  expect(tables).toContain("samples_raw");
  db.close();
});

test("an existing chat table and its rows survive openDb (nothing is dropped)", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ccdb-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec("CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '')");
  old.exec("INSERT INTO chat_sessions(id,title) VALUES('s-1','keep me')");
  old.close();

  const db = openDb(path);
  expect(tableNames(db)).toContain("chat_sessions");
  expect(db.query("SELECT title FROM chat_sessions WHERE id='s-1'").get()).toEqual({ title: "keep me" });
  // No chat columns are added or migrated any more.
  const cols = (db.query("PRAGMA table_info(chat_sessions)").all() as { name: string }[]).map(c => c.name);
  expect(cols).toEqual(["id", "title"]);
  db.close();
});

test("legacy sessions survive the auth_version migration", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ccsession-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, expires_at INTEGER); INSERT INTO sessions VALUES('s1',9999999999)");
  old.close();
  const db = openDb(path);
  expect(db.query("SELECT id,auth_version FROM sessions").get()).toEqual({ id: "s1", auth_version: 0 });
  db.close();
});

test("a legacy database preserves hourly energy while gaining the interval ledger", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ccenergy-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(`
    CREATE TABLE samples_raw (unit_id INTEGER, ts INTEGER, cpu_w REAL, PRIMARY KEY(unit_id,ts));
    CREATE TABLE energy_hourly (unit_id INTEGER, hour_ts INTEGER, wh REAL, PRIMARY KEY(unit_id,hour_ts));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, expires_at INTEGER);
    INSERT INTO samples_raw VALUES(1,100,60),(1,105,60);
    INSERT INTO energy_hourly VALUES(1,0,0.0833333);
  `);
  old.close();
  const db = openDb(path);
  expect((db.query("SELECT wh FROM energy_hourly WHERE unit_id=1").get() as any).wh).toBeCloseTo(0.0833333, 6);
  expect((db.query("SELECT wh FROM energy_intervals WHERE unit_id=1 AND end_ts=105").get() as any).wh).toBeCloseTo(0.0833333, 6);
  db.close();
});

test("a fresh units table defaults ssh_port to 62478", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO units(name,host,pubkey,privkey_enc,created_at) VALUES('u','h','p','k',0)").run();
  expect((db.query("SELECT ssh_port FROM units").get() as any).ssh_port).toBe(62478);
  db.close();
});

test("legacy port-22 units are flagged for verified migration, not silently switched", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ccmig-")), "cc.db");
  const legacy = new Database(path, { create: true });
  legacy.exec("CREATE TABLE units (id INTEGER PRIMARY KEY, ssh_port INTEGER NOT NULL DEFAULT 22)");
  legacy.exec("INSERT INTO units(id,ssh_port) VALUES (1,22),(2,2222),(3,22)");
  legacy.close();

  const db = openDb(path);
  const rows = () => db.query("SELECT id,ssh_port FROM units ORDER BY id").all() as { id: number; ssh_port: number }[];
  // Legacy units keep port 22 but are flagged for an explicit, verified migration.
  expect(rows()).toEqual([{ id: 1, ssh_port: 22 }, { id: 2, ssh_port: 2222 }, { id: 3, ssh_port: 22 }]);
  expect(db.query("SELECT migration_pending_port p FROM units WHERE id=1").get()).toEqual({ p: 22 });
  expect(getSetting(db, "ssh_port_62478_migrated", "0")).toBe("1");

  // A deliberate later change back to 22 must not be migrated again on the next open.
  db.query("UPDATE units SET ssh_port=22 WHERE id=1").run();
  db.close();

  const again = openDb(path);
  expect(again.query("SELECT ssh_port FROM units WHERE id=1").get()).toEqual({ ssh_port: 22 });
  expect(again.query("SELECT ssh_port FROM units WHERE id=2").get()).toEqual({ ssh_port: 2222 });
  again.close();
});
