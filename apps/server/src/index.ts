import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, getSetting, setSetting, audit } from "./db";
import { ensureAdmin, checkPassword, changePassword, createSession, validSession, destroySession, makeLimiter } from "./auth";
import { monthCost, setCurrentRate, monthKey, getRate } from "./cost";
import { queryMetrics, RANGES, type Range } from "./metrics";
import { rollup, purge } from "./rollup";
import { generateUnitKey, encrypt } from "./crypto";
import { SshPool } from "./ssh";
import { Scheduler, targetOf, type UnitRow } from "./poller";
import { COMMANDS, sendWol } from "./commands";
import { installScript, pasteCommand, curlCommand } from "./install";
import { deleteUnit } from "./units";

const DATA = process.env.CC_DATA ?? join(import.meta.dir, "../../../data");
mkdirSync(DATA, { recursive: true });
const master = process.env.CC_MASTER_KEY ?? (() => { console.warn("CC_MASTER_KEY not set: using a dev key"); return "dev-master-key-change-me"; })();
const db = openDb(join(DATA, "cc.db"));
const initialPw = await ensureAdmin(db, process.env.CC_ADMIN_PASSWORD);
if (initialPw) console.log(`\n== Initial admin password: ${initialPw}  (change it in Settings) ==\n`);

const now = () => Math.floor(Date.now() / 1000);
const pool = new SshPool();
const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
const push = (event: string, data: unknown) => {
  const msg = enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  for (const c of sseClients) { try { c.enqueue(msg); } catch { sseClients.delete(c); } }
};

const pollInterval = () => Math.max(1, Number(getSetting(db, "poll_interval_s", process.env.CC_POLL_INTERVAL ?? "5")));
const sched = new Scheduler(db, pool, master, pollInterval, (unitId, added) => { if (added) push("sample", { unit_id: unitId, latest: latest(unitId) }); });
if (process.env.CC_NO_POLL !== "1") sched.start();
setInterval(() => rollup(db, now()), 60_000);
setInterval(() => purge(db, now(), Number(getSetting(db, "retention_days", "90"))), 3600_000);
rollup(db, now());

function latest(unitId: number) {
  return db.query("SELECT * FROM samples_raw WHERE unit_id=? ORDER BY ts DESC LIMIT 1").get(unitId) as Record<string, number | null> | null;
}
const online = (u: { last_seen: number | null }) => !!u.last_seen && now() - u.last_seen < Math.max(30, pollInterval() * 4);
const unitView = (u: any) => {
  const l = latest(u.id), st = db.query("SELECT json FROM unit_static WHERE unit_id=?").get(u.id) as { json: string } | null;
  const s = st ? JSON.parse(st.json) : null;
  return {
    id: u.id, name: u.name, host: u.host, mac: u.mac, broadcast: u.broadcast, enabled: !!u.enabled, online: online(u), last_seen: u.last_seen, last_error: u.last_error,
    fingerprint: u.fingerprint, sample_interval_s: u.sample_interval_s, static: s, latest: l,
    ram_pct: l && s && l.ram_used_mb != null ? (l.ram_used_mb / s.ram_total_mb) * 100 : null,
    vram_pct: l && s?.vram_total_mb && l.vram_used_mb != null ? (l.vram_used_mb / s.vram_total_mb) * 100 : null,
  };
};
const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...headers } });
const cookieOf = (req: Request) => /(?:^|; )cc_session=([^;]+)/.exec(req.headers.get("cookie") ?? "")?.[1];
const loginLimit = makeLimiter(5, 60);
const WEB = join(import.meta.dir, "../../web/dist");

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3030), hostname: process.env.HOST ?? "0.0.0.0", idleTimeout: 0,
  async fetch(req, srv) {
    const url = new URL(req.url), path = url.pathname, ip = srv.requestIP(req)?.address ?? "";
    try {
      if (path === "/api/health") return json({ app: "control-center", ok: true });
      if (path === "/api/auth/login" && req.method === "POST") {
        if (!loginLimit(ip, now())) return json({ error: "too many attempts" }, 429);
        const body = await req.json().catch(() => ({}));
        if (!(await checkPassword(db, String(body.password ?? "")))) { audit(db, "anon", "login.failed", null, "", ip); return json({ error: "invalid password" }, 401); }
        const id = createSession(db, now()); audit(db, "admin", "login", null, "", ip);
        return json({ ok: true }, 200, { "set-cookie": `cc_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${7 * 86400}` });
      }
      if (path.startsWith("/api/")) {
        if (!validSession(db, cookieOf(req), now())) return json({ error: "unauthorized" }, 401);
        if (req.method !== "GET" && req.headers.get("x-cc") !== "1") return json({ error: "csrf" }, 403);
        return await api(req, url, path, ip);
      }
      if (path.includes("..")) return new Response("bad path", { status: 400 });
      let f = Bun.file(join(WEB, path === "/" ? "index.html" : path));
      if (!(await f.exists())) f = Bun.file(join(WEB, "index.html"));
      return (await f.exists()) ? new Response(f) : new Response("web not built: run bun run build:web\n", { status: 404 });
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, 400);
    }
  },
});

