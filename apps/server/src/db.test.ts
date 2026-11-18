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

test("a fresh units table defaults ssh_port to 62478", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO units(name,host,pubkey,privkey_enc,created_at) VALUES('u','h','p','k',0)").run();
  expect((db.query("SELECT ssh_port FROM units").get() as any).ssh_port).toBe(62478);
  db.close();
});

test("SSH port migration runs once: only 22 becomes 62478, custom ports survive, no re-apply", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ccmig-")), "cc.db");
  const legacy = new Database(path, { create: true });
  legacy.exec("CREATE TABLE units (id INTEGER PRIMARY KEY, ssh_port INTEGER NOT NULL DEFAULT 22)");
  legacy.exec("INSERT INTO units(id,ssh_port) VALUES (1,22),(2,2222),(3,22)");
  legacy.close();

  const db = openDb(path);
  const rows = () => db.query("SELECT id,ssh_port FROM units ORDER BY id").all() as { id: number; ssh_port: number }[];
  expect(rows()).toEqual([{ id: 1, ssh_port: 62478 }, { id: 2, ssh_port: 2222 }, { id: 3, ssh_port: 62478 }]);
  expect(getSetting(db, "ssh_port_62478_migrated", "0")).toBe("1");

  // A deliberate later change back to 22 must not be migrated again on the next open.
  db.query("UPDATE units SET ssh_port=22 WHERE id=1").run();
  db.close();

  const again = openDb(path);
  expect(again.query("SELECT ssh_port FROM units WHERE id=1").get()).toEqual({ ssh_port: 22 });
  expect(again.query("SELECT ssh_port FROM units WHERE id=2").get()).toEqual({ ssh_port: 2222 });
  again.close();
});
