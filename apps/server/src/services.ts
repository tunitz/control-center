import type { Database } from "bun:sqlite";
import { audit } from "./db";
import { targetOf, type UnitRow } from "./poller";

export type Kind = "systemd" | "user" | "docker" | "lxc";
export type ServiceItem = { kind: Kind; name: string };
export type ServiceDeps = { db: Database; pool: { exec(id: number, target: any, cmd: string, timeoutMs?: number, stdin?: string): Promise<string> }; master: string; now: number; pollInterval: number; authed: boolean };
export const LIST_CMD = "svc-list", DISCOVER_CMD = "svc-discover", ALLOW_CMD = "svc-allow";
const NAME = /^[A-Za-z0-9][A-Za-z0-9@._:-]{0,127}$/, VMID = /^[0-9]{1,9}$/;
const USER = /^[a-z_][a-z0-9_-]{0,31}$/, USER_NAME_MAX = 160;
export function validKind(v: unknown): v is Kind { return v === "systemd" || v === "user" || v === "docker" || v === "lxc"; }
export function validName(kind: Kind, name: unknown): name is string {
  if (typeof name !== "string") return false;
  if (kind === "lxc") return VMID.test(name);
  if (kind === "user") {
    const i = name.indexOf(":");
    return name.length <= USER_NAME_MAX && i > 0 && USER.test(name.slice(0, i)) && NAME.test(name.slice(i + 1));
  }
  return NAME.test(name);
}
export function validateItems(body: any): { ok: true; items: ServiceItem[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || !Array.isArray(body.items) || body.items.length > 200) return { ok: false, error: "invalid items" };
  const out: ServiceItem[] = [], seen = new Set<string>();
  for (const x of body.items) {
    if (!x || typeof x !== "object" || !validKind(x.kind) || !validName(x.kind, x.name)) return { ok: false, error: "invalid service item" };
    const k = `${x.kind}\0${x.name}`; if (!seen.has(k)) { seen.add(k); out.push({ kind: x.kind, name: x.name }); }
  }
  return { ok: true, items: out };
}
export function clampLogLines(v: string | null | undefined) { if (v == null || !/^-?\d+(?:\.\d+)?$/.test(v)) return 200; return Math.max(1, Math.min(500, Math.trunc(Number(v)))); }
export function buildActCmd(kind: Kind, name: string, action: string) { if (!validKind(kind) || !validName(kind, name) || !["start", "stop", "restart"].includes(action)) throw new Error("invalid service command"); return `svc-act ${kind} ${name} ${action}`; }
export function buildLogsCmd(kind: Kind, name: string, n: number) { if (!validKind(kind) || !validName(kind, name) || !Number.isInteger(n) || n < 1 || n > 500) throw new Error("invalid service command"); return `svc-logs ${kind} ${name} ${n}`; }
export function auditAction(action: string, failed: boolean) { return action === "allow" ? `svc.allow${failed ? ".failed" : ""}` : `svc.${action}${failed ? ".failed" : ""}`; }
export function errorText(e: unknown) { let s = String((e as any)?.message ?? e).replace(/^exit \d+:\s*/, ""); try { const o = JSON.parse(s); if (o?.error) return String(o.error); } catch {} return s; }
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const isOnline = (u: any, d: ServiceDeps) => !!u.last_seen && d.now - u.last_seen < Math.max(30, d.pollInterval * 4);
function parseAgent(out: string) { const x = JSON.parse(out); if (!x || typeof x !== "object" || typeof x.ok !== "boolean") throw new Error("invalid agent response"); if (!x.ok) throw new Error(JSON.stringify(x)); return x.data ?? {}; }
function auditSvc(d: ServiceDeps, action: string, id: number, detail: string, ip: string) { audit(d.db, "admin", action.startsWith("svc.") ? action : auditAction(action, false), id, detail, ip); }
const getDesired = (db: Database, id: number) => db.query("SELECT kind,name FROM unit_services WHERE unit_id=? ORDER BY kind,name").all(id) as ServiceItem[];
const needsSync = (db: Database, id: number) => !!(db.query("SELECT 1 FROM unit_services WHERE unit_id=? AND synced=0 LIMIT 1").get(id));
/** Push the stored allowlist to a unit and mark it synced only after the agent confirms. */
export async function pushAllowlist(d: ServiceDeps, id: number, online: boolean, exec: (cmd: string, stdin?: string) => Promise<string>, override?: ServiceItem[]): Promise<{ ok: true } | { ok: false; error: string }> {
  const items = override ?? getDesired(d.db, id);
  if (!online) return { ok: false, error: "unit offline" };
  try {
    await exec(ALLOW_CMD, JSON.stringify({ items }));
    d.db.query("UPDATE unit_services SET synced=1 WHERE unit_id=?").run(id);
    return { ok: true };
  } catch (e) { return { ok: false, error: errorText(e) }; }
}

