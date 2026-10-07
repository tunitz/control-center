import type { Database } from "bun:sqlite";

const UNIT_TABLES = ["samples_raw", "samples_1m", "samples_15m", "energy_hourly", "unit_static"];
/** Removes a unit and every row that belongs to it. Returns false if it did not exist. */
export function deleteUnit(db: Database, id: number): boolean {
  return db.transaction(() => {
    if (!db.query("SELECT 1 FROM units WHERE id=?").get(id)) return false;
    for (const t of UNIT_TABLES) db.query(`DELETE FROM ${t} WHERE unit_id=?`).run(id);
    db.query("DELETE FROM units WHERE id=?").run(id);
    return true;
  })();
}
