import { test, expect } from "bun:test";
import { openDb } from "./db";
import { encrypt } from "./crypto";
import { Scheduler, type UnitRow } from "./poller";

const unit = (db: ReturnType<typeof openDb>) => {
  db.query("INSERT INTO units(id,name,host,ssh_port,ssh_user,pubkey,privkey_enc,created_at,sample_interval_s) VALUES(1,'u','127.0.0.1',62478,'x','p',?,0,5)").run(encrypt("m", "dummy-private-key"));
  return db.query("SELECT * FROM units WHERE id=1").get() as UnitRow;
};
const never = <T,>() => new Promise<T>(() => {});
const fakePool = (exec: () => Promise<string>) => {
  const drops: number[] = [];
  return { drops, pool: { exec, drop: (id: number) => { drops.push(id); }, hostKey: () => undefined } as any };
};
const err = (db: ReturnType<typeof openDb>) => (db.query("SELECT last_error FROM units WHERE id=1").get() as any).last_error as string | null;

test("a poll that never settles cannot wedge a unit: run() returns, the slot is freed, the next tick tries again", async () => {
  const db = openDb(":memory:"), u = unit(db);
  const { drops, pool } = fakePool(() => never());
  const sched = new Scheduler(db, pool, "m", () => 5, () => {}, { pollTimeoutMs: 50 });

  const t0 = Date.now();
  await sched.run(u);
  expect(Date.now() - t0).toBeLessThan(2000);          // returned instead of hanging on the dead promise
  expect(drops).toEqual([1]);                           // dropped so the next attempt opens a fresh connection
  expect(err(db)).toMatch(/watchdog/i);                 // and the UI/poller can say why

  await sched.run(u);
  expect(drops).toEqual([1, 1]);                         // still polling; a second real attempt happened
});

test("a hung static refresh does not wedge the unit either", async () => {
  const db = openDb(":memory:"), u = unit(db);
  const { drops, pool } = fakePool(() => never());
  const sched = new Scheduler(db, pool, "m", () => 5, () => {}, { pollTimeoutMs: 50 });

  const t0 = Date.now();
  await sched.run(u);
  expect(Date.now() - t0).toBeLessThan(2000);
  expect(drops).toEqual([1]);
});

test("a static refresh failure is recorded in last_error instead of failing silently", async () => {
  const db = openDb(":memory:"), u = unit(db);
  const { pool } = fakePool(async () => { throw new Error("connect ECONNREFUSED 192.0.2.10:62478"); });
  const sched = new Scheduler(db, pool, "m", () => 5, () => {}, { pollTimeoutMs: 50 });

  await sched.run(u);
  expect(err(db)).toContain("ECONNREFUSED");
});
