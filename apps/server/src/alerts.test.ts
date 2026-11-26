import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { evaluateAlerts, inWindow, handleAlertRoute, type AlertDeps } from "./alerts";

const NOW = 1_800_000_000; // check weekday/minute in tests via localTime indirectly
let db: ReturnType<typeof openDb>;
const deps = (): AlertDeps => ({ db, now: NOW, pollInterval: 5, authed: true });
const req = (method: string, path: string, body?: unknown) => new Request("http://cc.test" + path, {
  method, headers: { "x-cc": "1", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const route = (d: AlertDeps, r: Request) => handleAlertRoute(d, r, new URL(r.url).pathname, "1.2.3.4");
const addUnit = (lastSeen = NOW - 2, lastSample = NOW - 3) => {
  db.query("INSERT INTO units(id,name,host,pubkey,privkey_enc,created_at,last_seen,last_sample_ts,sample_interval_s) VALUES(1,'u','h','pk','sk',0,?,?,5)").run(lastSeen, lastSample);
};
const activeKinds = () => (db.query("SELECT kind FROM alert_state ORDER BY kind").all() as { kind: string }[]).map(r => r.kind);

beforeEach(() => {
  db = openDb(":memory:");
  addUnit();
});

test("offline and stale alerts fire and clear when the unit recovers", () => {
  // Offline suppresses the stale alert to avoid double-reporting the same outage.
  db.query("UPDATE units SET last_seen=?,last_sample_ts=? WHERE id=1").run(NOW - 1000, NOW - 1000);
  expect(evaluateAlerts(db, NOW, 5)).toBe(1);
  expect(activeKinds()).toEqual(["offline"]);
  // Contact returns but telemetry is still old: stale fires on its own.
  db.query("UPDATE units SET last_seen=?,last_sample_ts=? WHERE id=1").run(NOW - 2, NOW - 1000);
  expect(evaluateAlerts(db, NOW, 5)).toBe(1);
  expect(activeKinds()).toEqual(["stale"]);
  db.query("UPDATE units SET last_seen=?,last_sample_ts=? WHERE id=1").run(NOW - 2, NOW - 3);
  expect(evaluateAlerts(db, NOW, 5)).toBe(0);
  expect(activeKinds()).toEqual([]);
});

test("disk alerts are opt-in and use the configured threshold", () => {
  db.query("INSERT INTO unit_disks(unit_id,ts,json) VALUES(1,?,?)").run(NOW, JSON.stringify([{ mount: "/", fs: "ext4", total_mb: 100, used_mb: 85 }]));
  evaluateAlerts(db, NOW, 5);
  expect(activeKinds()).not.toContain("disk");
  db.query("INSERT INTO alert_rules(unit_id,kind,enabled,threshold) VALUES(1,'disk',1,80)").run();
  expect(evaluateAlerts(db, NOW, 5)).toBe(1);
  expect((db.query("SELECT message FROM alert_state WHERE kind='disk'").get() as any).message).toMatch(/above 80%/);
});

test("maintenance windows suppress alerts, including a window spanning midnight and custom timezone", () => {
  const weekday = new Date(Math.floor(NOW / 86400) * 86400 * 1000).getUTCDay();
  const minute = Math.floor((NOW % 86400) / 60);
  // A wrapping window that includes this minute: start just before, end just after midnight.
  const start = minute > 60 ? minute - 60 : 1380;
  const end = minute > 60 ? 0 : 60;
  db.query("INSERT INTO maintenance_windows(unit_id,days,start_minute,end_minute,enabled) VALUES(?,?,?,?,1)").run(null, String(weekday), start, end);
  expect(inWindow({ days: String(weekday), start_minute: start, end_minute: end }, NOW)).toBe(true);
  db.query("UPDATE units SET last_seen=? WHERE id=1").run(NOW - 1000);
  expect(evaluateAlerts(db, NOW, 5)).toBe(0);
  expect(activeKinds()).toEqual([]);

  // With Asia/Manila (+08:00), local time shifts by 8 hours.
  db.query("INSERT INTO settings(key,value) VALUES('timezone','Asia/Manila') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  const t = NOW + 8 * 3600;
  const mDay = new Date(Math.floor(t / 86400) * 86400 * 1000).getUTCDay();
  const mMin = Math.floor((t % 86400) / 60);
  db.query("DELETE FROM maintenance_windows").run();
  db.query("INSERT INTO maintenance_windows(unit_id,days,start_minute,end_minute,enabled) VALUES(?,?,?,?,1)").run(null, String(mDay), mMin - 10, mMin + 10);
  expect(evaluateAlerts(db, NOW, 5)).toBe(0);
});

test("alert routes validate input and expose active state", async () => {
  let r = (await route(deps(), req("PUT", "/api/alerts/1/disk", { enabled: true, threshold: 95 })))!;
  expect(r.status).toBe(200);
  expect(db.query("SELECT threshold FROM alert_rules WHERE kind='disk'").get()).toEqual({ threshold: 95 });
  r = (await route(deps(), req("PUT", "/api/alerts/1/disk", { threshold: 101 })))!;
  expect(r.status).toBe(400);
  r = (await route(deps(), req("POST", "/api/alerts/maintenance", { days: "0,9", start_minute: 0, end_minute: 60 })))!;
  expect(r.status).toBe(400);
  r = (await route(deps(), req("POST", "/api/alerts/maintenance", { days: "0", start_minute: 60, end_minute: 120 })))!;
  expect(r.status).toBe(200);
  expect((await (await route(deps(), req("GET", "/api/alerts")))!.json()).windows).toHaveLength(1);
});
