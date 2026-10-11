import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import * as S from "./store";

const OLD_CHAT_SESSIONS = `CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', title_auto INTEGER NOT NULL DEFAULT 1,
  model TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model_locked TEXT, effort TEXT, pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  run_state TEXT NOT NULL DEFAULT 'idle', run_id TEXT, unread INTEGER NOT NULL DEFAULT 0)`;

test("migration adds backend columns to a chat_sessions table that already has rows; old rows read as hermes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-mig-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(OLD_CHAT_SESSIONS);
  old.exec(`INSERT INTO chat_sessions (id, title, model, provider, created_at, updated_at) VALUES ('old1', 'Old chat', 'claude-sonnet-5-5', 'anthropic', 1, 2)`);
  old.close();

  const db = openDb(path);
  const cols = (db.query("PRAGMA table_info(chat_sessions)").all() as { name: string; dflt_value: string | null; notnull: number }[]);
  const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
  expect(byName.backend).toBeDefined();
  expect(byName.backend.notnull).toBe(1);
  expect(byName.backend.dflt_value).toBe("'hermes'");
  expect(byName.backend_ref).toBeDefined();
  expect(byName.pi_settings_json).toBeDefined();

  expect(db.query("SELECT backend, backend_ref, pi_settings_json FROM chat_sessions WHERE id = 'old1'").get())
    .toEqual({ backend: "hermes", backend_ref: null, pi_settings_json: null });
  expect(S.getSession(db, "old1")).toMatchObject({ id: "old1", title: "Old chat", model: "claude-sonnet-5-5", provider: "anthropic" });
  expect(S.getBackend(db, "old1")).toEqual({ backend: "hermes", ref: null });
  db.close();
});

test("migration is idempotent: reopening the database keeps rows and columns", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-mig-")), "cc.db");
  const db1 = openDb(path);
  S.createSession(db1, { id: "a", model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
  db1.close();
  const db2 = openDb(path);
  expect(S.getBackend(db2, "a")).toEqual({ backend: "hermes", ref: null });
  expect(S.getSession(db2, "a")?.title).toBe("New chat");
  db2.close();
});

test("createSession defaults to hermes; a pi session stores its backend and ref", () => {
  const db = openDb(":memory:");
  S.createSession(db, { id: "h", model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
  S.createSession(db, { id: "p", model: "deepseek-flash", provider: "deepseek", effort: null, now: 1, backend: "pi" });
  S.setBackendRef(db, "p", "/sessions/p.jsonl");
  expect(S.getBackend(db, "h")).toEqual({ backend: "hermes", ref: null });
  expect(S.getBackend(db, "p")).toEqual({ backend: "pi", ref: "/sessions/p.jsonl" });
  expect(S.getBackend(db, "missing")).toBeNull();
});

test("chat_messages gains todos_json additively; old rows read todos null", () => {
  const db = openDb(":memory:");
  const cols = (db.query("PRAGMA table_info(chat_messages)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("todos_json");
});

test("migration adds todos_json to a chat_messages table that already has rows; old rows read todos null", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-mig-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(OLD_CHAT_SESSIONS);
  old.exec(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reasoning TEXT, tools_json TEXT, usage_json TEXT,
    status TEXT NOT NULL DEFAULT 'complete', run_id TEXT, model TEXT, error TEXT, created_at INTEGER NOT NULL, UNIQUE(session_id, seq))`);
  old.exec(`INSERT INTO chat_sessions (id, title, model, provider, created_at, updated_at) VALUES ('s1', 'Old', 'm', 'p', 1, 2)`);
  old.exec(`INSERT INTO chat_messages (id, session_id, seq, role, text, created_at) VALUES ('m1', 's1', 1, 'assistant', 'hi', 3)`);
  old.close();
  const db = openDb(path);
  expect(S.getMessage(db, "m1")).toMatchObject({ id: "m1", text: "hi", todos: null });
  S.patchMessage(db, "m1", { todos: [{ id: "1", content: "x", status: "pending" }] });
  expect(S.getMessage(db, "m1")!.todos).toEqual([{ id: "1", content: "x", status: "pending" }]);
  db.close();
  expect(() => openDb(path).close()).not.toThrow();
});

test("chat_messages gains blocks_json additively; old rows read blocks []", () => {
  const db = openDb(":memory:");
  const cols = (db.query("PRAGMA table_info(chat_messages)").all() as { name: string }[]).map((c) => c.name);
  expect(cols).toContain("blocks_json");
});

test("migration adds blocks_json to a chat_messages table that already has rows; old rows read blocks []", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-mig-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(OLD_CHAT_SESSIONS);
  old.exec(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reasoning TEXT, tools_json TEXT, usage_json TEXT,
    status TEXT NOT NULL DEFAULT 'complete', run_id TEXT, model TEXT, error TEXT, created_at INTEGER NOT NULL, UNIQUE(session_id, seq))`);
  old.exec(`INSERT INTO chat_sessions (id, title, model, provider, created_at, updated_at) VALUES ('s1', 'Old', 'm', 'p', 1, 2)`);
  old.exec(`INSERT INTO chat_messages (id, session_id, seq, role, text, created_at) VALUES ('m1', 's1', 1, 'assistant', 'hi', 3)`);
  old.close();
  const db = openDb(path);
  expect(S.getMessage(db, "m1")).toMatchObject({ id: "m1", text: "hi", blocks: [] });
  S.patchMessage(db, "m1", { blocks: [{ kind: "text", text: "hi" }, { kind: "tool", id: "t1" }, { kind: "approval", approval: { command: "rm x", note: "Allow?", id: "u1", status: "pending" } }] });
  expect(S.getMessage(db, "m1")!.blocks).toEqual([
    { kind: "text", text: "hi" },
    { kind: "tool", id: "t1" },
    { kind: "approval", approval: { command: "rm x", note: "Allow?", id: "u1", status: "pending" } },
  ]);
  db.close();
  expect(() => openDb(path).close()).not.toThrow();
});
