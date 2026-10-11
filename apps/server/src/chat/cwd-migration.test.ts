import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import * as S from "./store";

// A database made before the cwd column existed: the old table with one row.
const OLD_CHAT_SESSIONS = `CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', title_auto INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model_locked TEXT, effort TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  run_state TEXT NOT NULL DEFAULT 'idle', run_id TEXT, unread INTEGER NOT NULL DEFAULT 0,
  backend TEXT NOT NULL DEFAULT 'hermes', backend_ref TEXT, pi_settings_json TEXT)`;

test("migration adds a nullable cwd column; old rows read null and writes still work", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-cwd-mig-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(OLD_CHAT_SESSIONS);
  old.exec(`INSERT INTO chat_sessions (id, title, model, provider, created_at, updated_at) VALUES ('old1', 'Old chat', 'claude-sonnet-5-5', 'anthropic', 1, 2)`);
  old.close();

  const db = openDb(path);
  const col = (db.query("PRAGMA table_info(chat_sessions)").all() as { name: string; notnull: number; type: string }[])
    .find((c) => c.name === "cwd");
  expect(col).toBeDefined();
  expect(col!.type).toBe("TEXT");
  expect(col!.notnull).toBe(0);

  expect(S.getSession(db, "old1")!.cwd).toBeNull();
  S.createSession(db, { id: "new1", model: "deepseek-pro", provider: "deepseek", effort: null, now: 3, backend: "pi", backendRef: "/s.jsonl", cwd: "/home/u/projects/alpha" });
  expect(S.getSession(db, "new1")!.cwd).toBe("/home/u/projects/alpha");
  db.close();
});

test("cwd survives reopen; reopening again keeps rows and the column", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-cwd-mig-")), "cc.db");
  const db1 = openDb(path);
  S.createSession(db1, { id: "a", model: "deepseek-pro", provider: "deepseek", effort: null, now: 1, backend: "pi", cwd: "/home/u/Beta" });
  S.createSession(db1, { id: "b", model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
  db1.close();
  const db2 = openDb(path);
  expect(S.getSession(db2, "a")!.cwd).toBe("/home/u/Beta");
  expect(S.getSession(db2, "b")!.cwd).toBeNull();
  db2.close();
  const db3 = openDb(path);
  expect(S.getSession(db3, "a")!.cwd).toBe("/home/u/Beta");
  db3.close();
});
