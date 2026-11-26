import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { encrypt } from "./crypto";
import { deleteUnit } from "./units";
import {
  validKind, validName, validateItems, clampLogLines, buildActCmd, buildLogsCmd, auditAction, errorText,
  handleServiceRoute, LIST_CMD, DISCOVER_CMD, ALLOW_CMD, type ServiceDeps,
} from "./services";

const MASTER = "m";
const NOW = 1_700_000_000;
let db: ReturnType<typeof openDb>;
let calls: { id: number; cmd: string; timeoutMs?: number; stdin?: string }[];
let reply: (cmd: string, stdin?: string) => string | Error;

const pool = {
  exec: async (id: number, _t: unknown, cmd: string, timeoutMs?: number, stdin?: string) => {
    calls.push({ id, cmd, timeoutMs, stdin });
    const r = reply(cmd, stdin);
    if (r instanceof Error) throw r;
    return r;
  },
};
const deps = (over: Partial<ServiceDeps> = {}): ServiceDeps => ({ db, pool: pool as any, master: MASTER, now: NOW, pollInterval: 5, authed: true, ...over });
const addUnit = (id: number, lastSeen: number | null) =>
  db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at,last_seen) VALUES(?,?,?,?,?,0,?)").run(id, "u" + id, "h", "pk", encrypt(MASTER, "priv"), lastSeen);
