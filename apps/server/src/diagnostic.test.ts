import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { encrypt } from "./crypto";
import { diagnose, handleDiagnosticRoute, type DiagnosticDeps } from "./diagnostic";

const NOW = 1_800_000_000;
let db: ReturnType<typeof openDb>;
let drops: number[];
let probeReply: (cmd: string) => string | Error;
const pool = {
  drop: (id: number) => { drops.push(id); },
  exec: async (_id: number, _t: any, cmd: string) => {
    const r = probeReply(cmd);
    if (r instanceof Error) throw r;
    return r;
  },
};
const deps = (): DiagnosticDeps => ({ db, pool: pool as any, master: "m", now: NOW, pollInterval: 5, authed: true });
const req = (method: string, path: string, cc = true) => new Request("http://cc.test" + path, {
  method, headers: { ...(cc ? { "x-cc": "1" } : {}) },
});
const route = (d: DiagnosticDeps, r: Request) => handleDiagnosticRoute(d, r, new URL(r.url).pathname, "1.2.3.4");
beforeEach(() => { drops = []; });

type UnitOverrides = {
  last_seen?: number; last_sample_ts?: number; host_fingerprint?: string | null;
  sample_interval_s?: number; migration_pending_port?: number | null;
};
const addUnit = (over: UnitOverrides = {}) => {
  db.query(`INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at,last_seen,last_sample_ts,host_fingerprint,sample_interval_s,migration_pending_port)
    VALUES(1,'u','h','pk',?,0,?,?,?,?,?)`).run(
    encrypt("m", "private"), over.last_seen ?? NOW - 2, over.last_sample_ts ?? NOW - 3,
    over.host_fingerprint ?? "SHA256:abc", over.sample_interval_s ?? 5, over.migration_pending_port ?? null);
  db.query("INSERT INTO unit_static(unit_id,json,updated_at) VALUES(1,'{}',?)").run(NOW);
};

test("healthy unit reports ok with all checks passing", () => {
  db = openDb(":memory:"); addUnit();
  const r = diagnose(db, NOW, 5, 1)!;
  expect(r.status).toBe("ok");
  expect(r.checks.map(c => c.id)).toEqual(["contact", "sample", "host_key", "static", "services", "ssh_port"]);
  expect(r.checks.every(c => c.ok)).toBe(true);
});

test("stale contact and sample escalate to error and carry fix hints", () => {
  db = openDb(":memory:"); addUnit({ last_seen: NOW - 1000, last_sample_ts: NOW - 1000 });
  const r = diagnose(db, NOW, 5, 1)!;
  expect(r.status).toBe("error");
  expect(r.checks.find(c => c.id === "contact")!.ok).toBe(false);
  expect(r.checks.find(c => c.id === "contact")!.fix).toMatch(/reinstall/i);
  expect(r.checks.find(c => c.id === "sample")!.ok).toBe(false);
});

test("pending service sync and legacy port are warnings, not errors", () => {
  db = openDb(":memory:"); addUnit({ migration_pending_port: 22 });
  db.query("INSERT INTO unit_services(unit_id,kind,name,synced) VALUES(1,'systemd','a.service',0)").run();
  const r = diagnose(db, NOW, 5, 1)!;
  expect(r.status).toBe("warn");
  expect(r.checks.find(c => c.id === "services")!.ok).toBe(false);
  expect(r.checks.find(c => c.id === "ssh_port")!.ok).toBe(false);
});

test("probe runs the agent info command and reports failure honestly", async () => {
  db = openDb(":memory:"); drops = []; addUnit();
  probeReply = () => JSON.stringify({ ok: true, data: {} });
  let r = (await route(deps(), req("POST", "/api/units/1/diagnostic/probe")))!;
  expect(r.status).toBe(200);
  expect(await r.json()).toMatchObject({ ok: true });
  probeReply = () => new Error("connect ECONNREFUSED");
  r = (await route(deps(), req("POST", "/api/units/1/diagnostic/probe")))!;
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ ok: false });
});

test("reconnect drops the pool connection, clears last_error and is audited", async () => {
  db = openDb(":memory:"); drops = []; addUnit();
  db.query("UPDATE units SET last_error='old failure' WHERE id=1").run();
  const r = (await route(deps(), req("POST", "/api/units/1/reconnect")))!;
  expect(r.status).toBe(200);
  expect(drops).toEqual([1]);
  expect((db.query("SELECT last_error FROM units WHERE id=1").get() as any).last_error).toBeNull();
  expect(db.query("SELECT action FROM audit WHERE unit_id=1").get()).toEqual({ action: "unit.reconnect" });
});

test("diagnostic route enforces auth and csrf", async () => {
  db = openDb(":memory:"); addUnit();
  expect((await route({ ...deps(), authed: false }, req("GET", "/api/units/1/diagnostic")))!.status).toBe(401);
  expect((await route(deps(), req("POST", "/api/units/1/reconnect", false)))!.status).toBe(403);
  expect(drops).toEqual([]);
});
