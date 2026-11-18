import { Database } from "bun:sqlite";

export const METRICS = ["cpu_pct","cpu_mhz","cpu_w","gpu_pct","gpu_mhz","gpu_w","vram_used_mb","ram_used_mb","ram_cached_mb","swap_used_mb","disk_read_kbs","disk_write_kbs","disk_temp_c","disk_used_pct"] as const;
export type Metric = typeof METRICS[number];

const tier = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, n INTEGER NOT NULL, ${METRICS.map(m => `${m}_avg REAL, ${m}_min REAL, ${m}_max REAL, ${m}_count INTEGER`).join(", ")}, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;`;

/** Adds any METRICS column missing from an existing sample table (additive, nullable REAL). */
function migrateSampleTable(db: Database, table: string, perMetric: (m: string) => string[]) {
  const info = db.query(`PRAGMA table_info(${table})`).all() as { name: string; type: string }[];
  const have = new Map(info.map(c => [c.name, c.type]));
  for (const m of METRICS) for (const col of perMetric(m)) {
    if (!have.has(col)) {
      const type = col.endsWith("_count") ? "INTEGER" : "REAL";
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
    } else if (col.endsWith("_count") && have.get(col) === "REAL") {
      // No deployed DB has these columns yet; a future migration can handle type changes here.
    }
  }
}

export function openDb(path: string): Database {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;");
  db.exec(`
  CREATE TABLE IF NOT EXISTS units (id INTEGER PRIMARY KEY, public_id TEXT UNIQUE, name TEXT NOT NULL, host TEXT NOT NULL, ssh_port INTEGER NOT NULL DEFAULT 62478, ssh_user TEXT NOT NULL DEFAULT 'ccagent',
    pubkey TEXT NOT NULL, privkey_enc TEXT NOT NULL, fingerprint TEXT, mac TEXT, broadcast TEXT DEFAULT '255.255.255.255',
    sample_interval_s INTEGER NOT NULL DEFAULT 5, enabled INTEGER NOT NULL DEFAULT 1, last_seen INTEGER, last_error TEXT, host_fingerprint TEXT, last_sample_ts INTEGER, migration_pending_port INTEGER, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS unit_static (unit_id INTEGER PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS install_tokens (token TEXT PRIMARY KEY, unit_id INTEGER NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS samples_raw (unit_id INTEGER NOT NULL, ts INTEGER NOT NULL, ${METRICS.map(m => `${m} REAL`).join(", ")}, cpu_uj INTEGER, gpu_uj INTEGER, e_wh REAL, PRIMARY KEY (unit_id, ts)) WITHOUT ROWID;
  ${tier("samples_1m")} ${tier("samples_15m")}
  CREATE TABLE IF NOT EXISTS energy_hourly (unit_id INTEGER NOT NULL, hour_ts INTEGER NOT NULL, wh REAL NOT NULL, PRIMARY KEY (unit_id, hour_ts)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS energy_intervals (unit_id INTEGER NOT NULL, end_ts INTEGER NOT NULL, wh REAL NOT NULL, PRIMARY KEY (unit_id, end_ts)) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS rates (month TEXT PRIMARY KEY, php_per_kwh REAL NOT NULL, set_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings(key,value) VALUES('admin_hash',''),('bootstrap_hash',''),('auth_version','0');
  CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, unit_id INTEGER, unit_name TEXT, public_id TEXT, detail TEXT, ip TEXT);
  CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, auth_version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS unit_services (unit_id INTEGER NOT NULL, kind TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(unit_id,kind,name));
  CREATE TABLE IF NOT EXISTS unit_disks (unit_id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, json TEXT NOT NULL);
  `);
  migrateSampleTable(db, "samples_raw", m => [m]);
  migrateSampleTable(db, "samples_1m", m => [`${m}_avg`, `${m}_min`, `${m}_max`, `${m}_count`]);
  migrateSampleTable(db, "samples_15m", m => [`${m}_avg`, `${m}_min`, `${m}_max`, `${m}_count`]);
  const auditCols = new Set((db.query("PRAGMA table_info(audit)").all() as { name: string }[]).map(c => c.name));
  if (!auditCols.has("unit_name")) db.exec("ALTER TABLE audit ADD COLUMN unit_name TEXT");
  if (!auditCols.has("public_id")) db.exec("ALTER TABLE audit ADD COLUMN public_id TEXT");
  const unitCols = new Set((db.query("PRAGMA table_info(units)").all() as { name: string }[]).map(c => c.name));
  if (!unitCols.has("host_fingerprint")) db.exec("ALTER TABLE units ADD COLUMN host_fingerprint TEXT");
  if (!unitCols.has("last_sample_ts")) db.exec("ALTER TABLE units ADD COLUMN last_sample_ts INTEGER");
  if (!unitCols.has("migration_pending_port")) db.exec("ALTER TABLE units ADD COLUMN migration_pending_port INTEGER");
  if (!unitCols.has("public_id")) {
    db.exec("ALTER TABLE units ADD COLUMN public_id TEXT");
    db.query("UPDATE units SET public_id=lower(hex(randomblob(16)))").run();
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS units_public_id ON units(public_id)");
  }
  // Legacy port-22 units are NOT silently moved: the dedicated sshd must be installed
  // and verified on each unit first. Mark them so the UI can ask for an explicit migrate.
  if (getSetting(db, "ssh_port_62478_migrated", "0") !== "1") {
    db.exec("UPDATE units SET migration_pending_port=ssh_port WHERE ssh_port=22 AND migration_pending_port IS NULL");
    setSetting(db, "ssh_port_62478_migrated", "1");
  }
  // Additive session migration: old rows are valid for the current auth version.
  // One-time backfill: older databases have hourly totals but no per-interval ledger.
  // Attribute each stored hour to its last sample interval, preserving the accounting
  // that was already shown to the user. Fresh databases have no hourly rows.
  if (getSetting(db, "energy_intervals_backfilled", "0") !== "1") {
    const hours = db.query("SELECT unit_id,hour_ts,wh FROM energy_hourly").all() as { unit_id: number; hour_ts: number; wh: number }[];
    const ins = db.query("INSERT OR REPLACE INTO energy_intervals(unit_id,end_ts,wh) VALUES(?,?,?)");
    db.transaction(() => {
      for (const h of hours) {
        const last = db.query("SELECT ts FROM samples_raw WHERE unit_id=? AND ts>=? AND ts<? ORDER BY ts DESC LIMIT 1").get(h.unit_id, h.hour_ts, h.hour_ts + 3600) as { ts: number } | null;
        if (last) ins.run(h.unit_id, last.ts, h.wh);
      }
      setSetting(db, "energy_intervals_backfilled", "1");
    })();
  }
  const sessionCols = new Set((db.query("PRAGMA table_info(sessions)").all() as { name: string }[]).map(c => c.name));
  if (!sessionCols.has("auth_version")) {
    db.exec("ALTER TABLE sessions ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0");
    // Preserve existing sessions after a version bump that happened before this column existed.
    db.query("UPDATE sessions SET auth_version=?").run(Number(getSetting(db, "auth_version", "0")));
  }
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
  const u = unitId == null ? null : db.query("SELECT name,public_id FROM units WHERE id=?").get(unitId) as { name: string; public_id: string } | null;
  const r = db.query("INSERT INTO audit(ts,actor,action,unit_id,unit_name,public_id,detail,ip) VALUES(?,?,?,?,?,?,?,?)").run(Math.floor(Date.now() / 1000), actor, action, unitId, u?.name ?? null, u?.public_id ?? null, detail, ip);
  return Number(r.lastInsertRowid);
}
