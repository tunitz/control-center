import type { Database } from "bun:sqlite";
import { decrypt } from "./crypto";
import { ingestLines } from "./ingest";
import { SshPool, type Target } from "./ssh";

export type UnitRow = { id: number; host: string; ssh_port: number; ssh_user: string; privkey_enc: string; sample_interval_s: number; enabled: number };
export type Fetcher = { exec(id: number, t: Target, cmd: string): Promise<string> };

export function targetOf(u: UnitRow, master: string): Target {
  return { host: u.host, port: u.ssh_port, username: u.ssh_user, privateKey: decrypt(master, u.privkey_enc) };
}

/** Parse the gate's `read` output into [fileName, lines[]] groups. */
export function parseRead(out: string): { name: string; lines: string[] }[] {
  const groups: { name: string; lines: string[] }[] = [];
  for (const l of out.split("\n")) {
    if (l.startsWith("#F ")) groups.push({ name: l.slice(3).trim(), lines: [] });
    else if (l.startsWith("#END")) break;
    else if (l && groups.length) groups[groups.length - 1].lines.push(l);
  }
  return groups;
}

/** One at-least-once cycle: read -> ingest -> ack newest file. A failure before ack leaves files for the next read. */
export async function pollUnit(db: Database, f: Fetcher, u: UnitRow, master: string, now: number): Promise<number> {
  const t = targetOf(u, master);
  try {
    const groups = parseRead(await f.exec(u.id, t, "read"));
    let added = 0;
    for (const g of groups) added += ingestLines(db, u.id, g.lines, u.sample_interval_s);
    if (groups.length) await f.exec(u.id, t, `ack ${groups[groups.length - 1].name}`);
    db.query("UPDATE units SET last_seen=?, last_error=NULL WHERE id=?").run(now, u.id);
    return added;
  } catch (e: any) {
    db.query("UPDATE units SET last_error=? WHERE id=?").run(String(e?.message ?? e).slice(0, 200), u.id);
    throw e;
  }
}
export async function refreshStatic(db: Database, f: Fetcher, u: UnitRow, master: string, now: number) {
  const out = await f.exec(u.id, targetOf(u, master), "info");
  JSON.parse(out);
  db.query("INSERT INTO unit_static(unit_id,json,updated_at) VALUES(?,?,?) ON CONFLICT(unit_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at").run(u.id, out.trim(), now);
}

/** Runs polls on a timer with per-unit jitter; one in-flight poll per unit. */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private busy = new Set<number>();
  private statics = new Set<number>();
  constructor(private db: Database, private pool: SshPool, private master: string, private getIntervalS: () => number, private onSamples: (unitId: number, added: number) => void) {}
  start() {
    const tick = () => {
      const units = this.db.query("SELECT * FROM units WHERE enabled=1").all() as UnitRow[];
      units.forEach((u, i) => setTimeout(() => this.run(u), (i * 997) % Math.max(1, this.getIntervalS() * 1000 / 2)));
    };
    tick(); this.restart(tick);
  }
  private restart(tick: () => void) { this.timer = setInterval(tick, this.getIntervalS() * 1000); }
  stop() { if (this.timer) clearInterval(this.timer); this.pool.closeAll(); }
  async run(u: UnitRow) {
    if (this.busy.has(u.id)) return;
    this.busy.add(u.id);
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!this.statics.has(u.id)) { await refreshStatic(this.db, this.pool, u, this.master, now); this.statics.add(u.id); }
      const added = await pollUnit(this.db, this.pool, u, this.master, now);
      this.onSamples(u.id, added);
    } catch { this.pool.drop(u.id); } finally { this.busy.delete(u.id); }
  }
}
