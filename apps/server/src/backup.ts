import { Database, type Database as DB } from "bun:sqlite";
import { unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";

/** Bump when the set of tables/collections changes in an incompatible way. */
export const SCHEMA_VERSION = "1";
const TABLES = [
  "units", "unit_static", "install_tokens", "samples_raw", "samples_1m", "samples_15m",
  "energy_hourly", "energy_intervals", "rates", "settings", "audit", "sessions",
  "unit_services", "unit_disks", "alert_rules", "alert_state", "maintenance_windows",
];

type BackupInfo = { version: string; createdAt: string; masterKeyIncluded: false; tables: string[] };

/** Consistent snapshot via VACUUM INTO, then a small manifest. The master key is NEVER stored. */
export function createBackup(db: DB, path: string, now = Math.floor(Date.now() / 1000)): BackupInfo {
  db.query("PRAGMA wal_checkpoint(TRUNCATE)").all();
  db.query("VACUUM INTO ?").run(path);
  const meta = new Database(path);
  try {
    meta.exec("CREATE TABLE backup_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const ins = meta.query("INSERT INTO backup_meta(key,value) VALUES(?,?)");
    const info: BackupInfo = { version: SCHEMA_VERSION, createdAt: new Date(now * 1000).toISOString(), masterKeyIncluded: false, tables: TABLES };
    for (const [k, v] of Object.entries(info)) ins.run(k, typeof v === "string" ? v : JSON.stringify(v));
    return info;
  } finally { meta.close(); }
}

export function validateBackup(path: string): BackupInfo {
  const metaDb = new Database(path, { readonly: true });
  try {
    const names = (metaDb.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name);
    if (!names.includes("backup_meta") || !names.includes("units") || !names.includes("settings"))
      throw new Error("not a Control Center backup");
    const rows = metaDb.query("SELECT key,value FROM backup_meta").all() as { key: string; value: string }[];
    const info = Object.fromEntries(rows.map(r => [r.key, r.value])) as Record<string, string>;
    if (info.version !== SCHEMA_VERSION) throw new Error(`backup schema ${info.version ?? "unknown"} does not match ${SCHEMA_VERSION}`);
    try { JSON.parse(info.tables); } catch { throw new Error("backup table manifest is corrupt"); }
    return { version: info.version, createdAt: info.createdAt, masterKeyIncluded: false, tables: JSON.parse(info.tables) as string[] };
  } finally { metaDb.close(); }
}

/** Replace the live tables with the backup's contents in one transaction, keeping the open connection. */
export function restoreBackup(live: DB, path: string): { tables: number } {
  const info = validateBackup(path);
  live.query("ATTACH DATABASE ? AS bk").run(path);
  try {
    let tables = 0;
    live.exec("BEGIN IMMEDIATE");
    try {
      for (const t of TABLES) {
        if (!info.tables.includes(t)) continue;
        const cols = (live.query(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(c => c.name);
        const backupCols = (live.query(`PRAGMA bk.table_info(${t})`).all() as { name: string }[]).map(c => c.name);
        const shared = cols.filter(c => backupCols.includes(c));
        if (!shared.length) continue;
        live.query(`DELETE FROM main.${t}`).run();
        live.query(`INSERT INTO main.${t}(${shared.join(",")}) SELECT ${shared.join(",")} FROM bk.${t}`).run();
        tables++;
      }
      live.exec("COMMIT");
    } catch (e) { live.exec("ROLLBACK"); throw e; }
    return { tables };
  } finally { live.query("DETACH DATABASE bk").run(); }
}

/** Temp path helper: callers own the file and must delete it. */
export const tempBackupPath = (dir: string) => `${dir}/backup-${randomUUID()}.db`;
export const removeBackupFile = (path: string) => { try { unlinkSync(path); } catch { /* already gone */ } };
