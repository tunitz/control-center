import { test, expect, beforeAll, afterAll } from "bun:test";
import { Server, utils } from "ssh2";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db";
import { generateUnitKey, encrypt, decrypt } from "./crypto";
import { SshPool } from "./ssh";
import { pollUnit, parseRead, type UnitRow } from "./poller";

const GATE = join(import.meta.dir, "../../../agent/ccagent-gate");
const dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ccssh-"));
const conf = join(dir, "conf"); writeFileSync(conf, `DIR=${dir}\n`);
const hostKey = utils.generateKeyPairSync("ed25519").private;
const unitKey = generateUnitKey("t");
const allowed = utils.parseKey(unitKey.publicKey) as any;
let server: Server, port = 0, failAck = false;

beforeAll(async () => {
  server = new Server({ hostKeys: [hostKey] }, client => {
    client.on("authentication", ctx => {
      if (ctx.method === "publickey" && ctx.key.algo === allowed.type && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0) return ctx.accept();
      ctx.reject();
    });
    client.on("ready", () => client.on("session", acc => acc().on("exec", (accept, _r, info) => {
      const stream = accept();
      if (failAck && info.command.startsWith("ack")) { stream.stderr.write("boom"); stream.exit(1); return stream.end(); }
      // emulate sshd forced command: command arrives in SSH_ORIGINAL_COMMAND
      const p = spawn("bash", [GATE], { env: { ...process.env, CCAGENT_CONF: conf, SSH_ORIGINAL_COMMAND: info.command } });
      p.stdout.on("data", d => stream.write(d)); p.stderr.on("data", d => stream.stderr.write(d));
      p.on("close", code => { stream.exit(code ?? 0); stream.end(); });
    })));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", () => { port = (server.address() as any).port; r(); }));
});
afterAll(() => server.close());

const sample = (ts: number) => JSON.stringify({ v: 1, ts, cpu_pct: 1, cpu_w: 10 }) + "\n";
const mkUnit = (db: ReturnType<typeof openDb>): UnitRow => {
  db.query("INSERT INTO units(id,name,host,ssh_port,ssh_user,pubkey,privkey_enc,created_at) VALUES(1,'u','127.0.0.1',?,'x','p',?,0)").run(port, encrypt("m", unitKey.privateKey));
  return db.query("SELECT * FROM units WHERE id=1").get() as UnitRow;
};

test("generated unit keys are always loadable by ssh2", () => {
  for (const c of ["cc-a", "cc-paste-unit", "cc-a-very-long-unit-name-here"]) {
    const k = generateUnitKey(c);
    const round = decrypt("m", encrypt("m", k.privateKey));
    expect(round).toBe(k.privateKey);
    expect(utils.parseKey(round)).not.toBeInstanceOf(Error);
  }
});

test("crypto roundtrip", () => { expect(decrypt("m", encrypt("m", "secret"))).toBe("secret"); expect(() => decrypt("x", encrypt("m", "s"))).toThrow(); });

test("parseRead groups files", () => {
  expect(parseRead("#F a\n{1}\n{2}\n#F b\n{3}\n#END\n")).toEqual([{ name: "a", lines: ["{1}", "{2}"] }, { name: "b", lines: ["{3}"] }]);
});

test("poll reads, ingests, acks and deletes; crash before ack loses nothing, no duplicates", async () => {
  const db = openDb(":memory:"), u = mkUnit(db), pool = new SshPool();
  writeFileSync(join(dir, "metrics.jsonl"), sample(1000) + sample(1005));
  expect(await pollUnit(db, pool, u, "m", 2000)).toBe(2);
  expect(readdirSync(dir).filter(f => f.endsWith(".reading"))).toEqual([]);

  failAck = true;
  writeFileSync(join(dir, "metrics.jsonl"), sample(1010));
  await expect(pollUnit(db, pool, u, "m", 2001)).rejects.toThrow();
  expect(readdirSync(dir).filter(f => f.endsWith(".reading")).length).toBe(1); // kept for retry
  failAck = false;
  writeFileSync(join(dir, "metrics.jsonl"), sample(1015));
  expect(await pollUnit(db, pool, u, "m", 2002)).toBe(1); // 1010 re-read but deduped; only 1015 is new
  expect(readdirSync(dir).filter(f => f.endsWith(".reading"))).toEqual([]);
  expect((db.query("SELECT COUNT(*) c FROM samples_raw").get() as any).c).toBe(4);
  pool.closeAll();
});

test("gate rejects anything but the allowlist", async () => {
  const db = openDb(":memory:"), u = mkUnit(db), pool = new SshPool();
  await expect(pool.exec(1, { host: "127.0.0.1", port, username: "x", privateKey: unitKey.privateKey }, "cat /etc/passwd")).rejects.toThrow(/denied/);
  pool.closeAll();
});

test("wrong key is refused", async () => {
  const pool = new SshPool(3000), other = generateUnitKey("o");
  await expect(pool.exec(9, { host: "127.0.0.1", port, username: "x", privateKey: other.privateKey }, "read")).rejects.toThrow();
  pool.closeAll();
});

test("a peer that accepts TCP and never speaks (host rebooted/suspended) rejects inside readyTimeout instead of hanging", async () => {
  const net = await import("node:net");
  const held: any[] = [];
  const silent = net.createServer(so => { held.push(so); /* accept, never speak */ });
  await new Promise<void>(r => silent.listen(0, "127.0.0.1", () => r()));
  const silentPort = (silent.address() as any).port;
  const pool = new SshPool(1500); // readyTimeout
  const t0 = Date.now();
  await expect(pool.exec(42, { host: "127.0.0.1", port: silentPort, username: "x", privateKey: unitKey.privateKey }, "read")).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(1500 + 3000);
  pool.closeAll();
  for (const so of held) so.destroy();
  await new Promise<void>(r => silent.close(() => r()));
});

test("a peer that drops the connection during the handshake reports \"Connection lost before handshake\" instead of wedging the caller", async () => {
  const net = await import("node:net");
  const held: any[] = [];
  const dropper = net.createServer(so => { held.push(so); so.end(); });
  await new Promise<void>(r => dropper.listen(0, "127.0.0.1", () => r()));
  const dropPort = (dropper.address() as any).port;
  const pool = new SshPool(2000);
  const t0 = Date.now();
  await expect(pool.exec(7, { host: "127.0.0.1", port: dropPort, username: "x", privateKey: unitKey.privateKey }, "read")).rejects.toThrow();
  expect(Date.now() - t0).toBeLessThan(2000 + 3000);
  pool.closeAll();
  for (const so of held) so.destroy();
  await new Promise<void>(r => dropper.close(() => r()));
});

test("generateUnitKey retries past ssh2's occasional unloadable key (~1 in 250) and never throws or returns a bad one", () => {
  let bad = 0;
  for (let i = 0; i < 1500; i++) {
    const k = generateUnitKey("cc-retry-test");
    if (utils.parseKey(k.privateKey) instanceof Error) bad++;
  }
  expect(bad).toBe(0);
});
