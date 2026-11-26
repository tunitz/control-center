import type { Database } from "bun:sqlite";
import { audit } from "./db";
import { getTimezone, localTime } from "./tz";

export { localTime };
export const ALERT_KINDS = ["offline", "stale", "disk"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

/** A window covers midnight by wrapping its end past 1440 minutes. Days are comma-separated weekdays. */
export function inWindow(w: { days: string; start_minute: number; end_minute: number }, now: number, tz?: string): boolean {
  const { weekday, minute } = localTime(now, tz);
  if (!String(w.days).split(",").map(x => x.trim()).includes(String(weekday))) return false;
  const start = w.start_minute, end = w.end_minute;
  return end >= start ? minute >= start && minute < end : minute >= start || minute < end;
}

const inMaintenance = (db: Database, unitId: number, now: number): boolean => {
  const tz = getTimezone(db);
  const rows = db.query("SELECT * FROM maintenance_windows WHERE enabled=1 AND (unit_id IS NULL OR unit_id=?)").all(unitId) as any[];
  return rows.some(w => inWindow(w, now, tz));
};

/** Recompute active alerts for all enabled units. Returns the active count. */
export function evaluateAlerts(db: Database, now: number, pollInterval: number): number {
  const units = db.query("SELECT * FROM units WHERE enabled=1").all() as any[];
  const rules = db.query("SELECT * FROM alert_rules").all() as any[];
  const ruleMap = new Map(rules.map(r => [`${r.unit_id}:${r.kind}`, r]));
  const active = new Set<string>();
  const setAlert = db.query("INSERT INTO alert_state(unit_id,kind,since_ts,message) VALUES(?,?,?,?) ON CONFLICT(unit_id,kind) DO UPDATE SET message=excluded.message");
  const clear = db.query("DELETE FROM alert_state WHERE unit_id=? AND kind=?");
  db.transaction(() => {
    for (const u of units) {
      const suppressed = inMaintenance(db, u.id, now);
      const candidates: { kind: AlertKind; on: boolean; message: string }[] = [];
      const contactOk = !!u.last_seen && now - u.last_seen < Math.max(30, pollInterval * 4);
      candidates.push({ kind: "offline", on: !contactOk, message: u.last_error ? String(u.last_error) : "No successful poll in the expected window" });
      if (contactOk) {
        const sampleOk = !!u.last_sample_ts && now - u.last_sample_ts < Math.max(60, (u.sample_interval_s ?? 5) * 4);
        candidates.push({ kind: "stale", on: !sampleOk, message: sampleOk ? "" : "No recent telemetry sample" });
        const disk = db.query("SELECT json FROM unit_disks WHERE unit_id=?").get(u.id) as { json: string } | null;
        const rule = ruleMap.get(`${u.id}:disk`);
        const threshold = rule?.threshold ?? 90;
        let high = "";
        try {
          const mounts = disk ? JSON.parse(disk.json) as { mount: string; total_mb: number; used_mb: number }[] : [];
          const hot = mounts.find(m => m.total_mb > 0 && (m.used_mb / m.total_mb) * 100 >= threshold);
          if (hot) high = `${hot.mount} above ${threshold}% used`;
        } catch { /* ignore corrupt snapshot */ }
        candidates.push({ kind: "disk", on: !!high, message: high });
      }
      for (const c of candidates) {
        const rule = ruleMap.get(`${u.id}:${c.kind}`);
        const enabled = rule ? !!rule.enabled : c.kind !== "disk"; // disk alerts opt-in
        if (!enabled || !c.on || suppressed) { clear.run(u.id, c.kind); continue; }
        setAlert.run(u.id, c.kind, now, c.message);
        active.add(`${u.id}:${c.kind}`);
      }
    }
  })();
  return active.size;
}

export type AlertDeps = { db: Database; now: number; pollInterval: number; authed: boolean };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

export async function handleAlertRoute(d: AlertDeps, req: Request, path: string, ip = ""): Promise<Response | null> {
  if (path === "/api/alerts" && req.method === "GET") {
    return json({
      active: d.db.query("SELECT s.*, u.name FROM alert_state s LEFT JOIN units u ON u.id=s.unit_id ORDER BY s.since_ts DESC").all(),
      rules: d.db.query("SELECT * FROM alert_rules ORDER BY unit_id,kind").all(),
      windows: d.db.query("SELECT * FROM maintenance_windows ORDER BY id").all(),
    });
  }
  return handleAlertWrite(d, req, path, ip);
}

/** PUT rule update. Kept separate so callers can await the body. */
export async function updateAlertRule(d: AlertDeps, req: Request, unitId: number, kind: string, ip = ""): Promise<Response> {
  if (!ALERT_KINDS.includes(kind as AlertKind)) return json({ error: "invalid alert kind" }, 400);
  if (!d.db.query("SELECT 1 FROM units WHERE id=?").get(unitId)) return json({ error: "no such unit" }, 404);
  const body = await req.json().catch(() => ({}));
  const enabled = body.enabled === undefined ? 1 : (body.enabled ? 1 : 0);
  const threshold = body.threshold == null ? null : Number(body.threshold);
  if (threshold != null && (!isFinite(threshold) || threshold <= 0 || threshold > 100)) return json({ error: "threshold must be 1..100" }, 400);
  d.db.query("INSERT INTO alert_rules(unit_id,kind,enabled,threshold) VALUES(?,?,?,?) ON CONFLICT(unit_id,kind) DO UPDATE SET enabled=excluded.enabled,threshold=excluded.threshold")
    .run(unitId, kind, enabled, threshold);
  audit(d.db, "admin", "alert.rule", unitId, `${kind}:${enabled}${threshold == null ? "" : `@${threshold}`}`, ip);
  return json({ ok: true });
}

export async function handleAlertWrite(d: AlertDeps, req: Request, path: string, ip = ""): Promise<Response | null> {
  const rule = /^\/api\/alerts\/(\d+)\/(offline|stale|disk)$/.exec(path);
  if (rule && req.method === "PUT") return updateAlertRule(d, req, Number(rule[1]), rule[2], ip);
  if (path === "/api/alerts/maintenance" && req.method === "POST") {
    const b = await req.json().catch(() => ({}));
    const days: string = typeof b.days === "string" ? b.days : "0,1,2,3,4,5,6";
    if (!/^[\d,]+$/.test(days) || days.split(",").some(x => Number(x) > 6)) return json({ error: "invalid days" }, 400);
    const start = Number(b.start_minute), end = Number(b.end_minute);
    if (![start, end].every(n => Number.isInteger(n) && n >= 0 && n < 1440)) return json({ error: "minutes must be 0..1439" }, 400);
    const unitId = b.unit_id == null || b.unit_id === "" ? null : Number(b.unit_id);
    if (unitId != null && !d.db.query("SELECT 1 FROM units WHERE id=?").get(unitId)) return json({ error: "no such unit" }, 404);
    d.db.query("INSERT INTO maintenance_windows(unit_id,days,start_minute,end_minute,enabled) VALUES(?,?,?,?,1)").run(unitId, days, start, end);
    audit(d.db, "admin", "alert.maintenance.add", unitId, `${days} ${start}-${end}`, ip);
    return json({ ok: true });
  }
  const del = /^\/api\/alerts\/maintenance\/(\d+)$/.exec(path);
  if (del && req.method === "DELETE") {
    d.db.query("DELETE FROM maintenance_windows WHERE id=?").run(Number(del[1]));
    audit(d.db, "admin", "alert.maintenance.remove", null, del[1], ip);
    return json({ ok: true });
  }
  return null;
}
