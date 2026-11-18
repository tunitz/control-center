import { test, expect, beforeEach } from "bun:test";
import { openDb } from "./db";
import { updateUnit } from "./units";

let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(":memory:");
  db.query("INSERT INTO units(id,name,host,ssh_port,pubkey,privkey_enc,mac,broadcast,last_seen,last_error,created_at) VALUES(1,'a','10.0.0.5',62478,'pk','sk','aa:bb:cc:dd:ee:01','255.255.255.255',123,'old error',0)").run();
});
const get = () => db.query("SELECT * FROM units WHERE id=1").get() as any;

test("changes host, port, MAC and broadcast; normalises MAC", () => {
  const r = updateUnit(db, 1, { host: "192.168.1.9", ssh_port: 2222, mac: "AA-BB-CC-DD-EE-02", broadcast: "192.168.1.255" });
  expect(r.ok).toBe(true);
  expect(get()).toMatchObject({ host: "192.168.1.9", ssh_port: 2222, mac: "aa:bb:cc:dd:ee:02", broadcast: "192.168.1.255" });
});
test("host change resets stale state so the unit is re-polled cleanly", () => {
  const r = updateUnit(db, 1, { host: "10.9.9.9" });
  expect(r.ok && r.hostChanged).toBe(true);
  expect(get().last_error).toBeNull();
  const r2 = updateUnit(db, 1, { name: "renamed" }); expect(r2.ok && r2.hostChanged).toBe(false);
});
test("empty MAC clears it; omitted fields are left alone", () => {
  updateUnit(db, 1, { mac: "" });
  expect(get().mac).toBeNull();
  expect(get().host).toBe("10.0.0.5");
});
test("rejects bad input and changes nothing", () => {
  for (const bad of [{ mac: "nonsense" }, { host: "" }, { host: "a b; rm -rf /" }, { ssh_port: 0 }, { ssh_port: 70000 }, { broadcast: "x" }]) {
    const r = updateUnit(db, 1, bad as any);
    expect(r.ok).toBe(false);
  }
  expect(get()).toMatchObject({ host: "10.0.0.5", mac: "aa:bb:cc:dd:ee:01", ssh_port: 62478 });
});
test("unknown unit", () => { expect(updateUnit(db, 99, { name: "x" }).ok).toBe(false); });
