import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { decrypt } from "./crypto";
import { ingestLines } from "./ingest";
import { SshPool, type Target } from "./ssh";

export type UnitRow = { id: number; name: string; host: string; ssh_port: number; ssh_user: string; privkey_enc: string; sample_interval_s: number; enabled: number; host_fingerprint: string | null };
export type Fetcher = { exec(id: number, t: Target, cmd: string): Promise<string> };

export function fingerprintOfKey(key: Buffer): string {
  return "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
}
export function targetOf(u: UnitRow, master: string): Target {
  const expected = u.host_fingerprint;
  return {
    host: u.host, port: u.ssh_port, username: u.ssh_user, privateKey: decrypt(master, u.privkey_enc),
    hostVerifier: expected ? key => {
      const seen = fingerprintOfKey(key);
      if (seen !== expected) console.error(`[ssh] host key mismatch for unit ${u.id}: expected ${expected}, got ${seen}`);
      return seen === expected;
    } : undefined,
  };
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
    const output = await f.exec(u.id, t, "read");
    if (!output.split("\n").some(l => l.startsWith("#END"))) throw new Error("incomplete read: missing end marker");
    const groups = parseRead(output);
    let added = 0;
    for (const g of groups) added += ingestLines(db, u.id, g.lines, u.sample_interval_s);
    if (groups.length) await f.exec(u.id, t, `ack ${groups[groups.length - 1].name}`);
    const freshest = db.query("SELECT MAX(ts) ts FROM samples_raw WHERE unit_id=?").get(u.id) as { ts: number | null };
    db.query("UPDATE units SET last_seen=?, last_sample_ts=?, last_error=NULL WHERE id=?").run(now, freshest.ts, u.id);
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

const log = (msg: string) => console.log(`[poll] ${new Date().toISOString()} ${msg}`);
const withTimeout = <T,>(p: Promise<T>, ms: number, msg: string) =>
  new Promise<T>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(msg)), ms);
    p.then(v => { clearTimeout(timer); res(v); }, e => { clearTimeout(timer); rej(e); });
  });

export type SchedulerOpts = {
  /** Hard cap on one unit's whole poll cycle; a wedge must never own the unit's poll slot forever. */
  pollTimeoutMs?: number;
};

/** Runs polls on a timer with per-unit jitter; one in-flight poll per unit, always bounded. */
export class Scheduler {
  private timer?: ReturnType<typeof setInterval>;
  private busy = new Set<number>();
  private statics = new Set<number>();
  private failing = new Map<number, string>();
  private pollTimeoutMs: number;
  private tick: (() => void) | null = null;
  private currentIntervalS = 0;
  constructor(private db: Database, private pool: SshPool, private master: string, private getIntervalS: () => number, private onSamples: (unitId: number, added: number) => void, opts: SchedulerOpts = {}) {
    this.pollTimeoutMs = opts.pollTimeoutMs ?? 30_000;
  }
  start() {
    this.tick = () => {
      const units = this.db.query("SELECT * FROM units WHERE enabled=1").all() as UnitRow[];
      units.forEach((u, i) => setTimeout(() => this.run(u), (i * 997) % Math.max(1, this.getIntervalS() * 1000 / 2)));
    };
    this.currentIntervalS = this.getIntervalS();
    this.tick(); this.restart();
  }
  private restart() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick?.(), this.currentIntervalS * 1000);
  }
  /** Re-arm the timer when settings change; no restart required. */
  refreshInterval() {
    const next = this.getIntervalS();
    if (next === this.currentIntervalS) return;
    this.currentIntervalS = next;
    this.restart();
  }
  stop() { if (this.timer) clearInterval(this.timer); this.pool.closeAll(); }
  private ok(u: UnitRow) {
    if (this.failing.has(u.id)) { log(`unit ${u.id} ${u.name} (${u.host}) recovered`); this.failing.delete(u.id); }
  }
  private failed(u: UnitRow, e: unknown) {
    const msg = String((e as any)?.message ?? e).slice(0, 200);
    this.db.query("UPDATE units SET last_error=? WHERE id=?").run(msg, u.id);
    if (this.failing.get(u.id) !== msg) { this.failing.set(u.id, msg); log(`unit ${u.id} ${u.name} (${u.host}) failing: ${msg}`); }
  }
  async run(u: UnitRow) {
    if (this.busy.has(u.id)) return;
    this.busy.add(u.id);
    try {
      await withTimeout(this.cycle(u), this.pollTimeoutMs, `poll watchdog: no result in ${this.pollTimeoutMs}ms`);
      this.ok(u);
    } catch (e) {
      this.failed(u, e);
      this.pool.drop(u.id); // a wedged connection must not be reused; the next tick reconnects
    } finally { this.busy.delete(u.id); }
  }
  private async cycle(u: UnitRow) {
    const now = Math.floor(Date.now() / 1000);
    if (!this.statics.has(u.id)) { await refreshStatic(this.db, this.pool, u, this.master, now); this.statics.add(u.id); }
    // TOFU: pin the host key on the first authenticated handshake. Later connections
    // present a verifier that rejects any different key.
    if (!u.host_fingerprint) {
      const raw = this.pool.hostKey(u.id);
      if (raw) {
        u.host_fingerprint = fingerprintOfKey(Buffer.from(raw, "base64"));
        this.db.query("UPDATE units SET host_fingerprint=? WHERE id=?").run(u.host_fingerprint, u.id);
      }
    }
    const added = await pollUnit(this.db, this.pool, u, this.master, now);
    this.onSamples(u.id, added);
  }
}
