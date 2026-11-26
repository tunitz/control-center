import { test, expect } from "bun:test";
import { openDb, audit } from "./db";
import { ingestLines } from "./ingest";
import { rollup } from "./rollup";
import { deleteUnit } from "./units";

test("audit rows keep the deleted unit's name instead of misattributing to a later unit", () => {
  const db = openDb(":memory:");
  db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'Original','h','pk','sk',0)").run();
  audit(db, "admin", "unit.updated", 1, "x");
  deleteUnit(db, 1);
  db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(1,'Replacement','h','pk','sk',0)").run();
  expect(db.query("SELECT COALESCE(a.unit_name,u.name) unit FROM audit a LEFT JOIN units u ON u.id=a.unit_id").get()).toEqual({ unit: "Original" });
});

test("deleteUnit removes the unit and ALL its data, leaves other units alone, returns false if missing", () => {
  const db = openDb(":memory:");
  for (const id of [1, 2]) db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at) VALUES(?,?,?,?,?,0)").run(id, "u" + id, "h", "pk", "sk");
  const now = Math.floor(Date.now() / 1000) - 3600;
  for (const id of [1, 2]) {
    ingestLines(db, id, Array.from({ length: 30 }, (_, i) => JSON.stringify({ v: 1, ts: now + i * 5, cpu_pct: 1, cpu_w: 10 })), 5);
    db.query("INSERT INTO unit_static(unit_id,json,updated_at) VALUES(?,?,0)").run(id, "{}");
  }
  rollup(db, now + 7200);
  expect(deleteUnit(db, 1)).toBe(true);
  for (const t of ["samples_raw", "samples_1m", "samples_15m", "energy_hourly", "unit_static"])
    expect((db.query(`SELECT COUNT(*) c FROM ${t} WHERE unit_id=1`).get() as any).c).toBe(0);
  expect((db.query("SELECT COUNT(*) c FROM units WHERE id=1").get() as any).c).toBe(0);
  expect((db.query("SELECT COUNT(*) c FROM samples_raw WHERE unit_id=2").get() as any).c).toBe(30);
  expect((db.query("SELECT COUNT(*) c FROM units WHERE id=2").get() as any).c).toBe(1);
  expect(deleteUnit(db, 1)).toBe(false);
});
