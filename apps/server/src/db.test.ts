import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";

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