const req = (method: string, path: string, body?: unknown, cc = true) =>
  new Request("http://cc.test" + path, {
    method, headers: { ...(cc ? { "x-cc": "1" } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const route = (d: ServiceDeps, r: Request) => handleServiceRoute(d, r, new URL(r.url), new URL(r.url).pathname, "1.2.3.4");
const allowRows = (id = 1) => db.query("SELECT kind,name FROM unit_services WHERE unit_id=? ORDER BY kind,name").all(id);
const auditRows = () => db.query("SELECT action, unit_id, detail FROM audit ORDER BY id").all() as { action: string; unit_id: number; detail: string }[];

beforeEach(() => {
  db = openDb(":memory:");
  addUnit(1, NOW); // online
  calls = [];
  reply = () => JSON.stringify({ ok: true, data: {} });
});

// ---------- pure validators and builders ----------

test("kind is exactly systemd|user|docker|lxc", () => {
  for (const k of ["systemd", "user", "docker", "lxc"]) expect(validKind(k)).toBe(true);
  for (const k of ["SYSTEMD", "tmux", "", "systemd ", "docker;x", undefined, 1]) expect(validKind(k as any)).toBe(false);
});

test("name rules: general pattern for systemd/docker, vmid digits for lxc", () => {
  const ok: [string, string][] = [["systemd", "nginx.service"], ["systemd", "sshd@2.service"], ["systemd", "a:b_c-1.timer"], ["docker", "my.app_1"], ["systemd", "a".repeat(128)], ["lxc", "101"], ["lxc", "0"], ["lxc", "123456789"]];
  const bad: [string, string][] = [["systemd", ""], ["systemd", "a".repeat(129)], ["systemd", "a b"], ["systemd", "a;b"], ["systemd", "a\nb"], ["systemd", "../x"], ["systemd", "*"], ["systemd", "a/b"], ["systemd", "a$b"], ["lxc", "1x"], ["lxc", "1234567890"], ["lxc", "-1"], ["lxc", ""], ["lxc", "nginx.service"]];
  for (const [k, n] of ok) expect([k, n, validName(k as any, n)]).toEqual([k, n, true]);
  for (const [k, n] of bad) expect([k, n, validName(k as any, n)]).toEqual([k, n, false]);
});

test("user kind: name is <username>:<unit>, split at the first ':'", () => {
  for (const n of ["carol:foo.service", "a_b-1:sshd@2.service", "x:syncthing.service", "u:a:b"]) expect([n, validName("user", n)]).toEqual([n, true]);
  for (const n of ["foo.service", ":foo", "Carol:foo", "carol:-x", "carol:", "carol:a b", "carol:a;b", "-u:foo", "1u:foo", "a".repeat(33) + ":foo"]) {
    expect([n, validName("user", n)]).toEqual([n, false]);
  }
  expect(validName("user", "a" + ":" + "b".repeat(127))).toBe(true);
  expect(validName("user", "a".repeat(32) + ":" + "b".repeat(127))).toBe(true);
  expect(validName("user", "a".repeat(32) + ":" + "b".repeat(128))).toBe(false);
  expect(validName("user", "a" + ":" + "b".repeat(128))).toBe(true);
  expect(validName("user", "a" + ":" + "b".repeat(129))).toBe(false);
});

test("user kind: validateItems accepts user items", () => {
  expect(validateItems({ items: [{ kind: "user", name: "carol:syncthing.service" }] }))
    .toEqual({ ok: true, items: [{ kind: "user", name: "carol:syncthing.service" }] });
  expect(validateItems({ items: [{ kind: "user", name: "syncthing.service" }] }).ok).toBe(false);
});

test("user kind: command builders emit svc-act/svc-logs with the user:unit name", () => {
  expect(buildActCmd("user", "carol:syncthing.service", "restart")).toBe("svc-act user carol:syncthing.service restart");
  expect(buildLogsCmd("user", "carol:sshd@2.service", 100)).toBe("svc-logs user carol:sshd@2.service 100");
  expect(() => buildActCmd("user", "bad name:x.service", "start")).toThrow();
  expect(() => buildLogsCmd("user", "syncthing.service", 5)).toThrow();
});

test("name must start with an alphanumeric (no leading '-' that tools would read as an option)", () => {
  for (const n of ["-x", "--all", "-", "@svc", ".hidden", ":x", "_x"]) {
    expect([n, validName("systemd", n)]).toEqual([n, false]);
    expect([n, validName("docker", n)]).toEqual([n, false]);
  }
  for (const n of ["x", "X1", "1x", "a-b", "0.service"]) expect([n, validName("systemd", n)]).toEqual([n, true]);
});

test("validateItems: strips extra fields, de-duplicates, enforces max 200 and shapes", () => {
  expect(validateItems({ items: [{ kind: "systemd", name: "a.service", x: 1 }, { kind: "systemd", name: "a.service" }, { kind: "lxc", name: "101" }] }))
    .toEqual({ ok: true, items: [{ kind: "systemd", name: "a.service" }, { kind: "lxc", name: "101" }] });
  expect(validateItems({ items: [] })).toEqual({ ok: true, items: [] });
  expect(validateItems({ items: Array.from({ length: 200 }, (_, i) => ({ kind: "systemd", name: `s${i}.service` })) }).ok).toBe(true);
  expect(validateItems({ items: Array.from({ length: 201 }, (_, i) => ({ kind: "systemd", name: `s${i}.service` })) }).ok).toBe(false);
  for (const bad of [null, {}, { items: "x" }, { items: [null] }, { items: [{ kind: "tmux", name: "a" }] }, { items: [{ kind: "lxc", name: "abc" }] }, { items: [{ kind: "systemd", name: "a;b" }] }]) {
    expect(validateItems(bad as any).ok).toBe(false);
  }
});

test("clampLogLines: default 200, clamped to 1..500, non-numbers default", () => {
  expect(clampLogLines(undefined)).toBe(200);
  expect(clampLogLines("abc")).toBe(200);
  expect(clampLogLines("0")).toBe(1);
  expect(clampLogLines("-5")).toBe(1);
  expect(clampLogLines("999")).toBe(500);
  expect(clampLogLines("12.7")).toBe(12);
  expect(clampLogLines("50")).toBe(50);
});

test("command builders produce the exact gate lines and refuse invalid input", () => {
  expect(buildActCmd("systemd", "nginx.service", "restart")).toBe("svc-act systemd nginx.service restart");
  expect(buildActCmd("lxc", "101", "stop")).toBe("svc-act lxc 101 stop");
  expect(buildLogsCmd("docker", "web", 200)).toBe("svc-logs docker web 200");
  expect(() => buildActCmd("systemd", "a;b", "start")).toThrow();
  expect(() => buildActCmd("systemd", "nginx", "reload")).toThrow();
  expect(() => buildActCmd("nope" as any, "nginx", "start")).toThrow();
  expect(() => buildLogsCmd("lxc", "x", 5)).toThrow();
  expect(LIST_CMD).toBe("svc-list");
  expect(DISCOVER_CMD).toBe("svc-discover");
  expect(ALLOW_CMD).toBe("svc-allow");
});

test("audit action names: svc.<action>, and .failed on failure; allow has its own pair", () => {
  expect(auditAction("start", false)).toBe("svc.start");
  expect(auditAction("stop", false)).toBe("svc.stop");
  expect(auditAction("restart", true)).toBe("svc.restart.failed");
  expect(auditAction("allow", false)).toBe("svc.allow");
  expect(auditAction("allow", true)).toBe("svc.allow.failed");
});

test("errorText strips the ssh exit prefix and unwraps a JSON error from the helper", () => {
  expect(errorText(new Error("exit 3: svc helper missing"))).toBe("svc helper missing");
  expect(errorText(new Error('exit 3: {"ok":false,"code":"failed","error":"Unit not loaded"}'))).toBe("Unit not loaded");
  expect(errorText(new Error("connect ECONNREFUSED"))).toBe("connect ECONNREFUSED");
});

test("deleteUnit removes the unit's allowlist rows and leaves other units' rows", () => {
  addUnit(2, NOW);
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','a.service'),(2,'systemd','b.service')").run();
  deleteUnit(db, 1);
  expect(db.query("SELECT unit_id FROM unit_services").all()).toEqual([{ unit_id: 2 }]);
});

// ---------- routes: auth ----------

test("routes refuse unauthenticated callers (401) and non-GET without x-cc (403) before touching the unit", async () => {
  expect((await route(deps({ authed: false }), req("GET", "/api/units/1/services")))!.status).toBe(401);
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/a.service/restart", undefined, false)))!.status).toBe(403);
  expect((await route(deps(), req("PUT", "/api/units/1/services/allow", { items: [] }, false)))!.status).toBe(403);
  expect(calls).toEqual([]);
});

test("paths that are not service routes fall through (null) so index.ts keeps its own 404", async () => {
  expect(await route(deps(), req("GET", "/api/units/1"))).toBeNull();
  expect(await route(deps(), req("GET", "/api/units/1/metrics"))).toBeNull();
});

test("unknown unit is 404 and an unknown kind is 400", async () => {
  expect((await route(deps(), req("GET", "/api/units/99/services")))!.status).toBe(404);
  expect((await route(deps(), req("POST", "/api/units/1/services/tmux/x/start", undefined)))!.status).toBe(400);
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/x/reload", undefined)))!.status).toBe(400);
});

// ---------- routes: list / discover / allowlist ----------

test("GET services: 409 'unit offline' when the unit is not online; no SSH attempted", async () => {
  db.query("UPDATE units SET last_seen=NULL WHERE id=1").run();
  const r = (await route(deps(), req("GET", "/api/units/1/services")))!;
  expect(r.status).toBe(409);
  expect(await r.json()).toEqual({ error: "unit offline", needs_sync: false });
  expect(calls).toEqual([]);
});

test("GET services returns the agent's items; an agent error comes back as 200 with items [] and error", async () => {
  reply = (cmd) => cmd === LIST_CMD ? JSON.stringify({ ok: true, data: { items: [{ kind: "systemd", name: "a.service", state: "active", detail: "running" }] } }) : "";
  let body: any = await (await route(deps(), req("GET", "/api/units/1/services")))!.json();
  expect(body).toEqual({ items: [{ kind: "systemd", name: "a.service", state: "active", detail: "running" }], needs_sync: false });
  reply = () => new Error("exit 3: svc helper missing");
  const r = (await route(deps(), req("GET", "/api/units/1/services")))!;
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ items: [], error: "svc helper missing", needs_sync: false });
});

test("GET services/discover returns {items:[{kind,name,state}]}; agent failure is 502", async () => {
  reply = () => JSON.stringify({ ok: true, data: { items: [{ kind: "docker", name: "web", state: "running" }] } });
  expect(await (await route(deps(), req("GET", "/api/units/1/services/discover")))!.json()).toEqual({ items: [{ kind: "docker", name: "web", state: "running" }] });
  expect(calls[0].cmd).toBe("svc-discover");
  reply = () => new Error("exit 3: nope");
  expect((await route(deps(), req("GET", "/api/units/1/services/discover")))!.status).toBe(502);
});

test("PUT allow: replaces the stored set, pushes it on stdin via svc-allow, audits svc.allow", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','old.service')").run();
  const body = { items: [{ kind: "systemd", name: "nginx.service" }, { kind: "lxc", name: "101" }] };
  const r = (await route(deps(), req("PUT", "/api/units/1/services/allow", body)))!;
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true, items: body.items, needs_sync: false });
  expect(allowRows()).toEqual([{ kind: "lxc", name: "101" }, { kind: "systemd", name: "nginx.service" }]);
  expect(calls).toHaveLength(1);
  expect(calls[0].cmd).toBe("svc-allow");
  expect(JSON.parse(calls[0].stdin!)).toEqual({ items: body.items });
  expect(auditRows().at(-1)).toMatchObject({ action: "svc.allow", unit_id: 1 });
});