async function api(req: Request, url: URL, path: string, ip: string): Promise<Response> {
  const m = req.method;
  const units = () => db.query("SELECT * FROM units ORDER BY id").all() as any[];
  if (path === "/api/auth/logout" && m === "POST") { const id = cookieOf(req); if (id) destroySession(db, id); return json({ ok: true }, 200, { "set-cookie": "cc_session=; Path=/; Max-Age=0" }); }
  if (path === "/api/auth/password" && m === "POST") { const b = await req.json(); if (!(await checkPassword(db, String(b.current ?? "")))) return json({ error: "current password wrong" }, 400); await changePassword(db, String(b.next ?? "")); audit(db, "admin", "password.changed", null, "", ip); return json({ ok: true }); }
  if (path === "/api/me") return json({ ok: true });

  if (path === "/api/units" && m === "GET") { const mc = monthCost(db, now()); return json(units().map(unitView).map(u => ({ ...u, month: mc.units.find(x => x.id === u.id) }))); }
  if (path === "/api/units" && m === "POST") {
    const b = await req.json();
    if (!b.name || !b.host) return json({ error: "name and host required" }, 400);
    const k = generateUnitKey(`cc-${b.name}`);
    const r = db.query("INSERT INTO units(name,host,ssh_port,pubkey,privkey_enc,fingerprint,mac,broadcast,sample_interval_s,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(String(b.name), String(b.host), Number(b.ssh_port ?? 22), k.publicKey, encrypt(master, k.privateKey), k.fingerprint, b.mac || null, b.broadcast || "255.255.255.255", Number(b.sample_interval_s ?? getSetting(db, "sample_interval_s", "5")), now());
    const id = Number(r.lastInsertRowid);
    audit(db, "admin", "unit.added", id, String(b.name), ip);
    return json({ id, public_key: k.publicKey, fingerprint: k.fingerprint }, 201);
  }
  const um = /^\/api\/units\/(\d+)(?:\/(\w+))?$/.exec(path);
  if (um) {
    const id = Number(um[1]), sub = um[2];
    const u = db.query("SELECT * FROM units WHERE id=?").get(id) as any;
    if (!u) return json({ error: "no such unit" }, 404);
    if (!sub && m === "GET") return json({ ...unitView(u), month: monthCost(db, now()).units.find(x => x.id === id) });
    if (!sub && m === "PATCH") {
      const b = await req.json();
      db.query("UPDATE units SET name=COALESCE(?,name), mac=COALESCE(?,mac), broadcast=COALESCE(?,broadcast), enabled=COALESCE(?,enabled) WHERE id=?").run(b.name ?? null, b.mac ?? null, b.broadcast ?? null, b.enabled == null ? null : b.enabled ? 1 : 0, id);
      audit(db, "admin", "unit.updated", id, JSON.stringify(b), ip); return json(unitView(db.query("SELECT * FROM units WHERE id=?").get(id)));
    }
    if (!sub && m === "DELETE") {
      pool.drop(id); deleteUnit(db, id); audit(db, "admin", "unit.deleted", id, u.name, ip); return json({ ok: true });
    }
    if (sub === "installer" && m === "GET") {
      const script = installScript({ pubkey: u.pubkey, from: process.env.CC_PUBLIC_IP, interval: u.sample_interval_s });
      if (url.searchParams.get("format") === "curl")
        return new Response(curlCommand({ repo: process.env.CC_AGENT_REPO ?? "tunitz/ccagent", tag: process.env.CC_AGENT_TAG ?? "latest", pubkey: u.pubkey }), { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      if (url.searchParams.get("format") === "paste")
        return new Response(pasteCommand(script), { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
      return new Response(script, { headers: { "content-type": "text/x-shellscript", "content-disposition": `attachment; filename="install-ccagent-${u.name.replace(/[^\w.-]/g, "_")}.sh"` } });
    }
    if (sub === "metrics" && m === "GET") {
      const range = (url.searchParams.get("range") ?? "1h") as Range;
      if (!(range in RANGES)) return json({ error: "bad range" }, 400);
      return json(queryMetrics(db, id, range, now()));
    }
    if (sub === "rekey" && m === "POST") {
      const k = generateUnitKey(`cc-${u.name}`);
      db.query("UPDATE units SET pubkey=?, privkey_enc=?, fingerprint=? WHERE id=?").run(k.publicKey, encrypt(master, k.privateKey), k.fingerprint, id);
      pool.drop(id); audit(db, "admin", "unit.rekeyed", id, k.fingerprint, ip);
      return json({ public_key: k.publicKey, fingerprint: k.fingerprint });
    }
    if (sub === "power" && m === "POST") {
      const b = await req.json(), c = COMMANDS[String(b.action)];
      if (!c) return json({ error: "unknown action" }, 400);
      if (c.destructive && b.confirm !== true) return json({ error: "confirm required" }, 400);
      try {
        if (c.gate) await pool.exec(id, targetOf(u as UnitRow, master), c.gate);
        else { if (!u.mac) return json({ error: "no MAC configured for this unit" }, 400); await sendWol(u.mac, u.broadcast); }
      } catch (e: any) {
        // the link may drop as the unit goes down: that still counts as delivered
        if (!(c.gate && /exit null|closed|ECONNRESET|socket|Unable to exec/i.test(String(e?.message)))) { const aid = audit(db, "admin", `power.${c.verb}.failed`, id, String(e?.message), ip); return json({ error: String(e?.message), audit_id: aid }, 502); }
      }
      const aid = audit(db, "admin", `power.${c.verb}`, id, "", ip); return json({ ok: true, audit_id: aid });
    }
  }
  if (path === "/api/cost" && m === "GET") return json(monthCost(db, now()));
  const rm = /^\/api\/rates\/(\d{4}-\d{2})$/.exec(path);
  if (rm && m === "PUT") {
    if (rm[1] !== monthKey(now())) return json({ error: "only the current month's rate can be edited" }, 400);
    const b = await req.json(); setCurrentRate(db, Number(b.php_per_kwh), now()); audit(db, "admin", "rate.set", null, `${rm[1]}=${b.php_per_kwh}`, ip);
    return json({ month: rm[1], php_per_kwh: getRate(db, rm[1], now()) });
  }
  if (path === "/api/rates" && m === "GET") { getRate(db, monthKey(now()), now()); return json(db.query("SELECT month, php_per_kwh, set_at FROM rates ORDER BY month DESC").all()); }
  if (path === "/api/settings" && m === "GET") return json({ poll_interval_s: pollInterval(), sample_interval_s: Number(getSetting(db, "sample_interval_s", "5")), retention_days: Number(getSetting(db, "retention_days", "90")) });
  if (path === "/api/settings" && m === "PUT") {
    const b = await req.json();
    if (b.poll_interval_s != null) setSetting(db, "poll_interval_s", String(Math.min(3600, Math.max(1, Number(b.poll_interval_s)))));
    if (b.sample_interval_s != null) setSetting(db, "sample_interval_s", String(Math.min(3600, Math.max(1, Number(b.sample_interval_s)))));
    if (b.retention_days != null) setSetting(db, "retention_days", String(Math.min(90, Math.max(1, Number(b.retention_days)))));
    audit(db, "admin", "settings.updated", null, JSON.stringify(b), ip); return json({ ok: true });
  }
  if (path === "/api/audit" && m === "GET") return json(db.query("SELECT a.*, u.name unit FROM audit a LEFT JOIN units u ON u.id=a.unit_id ORDER BY a.id DESC LIMIT ?").all(Math.min(500, Number(url.searchParams.get("limit") ?? 100))));
  if (path === "/api/events") {
    let ctl: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) { ctl = c; sseClients.add(c); c.enqueue(enc.encode("event: hello\ndata: {}\n\n")); },
      cancel() { sseClients.delete(ctl); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
  }
  return json({ error: "not found" }, 404);
}
setInterval(() => push("ping", {}), 20_000);
console.log(`Control Center on :${server.port}`);