/** Handles only service-control routes; null means normal routing continues. */
export async function handleServiceRoute(d: ServiceDeps, req: Request, url: URL, path: string, ip = ""): Promise<Response | null> {
  const root = /^\/api\/units\/(\d+)\/services(?:\/(.*))?$/.exec(path); if (!root) return null;
  if (!d.authed) return json({ error: "unauthorized" }, 401);
  if (req.method !== "GET" && req.headers.get("x-cc") !== "1") return json({ error: "csrf" }, 403);
  const id = Number(root[1]), u = d.db.query("SELECT * FROM units WHERE id=?").get(id) as any;
  if (!u) return json({ error: "no such unit" }, 404);
  const sub = root[2] ?? "", online = isOnline(u, d), target = () => targetOf(u as UnitRow, d.master);
  const exec = (cmd: string, stdin?: string) => d.pool.exec(id, target(), cmd, 40000, stdin); // svc-* can queue up to LOCK_WAIT(20s)+SVC_WAIT(8s); keep >= 40s
  if (sub === "" && req.method === "GET") {
    const unsynced = needsSync(d.db, id);
    if (!online) return json({ error: "unit offline", needs_sync: unsynced }, 409);
    try { return json({ items: parseAgent(await exec(LIST_CMD)).items ?? [], needs_sync: unsynced }); }
    catch (e) { return json({ items: [], error: errorText(e), needs_sync: unsynced }); }
  }
  if (sub === "discover" && req.method === "GET") {
    if (!online) return json({ error: "unit offline" }, 409);
    try { return json({ items: parseAgent(await exec(DISCOVER_CMD)).items ?? [] }); } catch (e) { return json({ error: errorText(e) }, 502); }
  }
  if (sub === "allow" && req.method === "GET") return json({ items: d.db.query("SELECT kind,name FROM unit_services WHERE unit_id=? ORDER BY kind,name").all(id) });
  if (sub === "allow" && req.method === "PUT") {
    const checked = validateItems(await req.json().catch(() => null)); if (!checked.ok) return json({ error: checked.error }, 400);
    // Store as unsynced first; only mark synced after the agent applies it.
    d.db.transaction(() => {
      d.db.query("DELETE FROM unit_services WHERE unit_id=?").run(id);
      const q=d.db.query("INSERT INTO unit_services(unit_id,kind,name,synced) VALUES(?,?,?,0)");
      for (const x of checked.items) q.run(id,x.kind,x.name);
    })();
    const pushed = await pushAllowlist(d, id, online, exec, checked.items);
    if (!pushed.ok) { auditSvc(d,"allow.failed",id,pushed.error,ip); return json({error:pushed.error,items:checked.items,needs_sync:true},502); }
    auditSvc(d,"allow",id,"",ip); return json({ok:true,items:checked.items,needs_sync:false});
  }
  if (sub === "reconcile" && req.method === "POST") {
    const pushed = await pushAllowlist(d, id, online, exec);
    if (!pushed.ok) { auditSvc(d,"allow.failed",id,`reconcile: ${pushed.error}`,ip); return json({error:pushed.error,needs_sync:true},502); }
    auditSvc(d,"allow.reconciled",id,"",ip); return json({ok:true,needs_sync:false});
  }
  const m = /^(\w+)\/([^/]+)\/(\w+)$/.exec(sub);
  if (m) {
    let name:string; try{name=decodeURIComponent(m[2]);}catch{return json({error:"invalid name"},400);}
    const kind=m[1] as Kind, leaf=m[3]; if(!validKind(kind)||!validName(kind,name)) return json({error:"invalid service name"},400);
    if (!["logs", "start", "stop", "restart"].includes(leaf)) return json({ error: "invalid action" }, 400);
    if (leaf === "logs" && req.method === "GET") {
      if(!online)return json({error:"unit offline"},409);
      if(!d.db.query("SELECT 1 FROM unit_services WHERE unit_id=? AND kind=? AND name=?").get(id,kind,name))return json({error:"service not allowed"},403);
      try{return json({lines:parseAgent(await exec(buildLogsCmd(kind,name,clampLogLines(url.searchParams.get("n"))))).lines??[]});}catch(e){return json({error:errorText(e)},502);}
    }
    if(["start","stop","restart"].includes(leaf)&&req.method==="POST"){
      if(!d.db.query("SELECT 1 FROM unit_services WHERE unit_id=? AND kind=? AND name=?").get(id,kind,name))return json({error:"service not allowed"},403);
      if(!online)return json({error:"unit offline"},409);
      try{const data=parseAgent(await exec(buildActCmd(kind,name,leaf))); auditSvc(d,leaf,id,`${kind}:${name}`,ip); return json({ok:true,...data});}
      catch(e){const error=errorText(e);audit(d.db,"admin",auditAction(leaf,true),id,`${kind}:${name}: ${error}`,ip);return json({error},502);}
    }
    return json({error:"method not allowed"},405);
  }
  if(sub===""&&req.method!=="GET")return json({error:"method not allowed"},405);
  if(sub==="discover"||sub==="allow"||sub==="reconcile")return json({error:"method not allowed"},405);
  return null;
}