test("PUT allow: invalid body is 400 and the stored set is unchanged", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','old.service')").run();
  for (const b of [{ items: [{ kind: "systemd", name: "a;b" }] }, { items: "x" }, {}]) {
    expect((await route(deps(), req("PUT", "/api/units/1/services/allow", b)))!.status).toBe(400);
  }
  expect(allowRows()).toEqual([{ kind: "systemd", name: "old.service" }]);
  expect(calls).toEqual([]);
});

test("PUT allow: push failure is 502, the DB set is still kept, audited svc.allow.failed", async () => {
  reply = () => new Error("exit 3: svc helper missing");
  const r = (await route(deps(), req("PUT", "/api/units/1/services/allow", { items: [{ kind: "systemd", name: "a.service" }] })))!;
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ error: "svc helper missing", items: [{ kind: "systemd", name: "a.service" }] });
  expect(allowRows()).toEqual([{ kind: "systemd", name: "a.service" }]);
  expect(auditRows().at(-1)).toMatchObject({ action: "svc.allow.failed", unit_id: 1 });
});

test("PUT allow while the unit is offline: saved unsynced, not pushed, 502", async () => {
  db.query("UPDATE units SET last_seen=NULL WHERE id=1").run();
  const r = (await route(deps(), req("PUT", "/api/units/1/services/allow", { items: [{ kind: "systemd", name: "a.service" }] })))!;
  expect(r.status).toBe(502);
  expect(calls).toEqual([]);
  expect(allowRows()).toEqual([{ kind: "systemd", name: "a.service" }]);
  expect(db.query("SELECT synced FROM unit_services WHERE unit_id=1").get()).toEqual({ synced: 0 });
});

