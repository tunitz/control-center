import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { createBackup, validateBackup, restoreBackup, SCHEMA_VERSION, tempBackupPath } from "./backup";

const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ccbackup-"));

const seed = () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO units(name,host,pubkey,privkey_enc,created_at) VALUES('u','h','pk','sk',0)").run();
  db.query("INSERT INTO settings(key,value) VALUES('poll_interval_s','7')").run();
  return db;
};

test("backup is a valid snapshot with a manifest that excludes the master key", () => {
  const db = seed(), p = tempBackupPath(dir);
  const info = createBackup(db, p, 1800000000);
  expect(info.version).toBe(SCHEMA_VERSION);
  expect(info.masterKeyIncluded).toBe(false);
  expect(info.createdAt).toBe("2027-01-15T08:00:00.000Z");
  expect(validateBackup(p).version).toBe(SCHEMA_VERSION);
  db.close();
});

test("restore replaces live tables with the backup contents atomically", () => {
  const db = seed(), p = tempBackupPath(dir);
  createBackup(db, p);
  db.query("UPDATE units SET name='changed'").run();
  db.query("UPDATE settings SET value='99' WHERE key='poll_interval_s'").run();
  db.query("INSERT INTO units(name,host,pubkey,privkey_enc,created_at) VALUES('extra','h','pk','sk',0)").run();
  const r = restoreBackup(db, p);
  expect(r.tables).toBeGreaterThan(10);
  expect(db.query("SELECT name FROM units ORDER BY id").all()).toEqual([{ name: "u" }]);
  expect(db.query("SELECT value FROM settings WHERE key='poll_interval_s'").get()).toEqual({ value: "7" });
  db.close();
});

test("an invalid or incompatible file is rejected before touching live data", () => {
  const db = seed(), bad = tempBackupPath(dir);
  Bun.write(bad, "not a database");
  expect(() => validateBackup(bad)).toThrow();
  const before = db.query("SELECT COUNT(*) n FROM units").get();
  expect(() => restoreBackup(db, bad)).toThrow();
  expect(db.query("SELECT COUNT(*) n FROM units").get()).toEqual(before);
  db.close();
});
