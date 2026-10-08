import { Database } from "bun:sqlite";

export const METRICS = ["cpu_pct","cpu_mhz","cpu_w","gpu_pct","gpu_mhz","gpu_w","vram_used_mb","ram_used_mb","ram_cached_mb","swap_used_mb"] as const;
export type Metric = typeof METRICS[number];

const tier = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, n INTEGER NOT NULL, ${METRICS.map(m => `${m}_avg REAL, ${m}_min REAL, ${m}_max REAL`).join(", ")}, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;`;

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
  `);
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
