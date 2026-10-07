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

export type UnitPatch = { name?: string; host?: string; ssh_port?: number; mac?: string | null; broadcast?: string };
const HOST_RE = /^(?:[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(?:\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$|^[0-9a-fA-F:]+$/;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;

export function normaliseMac(m: string): string | null {
  if (/[^0-9a-f:.\-\s]/i.test(m)) return null;
  const hex = m.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) return null;
  return hex.toLowerCase().match(/../g)!.join(":");
}

/** Validated partial update. Changes nothing unless every supplied field is valid. */
export function updateUnit(db: Database, id: number, p: UnitPatch): { ok: true; hostChanged: boolean } | { ok: false; error: string } {
  const cur = db.query("SELECT host, ssh_port FROM units WHERE id=?").get(id) as { host: string; ssh_port: number } | null;
  if (!cur) return { ok: false, error: "no such unit" };
  const set: Record<string, string | number | null> = {};
  if (p.name !== undefined) { if (!p.name.trim()) return { ok: false, error: "name required" }; set.name = p.name.trim(); }
  if (p.host !== undefined) { const h = p.host.trim(); if (!h || h.length > 253 || !HOST_RE.test(h)) return { ok: false, error: "invalid host or IP" }; set.host = h; }
  if (p.ssh_port !== undefined) { const n = Number(p.ssh_port); if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: "invalid SSH port" }; set.ssh_port = n; }
  if (p.mac !== undefined) {
    if (p.mac === null || p.mac.trim() === "") set.mac = null;
    else { const m = normaliseMac(p.mac.trim()); if (!m) return { ok: false, error: "invalid MAC address" }; set.mac = m; }
  }
  if (p.broadcast !== undefined) { const b = p.broadcast.trim(); if (!IPV4_RE.test(b) || b.split(".").some(x => Number(x) > 255)) return { ok: false, error: "invalid broadcast address" }; set.broadcast = b; }
  const hostChanged = (set.host !== undefined && set.host !== cur.host) || (set.ssh_port !== undefined && set.ssh_port !== cur.ssh_port);
  const keys = Object.keys(set);
  if (keys.length) {
    const extra = hostChanged ? ", last_error=NULL" : "";
    db.query(`UPDATE units SET ${keys.map(k => `${k}=?`).join(", ")}${extra} WHERE id=?`).run(...keys.map(k => set[k]), id);
  }
  return { ok: true, hostChanged };
}
