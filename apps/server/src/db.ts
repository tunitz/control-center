import { Database } from "bun:sqlite";

export const METRICS = ["cpu_pct","cpu_mhz","cpu_w","gpu_pct","gpu_mhz","gpu_w","vram_used_mb","ram_used_mb","ram_cached_mb","swap_used_mb","disk_read_kbs","disk_write_kbs","disk_temp_c","disk_used_pct"] as const;
export type Metric = typeof METRICS[number];

const tier = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, n INTEGER NOT NULL, ${METRICS.map(m => `${m}_avg REAL, ${m}_min REAL, ${m}_max REAL`).join(", ")}, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;`;

/** Adds any METRICS column missing from an existing sample table (additive, nullable REAL). */
function migrateSampleTable(db: Database, table: string, perMetric: (m: string) => string[]) {
  const have = new Set((db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(c => c.name));
  for (const m of METRICS) for (const col of perMetric(m)) {
    if (!have.has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} REAL`);
  }
}

/** Chat mirror tables (additive). chat_sessions.id = Hermes session id. FTS5 is kept in sync by triggers. */
export const CHAT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', title_auto INTEGER NOT NULL DEFAULT 1,
    model TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', model_locked TEXT, effort TEXT, pinned INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    run_state TEXT NOT NULL DEFAULT 'idle', run_id TEXT, unread INTEGER NOT NULL DEFAULT 0);
  CREATE INDEX IF NOT EXISTS chat_sessions_list ON chat_sessions(archived, pinned, updated_at);
  CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', reasoning TEXT, tools_json TEXT, usage_json TEXT,
    status TEXT NOT NULL DEFAULT 'complete', run_id TEXT, model TEXT, error TEXT, created_at INTEGER NOT NULL,
    UNIQUE(session_id, seq));
  CREATE TABLE IF NOT EXISTS chat_attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE, kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL,
    size INTEGER NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL, w INTEGER, h INTEGER);
  CREATE TABLE IF NOT EXISTS chat_run_events (run_id TEXT NOT NULL, n INTEGER NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (run_id, n)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS chat_await (session_id TEXT PRIMARY KEY REFERENCES chat_sessions(id) ON DELETE CASCADE,
    expected INTEGER NOT NULL, since_ms INTEGER NOT NULL, deadline_ms INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS chat_seen (session_id TEXT NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
    hermes_msg_id INTEGER NOT NULL, PRIMARY KEY (session_id, hermes_msg_id)) WITHOUT ROWID;
  CREATE VIRTUAL TABLE IF NOT EXISTS chat_messages_fts USING fts5(message_id UNINDEXED, text);
  CREATE TRIGGER IF NOT EXISTS chat_messages_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO chat_messages_fts(message_id, text) VALUES (new.id, new.text); END;
  CREATE TRIGGER IF NOT EXISTS chat_messages_ad AFTER DELETE ON chat_messages BEGIN
    DELETE FROM chat_messages_fts WHERE message_id = old.id; END;
  CREATE TRIGGER IF NOT EXISTS chat_messages_au AFTER UPDATE OF text ON chat_messages BEGIN
    DELETE FROM chat_messages_fts WHERE message_id = old.id;
    INSERT INTO chat_messages_fts(message_id, text) VALUES (new.id, new.text); END;
`;

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
  db.exec(`
  CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY, name TEXT NOT NULL, host TEXT NOT NULL, ssh_port INTEGER NOT NULL DEFAULT 22, ssh_user TEXT NOT NULL DEFAULT 'ccagent',
    pubkey TEXT NOT NULL, privkey_enc TEXT NOT NULL, fingerprint TEXT, mac TEXT, broadcast TEXT DEFAULT '255.255.255.255',
    sample_interval_s INTEGER NOT NULL DEFAULT 5, enabled INTEGER NOT NULL DEFAULT 1, last_seen INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS unit_static (unit_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS install_tokens (token TEXT PRIMARY KEY, unit_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS samples_raw (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, ${METRICS.map(m => `${m} REAL`).join(", ")}, cpu_uj INTEGER, gpu_uj INTEGER, e_wh REAL, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;
  ${tier("samples_1m")} ${tier("samples_15m")}
  CREATE TABLE IF NOT EXISTS energy_hourly (unit_id INTEGER NOT NULL, hour_ts INTEGER NOT NULL, wh REAL NOT NULL, PRIMARY KEY (unit_id, hour_ts)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS rates (month TEXT PRIMARY KEY, php_per_kwh REAL NOT NULL, set_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, unit_id INTEGER, detail TEXT, ip TEXT);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS unit_services (unit_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(unit_id,kind,name));
  CREATE TABLE IF NOT EXISTS unit_disks (unit_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL);
  `);
  db.exec(CHAT_SCHEMA);
  migrateSampleTable(db, "samples_raw", m => [m]);
  migrateSampleTable(db, "samples_1m", m => [`${m}_avg`, `${m}_min`, `${m}_max`]);
  migrateSampleTable(db, "samples_15m", m => [`${m}_avg`, `${m}_min`, `${m}_max`]);
  return db;
}

export function getSetting(db: Database, key: string, def: string): string {
  const r = db.query("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | null;
  return r ? r.value : def;
}
export function setSetting(db: Database, key: string, value: string) {
  db.query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}
export function audit(db: Database, actor: string, action: string, unitId: number | null, detail: string, ip = "") {
  const r = db.query("INSERT INTO audit(ts,actor,action,unit_id,detail,ip) VALUES(?,?,?,?,?,?)").run(Math.floor(Date.now() / 1000), actor, action, unitId, detail, ip);
  return Number(r.lastInsertRowid);
}