test("reconcile pushes the stored allowlist and clears the drift flag", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name,synced) VALUES(1,'systemd','a.service',0)").run();
  const r = (await route(deps(), req("POST", "/api/units/1/services/reconcile")))!;
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ ok: true, needs_sync: false });
  expect(calls[0].cmd).toBe("svc-allow");
  expect(JSON.parse(calls[0].stdin!)).toEqual({ items: [{ kind: "systemd", name: "a.service" }] });
  expect(db.query("SELECT synced FROM unit_services WHERE unit_id=1").get()).toEqual({ synced: 1 });
  expect(auditRows().at(-1)).toMatchObject({ action: "svc.allow.reconciled", unit_id: 1 });
});

test("reconcile reports failure and keeps the drift flag when the agent rejects it", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name,synced) VALUES(1,'systemd','a.service',0)").run();
  reply = () => new Error("exit 3: helper busy");
  const r = (await route(deps(), req("POST", "/api/units/1/services/reconcile")))!;
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ needs_sync: true });
  expect(db.query("SELECT synced FROM unit_services WHERE unit_id=1").get()).toEqual({ synced: 0 });
});

test("GET allow reads the stored set from the DB (no SSH)", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'docker','web'),(1,'systemd','a.service')").run();
  expect(await (await route(deps(), req("GET", "/api/units/1/services/allow")))!.json()).toEqual({ items: [{ kind: "docker", name: "web" }, { kind: "systemd", name: "a.service" }] });
  expect(calls).toEqual([]);
});

// ---------- routes: actions ----------

