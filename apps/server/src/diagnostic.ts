import type { Database } from "bun:sqlite";
import { audit } from "./db";
import { targetOf, type UnitRow } from "./poller";

export type Check = { id: string; ok: boolean; label: string; detail: string; fix?: string };
export type DiagnosticDeps = {
  db: Database;
  pool: { exec(id: number, target: any, cmd: string, timeoutMs?: number): Promise<string>; drop(id: number): void };
  master: string;
  now: number;
  pollInterval: number;
  authed: boolean;
};
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** Database-only checks; safe to run without contacting the unit. */
export function diagnose(db: Database, now: number, pollInterval: number, id: number): { status: "ok" | "warn" | "error"; checks: Check[] } | null {
  const u = db.query("SELECT * FROM units WHERE id=?").get(id) as any;
  if (!u) return null;
  const checks: Check[] = [];
  const contactThreshold = Math.max(30, pollInterval * 4);
  const contactOk = !!u.last_seen && now - u.last_seen < contactThreshold;
  checks.push({
    id: "contact", ok: contactOk, label: contactOk ? "Agent reachable" : "No recent agent contact",
    detail: u.last_error ? String(u.last_error) : contactOk ? "Recent poll succeeded" : "No successful poll in the expected window",
    fix: contactOk ? undefined : "Check the host/port, then reinstall the agent and use Reconnect.",
  });
  const sampleOk = !!u.last_sample_ts && now - u.last_sample_ts < Math.max(60, (u.sample_interval_s ?? 5) * 4);
  checks.push({
    id: "sample", ok: sampleOk, label: sampleOk ? "Fresh sample" : "Stale or missing sample",
    detail: u.last_sample_ts ? `Last sample ${now - u.last_sample_ts}s ago` : "No sample has been ingested",
    fix: sampleOk ? undefined : "Confirm the agent service is running and the log is being read.",
  });
  checks.push({
    id: "host_key", ok: !!u.host_fingerprint, label: u.host_fingerprint ? "SSH host key pinned" : "SSH host key not pinned yet",
    detail: u.host_fingerprint ?? "The first successful handshake will pin it",
  });
  const hasStatic = !!db.query("SELECT 1 FROM unit_static WHERE unit_id=?").get(id);
  checks.push({
    id: "static", ok: hasStatic, label: hasStatic ? "Static info reported" : "No static info",
    detail: hasStatic ? "CPU/RAM/GPU info available" : "The agent has not reported `info` yet",
    fix: hasStatic ? undefined : "Reinstall the agent if this persists.",
  });
  const unsynced = !!db.query("SELECT 1 FROM unit_services WHERE unit_id=? AND synced=0 LIMIT 1").get(id);
  checks.push({
    id: "services", ok: !unsynced, label: unsynced ? "Service allowlist pending" : "Service allowlist synced",
    detail: unsynced ? "Stored changes have not reached the unit" : "Desired and applied allowlists match",
    fix: unsynced ? "Use Reconcile on the Services section." : undefined,
  });
  const migrating = u.migration_pending_port != null;
  checks.push({
    id: "ssh_port", ok: !migrating, label: migrating ? "Legacy SSH port pending" : "Dedicated SSH port in use",
    detail: migrating ? `Port ${u.migration_pending_port} still recorded` : `Port ${u.ssh_port}`,
    fix: migrating ? "Reinstall the agent with the new port, then clear the pending port." : undefined,
  });
  const failed = checks.filter(c => !c.ok);
  const status = failed.some(c => c.id === "contact" || c.id === "sample") ? "error" : failed.length ? "warn" : "ok";
  return { status, checks };
}

export async function handleDiagnosticRoute(d: DiagnosticDeps, req: Request, path: string, ip = ""): Promise<Response | null> {
  const m = /^\/api\/units\/(\d+)\/(diagnostic|reconnect)(?:\/(probe))?$/.exec(path);
  if (!m) return null;
  if (!d.authed) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET" && req.headers.get("x-cc") !== "1") return json({ error: "csrf" }, 403);
  const id = Number(m[1]), action = m[2], sub = m[3];
  const u = d.db.query("SELECT * FROM units WHERE id=?").get(id) as UnitRow | undefined;
  if (!u) return json({ error: "no such unit" }, 404);

  if (action === "diagnostic" && sub === "probe" && req.method === "POST") {
    try {
      const out = await d.pool.exec(id, targetOf(u, d.master), "info", 15000);
      JSON.parse(out);
      return json({ ok: true, detail: "Agent answered `info` successfully" });
    } catch (e: any) { return json({ ok: false, detail: String(e?.message ?? e) }, 502); }
  }
  if (action === "diagnostic" && req.method === "GET") {
    const result = diagnose(d.db, d.now, d.pollInterval, id);
    return result ? json(result) : json({ error: "no such unit" }, 404);
  }
  if (action === "reconnect" && req.method === "POST") {
    d.pool.drop(id);
    d.db.query("UPDATE units SET last_error=NULL WHERE id=?").run(id);
    audit(d.db, "admin", "unit.reconnect", id, "", ip);
    return json({ ok: true, detail: "Connection dropped; the next poll will reconnect." });
  }
  return json({ error: "method not allowed" }, 405);
}
