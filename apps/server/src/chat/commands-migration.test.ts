import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";
import * as S from "./store";

test("migration adds a nullable block column to chat_commands; old rows read null, writes and reopen work", () => {
  const path = join(mkdtempSync(join(tmpdir(), "chat-cmd-mig-")), "cc.db");
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', title_auto INTEGER NOT NULL DEFAULT 1,
    model TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model_locked TEXT, effort TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    run_state TEXT NOT NULL DEFAULT 'idle', run_id TEXT, unread INTEGER NOT NULL DEFAULT 0,
    backend TEXT NOT NULL DEFAULT 'hermes', backend_ref TEXT, pi_settings_json TEXT)`);
  old.exec(`INSERT INTO chat_sessions (id, title, model, provider, created_at, updated_at) VALUES ('s1', 'Old', 'm', 'p', 1, 2)`);
  old.exec(`CREATE TABLE chat_commands (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  old.exec(`INSERT INTO chat_commands (session_id, seq, name, body, created_at) VALUES ('s1', 1, 'help', 'old row', 3)`);
  old.close();

  const db = openDb(path);
  expect(S.listCommands(db, "s1")[0]).toMatchObject({ name: "help", block: null });
  S.insertCommand(db, { sessionId: "s1", name: "credits", body: "x", afterSeq: 2, block: 3, createdAt: 4 });
  expect(S.listCommands(db, "s1").map(c => c.block)).toEqual([null, 3]);
  db.close();

  const again = openDb(path);
  expect(S.listCommands(again, "s1")).toHaveLength(2);
  again.close();
});