test("POST action: runs svc-act with the validated parts, audits svc.<action> with detail kind:name", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','sshd@2.service')").run();
  const r = (await route(deps(), req("POST", "/api/units/1/services/systemd/sshd%402.service/restart", undefined)))!;
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true });
  expect(calls[0].cmd).toBe("svc-act systemd sshd@2.service restart");
  expect(calls[0].timeoutMs).toBeGreaterThanOrEqual(30000);
  expect(auditRows().at(-1)).toEqual({ action: "svc.restart", unit_id: 1, detail: "systemd:sshd@2.service" });
});

test("POST action: NO confirm flag is required", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'docker','web')").run();
  const r = (await route(deps(), req("POST", "/api/units/1/services/docker/web/stop", {})))!;
  expect(r.status).toBe(200);
});

test("POST action on a name not on the allowlist is 403 and never reaches the unit", async () => {
  const r = (await route(deps(), req("POST", "/api/units/1/services/systemd/a.service/start", undefined)))!;
  expect(r.status).toBe(403);
  expect(calls).toEqual([]);
});

test("POST action: encoded slashes and invalid names are rejected (400)", async () => {
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/a%2Fb/start", undefined)))!.status).toBe(400);
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/a%20b/start", undefined)))!.status).toBe(400);
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/%E0%A4%A/start", undefined)))!.status).toBe(400);
  expect(calls).toEqual([]);
});

test("POST action on an offline unit is 409", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','a.service')").run();
  db.query("UPDATE units SET last_seen=NULL WHERE id=1").run();
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/a.service/start", undefined)))!.status).toBe(409);
  expect(calls).toEqual([]);
});

test("POST action failure is 502 and audited svc.<action>.failed", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'lxc','101')").run();
  reply = () => new Error("exit 3: Unit not loaded");
  const r = (await route(deps(), req("POST", "/api/units/1/services/lxc/101/stop", undefined)))!;
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ error: "Unit not loaded" });
  expect(auditRows().at(-1)).toEqual({ action: "svc.stop.failed", unit_id: 1, detail: "lxc:101: Unit not loaded" });
});

test("POST with a non-GET method on a logs path is 405", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','a.service')").run();
  expect((await route(deps(), req("POST", "/api/units/1/services/systemd/a.service/logs", undefined)))!.status).toBe(405);
});

// ---------- routes: logs ----------

test("GET logs: clamps n, passes svc-logs, returns lines newest first from the agent", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','a.service')").run();
  reply = () => JSON.stringify({ ok: true, data: { lines: [{ ts: 2, level: "info", msg: "b" }, { ts: 1, level: "error", msg: "a" }] } });
  const r = (await route(deps(), req("GET", "/api/units/1/services/systemd/a.service/logs?n=9999")))!;
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ lines: [{ ts: 2, level: "info", msg: "b" }, { ts: 1, level: "error", msg: "a" }] });
  expect(calls[0].cmd).toBe("svc-logs systemd a.service 500");
});

test("GET logs defaults n to 200; not-allowlisted is 403; offline is 409; agent failure is 502", async () => {
  db.query("INSERT INTO unit_services(unit_id,kind,name) VALUES(1,'systemd','a.service')").run();
  reply = () => JSON.stringify({ ok: true, data: { lines: [] } });
  await route(deps(), req("GET", "/api/units/1/services/systemd/a.service/logs"));
  expect(calls[0].cmd).toBe("svc-logs systemd a.service 200");
  expect((await route(deps(), req("GET", "/api/units/1/services/systemd/other.service/logs")))!.status).toBe(403);
  db.query("UPDATE units SET last_seen=NULL WHERE id=1").run();
  expect((await route(deps(), req("GET", "/api/units/1/services/systemd/a.service/logs")))!.status).toBe(409);
  db.query("UPDATE units SET last_seen=? WHERE id=1").run(NOW);
  reply = () => new Error("exit 3: boom");
  expect((await route(deps(), req("GET", "/api/units/1/services/systemd/a.service/logs")))!.status).toBe(502);
});

test("GET logs with a bad name is 400 before anything is sent", async () => {
  expect((await route(deps(), req("GET", "/api/units/1/services/lxc/abc/logs")))!.status).toBe(400);
  expect(calls).toEqual([]);
});
