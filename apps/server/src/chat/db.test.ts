import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db";

const tables = (db: Database) =>
  (db.query("SELECT name FROM sqlite_master WHERE type IN ('table','trigger')").all() as { name: string }[]).map(r => r.name);

test("fresh db has chat tables, FTS5 virtual table and sync triggers", () => {
  const db = openDb(":memory:");
  const names = tables(db);
  for (const t of ["chat_sessions", "chat_messages", "chat_attachments", "chat_run_events", "chat_messages_fts",
    "chat_messages_ai", "chat_messages_ad", "chat_messages_au"]) expect(names).toContain(t);
  const sql = (db.query("SELECT sql FROM sqlite_master WHERE name='chat_messages_fts'").get() as { sql: string }).sql;
  expect(sql).toMatch(/fts5/i);
});

test("chat_run_events is WITHOUT ROWID with PK(run_id,n)", () => {
  const db = openDb(":memory:");
  const sql = (db.query("SELECT sql FROM sqlite_master WHERE name='chat_run_events'").get() as { sql: string }).sql;
  expect(sql).toMatch(/WITHOUT ROWID/i);
  expect(sql).toMatch(/PRIMARY KEY\s*\(\s*run_id\s*,\s*n\s*\)/i);
});

test("UNIQUE(session_id, seq) is enforced", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO chat_sessions(id,title,model,provider,created_at,updated_at) VALUES('s1','t','m','p',0,0)").run();
  db.query("INSERT INTO chat_messages(id,session_id,seq,role,text,created_at) VALUES('m1','s1',1,'user','a',0)").run();
  expect(() => db.query("INSERT INTO chat_messages(id,session_id,seq,role,text,created_at) VALUES('m2','s1',1,'user','b',0)").run()).toThrow();
});

test("FTS stays in sync on insert, update and delete", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO chat_sessions(id,title,model,provider,created_at,updated_at) VALUES('s1','t','m','p',0,0)").run();
  db.query("INSERT INTO chat_messages(id,session_id,seq,role,text,created_at) VALUES('m1','s1',1,'user','pineapple juice',0)").run();
  const hits = (q: string) => (db.query("SELECT message_id FROM chat_messages_fts WHERE chat_messages_fts MATCH ?").all(q) as { message_id: string }[]).map(r => r.message_id);
  expect(hits("pineapple")).toEqual(["m1"]);
  db.query("UPDATE chat_messages SET text='mango lassi' WHERE id='m1'").run();
  expect(hits("pineapple")).toEqual([]);
  expect(hits("mango")).toEqual(["m1"]);
  db.query("DELETE FROM chat_messages WHERE id='m1'").run();
  expect(hits("mango")).toEqual([]);
});

test("deleting a session cascades messages, attachments and FTS rows", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO chat_sessions(id,title,model,provider,created_at,updated_at) VALUES('s1','t','m','p',0,0)").run();
  db.query("INSERT INTO chat_messages(id,session_id,seq,role,text,created_at) VALUES('m1','s1',1,'user','kiwi',0)").run();
  db.query("INSERT INTO chat_attachments(id,message_id,session_id,kind,name,mime,size,sha256,path) VALUES('a1','m1','s1','file','x','text/plain',3,'h','/p')").run();
  db.query("DELETE FROM chat_sessions WHERE id='s1'").run();
  expect(db.query("SELECT count(*) c FROM chat_messages").get()).toEqual({ c: 0 } as any);
  expect(db.query("SELECT count(*) c FROM chat_attachments").get()).toEqual({ c: 0 } as any);
  expect(db.query("SELECT count(*) c FROM chat_messages_fts WHERE chat_messages_fts MATCH 'kiwi'").get()).toEqual({ c: 0 } as any);
});

test("migration: old cc.db without chat tables gains them, keeps data, is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "chatmig-"));
  const path = join(dir, "old.db");
  // Old schema: only the pre-chat tables (subset of the real ones) with a row in each.
  const old = new Database(path, { create: true });
  old.exec(`CREATE TABLE units (id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, ssh_port INTEGER NOT NULL DEFAULT 22, ssh_user TEXT NOT NULL DEFAULT 'ccagent',
    pubkey TEXT NOT NULL, privkey_enc TEXT NOT NULL, fingerprint TEXT, mac TEXT, broadcast TEXT DEFAULT '255.255.255.255',
    sample_interval_s INTEGER NOT NULL DEFAULT 5, enabled INTEGER NOT NULL DEFAULT 1, last_seen INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'old-unit','h','pk','sk',0);
    INSERT INTO settings(key,value) VALUES('poll_interval_s','7');`);
  old.close();
  const copy = join(dir, "copy.db");
  copyFileSync(path, copy);
  const db = openDb(copy);
  expect(tables(db)).toContain("chat_messages_fts");
  expect(db.query("SELECT name FROM units WHERE id=1").get()).toEqual({ name: "old-unit" } as any);
  expect(db.query("SELECT value FROM settings WHERE key='poll_interval_s'").get()).toEqual({ value: "7" } as any);
  db.close();
  const again = openDb(copy); // second boot must not fail
  expect(tables(again)).toContain("chat_run_events");
  again.close();
});
