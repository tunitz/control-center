import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agent-side tests for service control: the forced-command gate (svc-* verbs) and the root
// helper (ccagent-svc). Nothing real is run: systemctl/docker/pct/journalctl are fake scripts in a
// temp dir, selected through CCAGENT_* env vars.
//
// Exit codes: gate 2 = denied before anything is queued; gate 3 = helper error / timeout / missing helper;
// gate 0 = ok. The helper prints nothing to the gate's stdout; the gate prints the result JSON.

const AGENT = join(import.meta.dir, "../../../agent");
const GATE = join(AGENT, "ccagent-gate");
const HELPER = join(AGENT, "ccagent-svc");
const PATHENV = "/usr/bin:/bin";

let dir: string, bin: string, calls: string, allow: string, unitFile: string, conf: string, req: string, resultsDir: string;

const fakeCmd = (name: string, body: string) => {
  const p = join(bin, name);
  writeFileSync(p, `#!/bin/sh\necho "${name} $*" >> ${calls}\n${body}\n`);
  chmodSync(p, 0o755);
};
const fixture = (key: string, text: string) => {
  const p = join(dir, `fix-${key}`);
  writeFileSync(p, text);
  return p;
};
const callLog = () => (existsSync(calls) ? readFileSync(calls, "utf8") : "");
const helperEnv = () => ({
  PATH: PATHENV,
  CCAGENT_DIR: dir,
  CCAGENT_SERVICES: allow,
  CCAGENT_SYSTEMCTL: join(bin, "systemctl"),
  CCAGENT_DOCKER: join(bin, "docker"),
  CCAGENT_PCT: join(bin, "pct"),
  CCAGENT_JOURNALCTL: join(bin, "journalctl"),
  CCAGENT_DOCKER_LOGS: "1",
  CCAGENT_LOGINCTL: join(bin, "loginctl"),
  CCAGENT_RUNUSER: join(bin, "runuser"),
  CCAGENT_RUNDIR: join(dir, "run"),
  RESULTS_DIR: resultsDir,
});

const gateEnv = (cmd: string) => ({ PATH: PATHENV, CCAGENT_CONF: conf, CCAGENT_SVC_WAIT: "3", CCAGENT_RESULTS: resultsDir, SSH_ORIGINAL_COMMAND: cmd });


/** Gate alone, synchronously: for inputs the gate must reject before queueing, or for the timeout/missing cases. */
const gateSync = (cmd: string, stdin?: Buffer) =>
  Bun.spawnSync(["bash", GATE], { env: gateEnv(cmd), stdin: stdin ?? Buffer.alloc(0) });

/** Gate + helper: the gate queues its request, the path unit would start the helper; we start it directly. */
async function viaHelper(cmd: string, stdin?: Buffer) {
  const p = Bun.spawn(["bash", GATE], { env: gateEnv(cmd), stdin: stdin ?? "ignore", stdout: "pipe", stderr: "pipe" });
  for (let i = 0; i < 300 && !existsSync(req); i++) await Bun.sleep(10);
  Bun.spawnSync(["python3", HELPER], { env: helperEnv() });
  const code = await p.exited;
  return { code, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text() };
}
/** Writes a request exactly as the gate does (header line = JSON, optional raw body after it) and runs the helper once. */
const helperRun = (header: Record<string, unknown>, body = "", ageS = 0) => {
  if (typeof header.id === "string" && header.id.length < 32) header = { ...header, id: header.id.padEnd(32, "0") };
  writeFileSync(req, JSON.stringify({ ts: Math.floor(Date.now() / 1000) - ageS, ...header }) + "\n" + body);
  if (ageS) { const t = Date.now() / 1000 - ageS; utimesSync(req, t, t); }
  Bun.spawnSync(["python3", HELPER], { env: helperEnv() });
};
const result = (id: string) => {
  const f = join(resultsDir, `svc.result.${id.padEnd(32, "0")}`);
  return existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null;
};
const SYSTEMCTL_LIST = [
  "nginx.service loaded active running Nginx web server",
  "ccagent.service loaded active running agent",
  "sshd.service loaded active running OpenSSH",
  "bad.service loaded failed failed Broken thing",
  "other.service loaded active running not allowlisted",
].join("\n") + "\n";
const DOCKER_PS = [
  '{"Names":"web","State":"running","Status":"Up 2 hours","Image":"nginx"}',
  '{"Names":"db","State":"exited","Status":"Exited (0)","Image":"postgres"}',
].join("\n") + "\n";
const PCT_LIST = "VMID       Status     Lock         Name\n101        running                 jellyfin\n102        stopped                 backup\n";
const JOURNAL = [
  JSON.stringify({ __REALTIME_TIMESTAMP: "1700000000000000", PRIORITY: "6", MESSAGE: "started nginx" }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1700000001000000", PRIORITY: "3", MESSAGE: [...Buffer.from("café broke")] }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1700000002000000", PRIORITY: "4", MESSAGE: "disk nearly full" }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1700000003000000", PRIORITY: "7", MESSAGE: "debug chatter" }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1700000004000000", MESSAGE: "no priority" }),
  JSON.stringify({ __REALTIME_TIMESTAMP: "1700000005000000", PRIORITY: "5", MESSAGE: "x".repeat(2500) }),
].join("\n") + "\n";
// docker logs output is chronological (oldest first); the helper must return newest first.
const DOCKER_LOGS = [
  "2023-11-14T22:13:20.123456789Z \u001b[31mERROR\u001b[0m connection refused",
  "2023-11-14T22:13:21Z plain info line",
  "2023-11-14T23:13:22.5+01:00 warning: slow query",
  "2023-11-14T22:13:23.000Z panic: boom",
  "no timestamp here",
].join("\n") + "\n";

beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ccsvc-"));
  bin = join(dir, "bin"); mkdirSync(bin);
  calls = join(dir, "calls.log"); allow = join(dir, "services.json"); unitFile = join(dir, "ccagent-svc.path");
  conf = join(dir, "conf"); req = join(dir, "svc.request");
  resultsDir = join(dir, "results"); mkdirSync(resultsDir, { recursive: true });
  writeFileSync(conf, `DIR=${dir}\nSVC_UNIT=${unitFile}\n`);
  writeFileSync(unitFile, "");
  // `systemctl --user ...` (run through runuser) reads per-uid unit fixtures: user-units-<uid>.
  fakeCmd("systemctl", `if [ "$1" = --user ]; then shift; case "$1" in list-units) cat "${dir}/user-units-$(basename "$XDG_RUNTIME_DIR")" 2>/dev/null;; esac; else case "$1" in list-units) cat ${fixture("systemctl", SYSTEMCTL_LIST)};; esac; fi`);
  fakeCmd("docker", `case "$1" in ps) cat ${fixture("ps", DOCKER_PS)};; logs) cat ${fixture("dlogs", DOCKER_LOGS)};; esac`);
  fakeCmd("pct", `case "$1" in list) cat ${fixture("pct", PCT_LIST)};; exec) cat ${fixture("journal", JOURNAL)};; esac`);
  fakeCmd("journalctl", `cat ${fixture("journal2", JOURNAL)}`);
});

// ---------- gate: rejects before anything is queued ----------

test("gate denies unknown verbs with exit 2 and queues nothing", () => {
  for (const v of ["svc-restart-all", "svc", "svc-acts", "svc-act-x systemd nginx start", "power-off-now"]) expect(gateSync(v).exitCode).toBe(2);
  expect(existsSync(req)).toBe(false);
});

test("gate denies bad kind, bad name, bad action, bad vmid and bad arg counts (exit 2, nothing queued)", () => {
  const cases = [
    "svc-act foo nginx start",          // unknown kind
    "svc-act SYSTEMD nginx start",      // kind is exact-case
    "svc-act systemd nginx;id start",   // shell metachar
    "svc-act systemd ../etc/passwd start",
    "svc-act systemd * start",          // glob must not expand
    "svc-act systemd ? start",
    "svc-act systemd nginx restart-all",
    "svc-act systemd nginx",            // missing action
    "svc-act systemd nginx start extra",
    "svc-act systemd  start",           // empty name collapses the word count
    "svc-act systemd " + "a".repeat(129) + " start",
    "svc-act lxc 1x start",             // lxc name must be a vmid
    "svc-act lxc 1234567890 start",     // more than 9 digits
    "svc-act docker web.service;x start",
    "svc-logs systemd nginx abc",
    "svc-logs systemd ../x 10",
    "svc-logs systemd nginx",           // missing n
  ];
  for (const c of cases) expect([c, gateSync(c).exitCode]).toEqual([c, 2]);
  expect(existsSync(req)).toBe(false);
  expect(callLog()).toBe("");
});

test("gate accepts a 128-char name shape and rejects 129 (shape only; the helper decides on allowlist)", async () => {
  expect(gateSync("svc-act systemd " + "a".repeat(129) + " start").exitCode).toBe(2);
  const r = await viaHelper("svc-act systemd " + "a".repeat(128) + " start");
  expect(r.code).toBe(3); // queued, helper denies: not allowlisted
  expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "denied" });
  expect(callLog()).not.toContain("systemctl");
});

test("gate rejects svc-allow bodies over 64 KB (exit 2)", () => {
  const big = Buffer.from(JSON.stringify({ items: [], pad: "x".repeat(65537) }));
  expect(gateSync("svc-allow", big).exitCode).toBe(2);
  expect(existsSync(req)).toBe(false);
});

test("gate reports the helper missing when its path unit is not installed (exit 3)", () => {
  Bun.spawnSync(["rm", "-f", unitFile]);
  const r = gateSync("svc-list");
  expect(r.exitCode).toBe(3);
  expect(r.stderr.toString()).toMatch(/svc helper missing/i);
  expect(existsSync(req)).toBe(false);
});

test("gate refuses to queue while another request is pending (exit 3), leaving that request alone", () => {
  writeFileSync(req, "{}\n");
  const r = gateSync("svc-list");
  expect(r.exitCode).toBe(3);
  expect(r.stderr.toString()).toMatch(/busy/i);
  expect(readFileSync(req, "utf8")).toBe("{}\n");
});

test("gate times out waiting for the helper (exit 3) and removes its own request", () => {
  const r = gateSync("svc-list");
  expect(r.exitCode).toBe(3);
  expect(r.stderr.toString() + r.stdout.toString()).toMatch(/timeout/i);
  expect(existsSync(req)).toBe(false);
});

test("gate denies names starting with '-' (argument injection) before queueing", () => {
  const cases = ["svc-act systemd -x start", "svc-act systemd --all restart", "svc-act systemd - start", "svc-logs systemd --all 10", "svc-act docker -rf stop"];
  for (const c of cases) expect([c, gateSync(c).exitCode]).toEqual([c, 2]);
  expect(existsSync(req)).toBe(false);
  expect(callLog()).toBe("");
});

test("gate ack takes exactly one metrics.<n>.reading word and deletes readings up to it", () => {
  writeFileSync(join(dir, "metrics.5.reading"), "a\n");
  writeFileSync(join(dir, "metrics.9.reading"), "b\n");
  expect(gateSync("ack").exitCode).toBe(2);
  expect(gateSync("ack metrics.5.reading extra").exitCode).toBe(2);
  expect(gateSync("ack metrics.x.reading").exitCode).toBe(2);
  expect(gateSync("ack metrics.5.reading").exitCode).toBe(0);
  expect(readdirSync(dir).filter(f => f.endsWith(".reading"))).toEqual(["metrics.9.reading"]);
});

// ---------- helper: request handling ----------

test("helper rejects names starting with '-' even when allowlisted, and calls no tool", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "-x" }, { kind: "systemd", name: "--all" }]));
  helperRun({ id: "9a9a9a9a9a9a9a9a", verb: "act", kind: "systemd", name: "-x", action: "restart" });
  expect(result("9a9a9a9a9a9a9a9a")).toMatchObject({ ok: false, code: "bad_request" });
  helperRun({ id: "9b9b9b9b9b9b9b9b", verb: "act", kind: "systemd", name: "--all", action: "restart" });
  expect(result("9b9b9b9b9b9b9b9b")).toMatchObject({ ok: false, code: "bad_request" });
  helperRun({ id: "9c9c9c9c9c9c9c9c", verb: "logs", kind: "systemd", name: "--all", n: 5 });
  expect(result("9c9c9c9c9c9c9c9c")).toMatchObject({ ok: false, code: "bad_request" });
  expect(callLog()).toBe("");
});

test("helper ignores a request whose ts is more than 60 s in the future", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  helperRun({ id: "9d9d9d9d9d9d9d9d", verb: "act", kind: "systemd", name: "nginx.service", action: "restart" }, "", -300);
  expect(existsSync(req)).toBe(false);
  expect(result("9d9d9d9d9d9d9d9d")).toBeNull();
  expect(callLog()).toBe("");
});

test("helper accepts a request whose ts is up to 60 s ahead (clock skew allowance)", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  helperRun({ id: "9e9e9e9e9e9e9e9e", verb: "act", kind: "systemd", name: "nginx.service", action: "restart" }, "", -30);
  expect(result("9e9e9e9e9e9e9e9e")).toMatchObject({ ok: true });
  expect(callLog()).toContain("systemctl restart -- nginx.service");
});


test("helper ignores a stale request (older than 120 s), consumes it and does not act", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  helperRun({ id: "aaaaaaaaaaaaaaaa", verb: "act", kind: "systemd", name: "nginx.service", action: "restart" }, "", 600);
  expect(existsSync(req)).toBe(false);
  expect(result("aaaaaaaaaaaaaaaa")).toBeNull();
  expect(callLog()).toBe("");
});

test("helper denies unknown verbs with a result; ignores requests with a malformed id", () => {
  helperRun({ id: "bbbbbbbbbbbbbbbb", verb: "rm-rf", kind: "", name: "" });
  expect(result("bbbbbbbbbbbbbbbb")).toMatchObject({ ok: false, code: "denied" });
  helperRun({ id: "../../etc/x", verb: "list" });
  expect(existsSync(req)).toBe(false);
  expect(callLog()).toBe("");
});

test("helper re-validates kind and name itself (a compromised gate cannot inject)", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "a;b" }]));
  helperRun({ id: "cccccccccccccccc", verb: "act", kind: "systemd", name: "a;b", action: "stop" });
  expect(result("cccccccccccccccc")).toMatchObject({ ok: false, code: "bad_request" });
  helperRun({ id: "cccccccccccccc01", verb: "logs", kind: "lxc", name: "x", n: 5 });
  expect(result("cccccccccccccc01")).toMatchObject({ ok: false, code: "bad_request" });
  expect(callLog()).toBe("");
});

test("helper refuses a non-allowlisted act without calling anything", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  helperRun({ id: "dddddddddddddddd", verb: "act", kind: "systemd", name: "other.service", action: "stop" });
  expect(result("dddddddddddddddd")).toMatchObject({ ok: false, code: "denied" });
  expect(callLog()).toBe("");
});

test("helper refuses to act on ccagent* units and on sshd/ssh even when allowlisted", () => {
  const names = ["ccagent.service", "ccagent-svc.service", "sshd.service", "sshd@2.service", "ssh", "ssh.service"];
  writeFileSync(allow, JSON.stringify(names.map(name => ({ kind: "systemd", name }))));
  names.forEach((name, i) => {
    const id = `eeeeeeeeeeeeee${i.toString(16).padStart(2, "0")}`;
    helperRun({ id, verb: "act", kind: "systemd", name, action: "stop" });
    expect([name, result(id)]).toEqual([name, expect.objectContaining({ ok: false, code: "denied" })]);
  });
  expect(callLog()).toBe("");
});

test("helper refuses invalid actions and invalid allowlist shapes", () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  helperRun({ id: "ffffffffffffffff", verb: "act", kind: "systemd", name: "nginx.service", action: "reload" });
  expect(result("ffffffffffffffff")).toMatchObject({ ok: false, code: "bad_request" });
  expect(callLog()).toBe("");
});

test("gate round trip: svc-act on an allowlisted systemd unit runs exactly systemctl <action> <name>", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const r = await viaHelper("svc-act systemd nginx.service restart");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ ok: true });
  expect(callLog()).toContain("systemctl restart -- nginx.service");
  expect(existsSync(req)).toBe(false);
  expect(readdirSync(resultsDir).filter(f => f.startsWith("svc.result."))).toEqual([]); // gate deletes the result it printed
});

test("svc-act maps docker and lxc actions to the right binaries (lxc restart = reboot, stop = shutdown)", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "docker", name: "web" }, { kind: "lxc", name: "101" }]));
  expect((await viaHelper("svc-act docker web stop")).code).toBe(0);
  expect((await viaHelper("svc-act lxc 101 restart")).code).toBe(0);
  expect((await viaHelper("svc-act lxc 101 stop")).code).toBe(0);
  expect((await viaHelper("svc-act lxc 101 start")).code).toBe(0);
  expect(callLog().trim().split("\n")).toEqual(["docker stop -- web", "pct reboot 101", "pct shutdown 101", "pct start 101"]);
});

test("gate round trip: a failing action reports ok:false with the tool's message and exits 3", async () => {
  fakeCmd("systemctl", "echo 'Unit not loaded' >&2; exit 5");
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const r = await viaHelper("svc-act systemd nginx.service start");
  expect(r.code).toBe(3);
  expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "failed" });
  expect(r.out).toContain("Unit not loaded");
});

test("svc-allow stores the validated, de-duplicated allowlist via the helper", async () => {
  const payload = { items: [{ kind: "systemd", name: "nginx.service" }, { kind: "lxc", name: "101" }, { kind: "systemd", name: "nginx.service" }] };
  const r = await viaHelper("svc-allow", Buffer.from(JSON.stringify(payload)));
  expect(r.code).toBe(0);
  expect(JSON.parse(readFileSync(allow, "utf8"))).toEqual([{ kind: "systemd", name: "nginx.service" }, { kind: "lxc", name: "101" }]);
  expect(readdirSync(dir).filter(f => f.startsWith("svc.allow") || f.endsWith(".tmp"))).toEqual([]);
});

test("helper rejects an invalid allow payload and keeps the old allowlist", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const bad = [
    { items: [{ kind: "systemd", name: "a;b" }] },
    { items: [{ kind: "lxc", name: "abc" }] },
    { items: [{ kind: "tmux", name: "x" }] },
    { items: "nope" },
    { items: Array.from({ length: 201 }, (_, i) => ({ kind: "systemd", name: `s${i}.service` })) },
    { items: [{ kind: "systemd", name: "ccagent.service" }] },
  ];
  for (const b of bad) {
    const r = await viaHelper("svc-allow", Buffer.from(JSON.stringify(b)));
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "bad_request" });
  }
  expect(JSON.parse(readFileSync(allow, "utf8"))).toEqual([{ kind: "systemd", name: "nginx.service" }]);
});

test("svc-list returns state for allowlisted items only; missing ones are reported as missing", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }, { kind: "systemd", name: "gone.service" }, { kind: "docker", name: "web" }]));
  const r = await viaHelper("svc-list");
  expect(r.code).toBe(0);
  const items = JSON.parse(r.out).data.items as any[];
  expect(items.map(i => `${i.kind}:${i.name}`).sort()).toEqual(["docker:web", "systemd:gone.service", "systemd:nginx.service"]);
  expect(items.find(i => i.name === "nginx.service")).toMatchObject({ kind: "systemd", state: "active", detail: "Nginx web server" });
  expect(items.find(i => i.name === "gone.service")).toMatchObject({ state: "missing" });
  expect(items.find(i => i.name === "web")).toMatchObject({ state: "running", detail: "Up 2 hours" });
});

test("svc-list with no allowlist file returns an empty list", async () => {
  const r = await viaHelper("svc-list");
  expect(JSON.parse(r.out).data.items).toEqual([]);
});

test("svc-discover lists candidates for each kind (not allowlist-gated)", async () => {
  const r = await viaHelper("svc-discover");
  expect(r.code).toBe(0);
  const items = JSON.parse(r.out).data.items as any[];
  expect(items).toContainEqual(expect.objectContaining({ kind: "systemd", name: "nginx.service", state: "active" }));
  expect(items).toContainEqual(expect.objectContaining({ kind: "docker", name: "db", state: "exited" }));
  expect(items).toContainEqual(expect.objectContaining({ kind: "lxc", name: "101", state: "running" }));
  expect(items).toContainEqual(expect.objectContaining({ kind: "lxc", name: "102", state: "stopped" }));
  expect(items.length).toBe(5 + 2 + 2);
  expect(items.every(i => Object.keys(i).sort().join() === "detail,kind,name,state")).toBe(true);
});

test("svc-discover caps each kind at 500 and returns [] for a missing tool", async () => {
  fakeCmd("systemctl", `case "$1" in list-units) cat ${fixture("big", Array.from({ length: 600 }, (_, i) => `svc${i}.service loaded active running x`).join("\n"))};; esac`);
  Bun.spawnSync(["rm", "-f", join(bin, "docker")]);
  const items = JSON.parse((await viaHelper("svc-discover")).out).data.items as any[];
  expect(items.filter(i => i.kind === "systemd").length).toBe(500);
  expect(items.filter(i => i.kind === "docker")).toEqual([]);
  expect(items.filter(i => i.kind === "lxc").length).toBe(2);
});

// ---------- helper: log parsing ----------

test("svc-logs systemd: newest first, ts in ms, byte-array MESSAGE decoded, PRIORITY mapped, msg truncated to 2000", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const r = await viaHelper("svc-logs systemd nginx.service 50");
  expect(r.code).toBe(0);
  const lines = JSON.parse(r.out).data.lines as { ts: number; level: string; msg: string }[];
  expect(lines.map(l => l.msg.slice(0, 12))).toEqual(["xxxxxxxxxxxx", "no priority", "debug chatte", "disk nearly ", "café broke", "started ngin"]);
  expect(lines.map(l => l.level)).toEqual(["info", "info", "debug", "warn", "error", "info"]);
  expect(lines[0].msg.length).toBe(2000);
  expect(lines[4]).toEqual({ ts: 1700000001000, level: "error", msg: "café broke" });
  expect(lines[5].ts).toBe(1700000000000);
  expect(callLog()).toContain("journalctl -u nginx.service -n 50 -o json --no-pager");
});

test("svc-logs clamps n to 1..500", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  await viaHelper("svc-logs systemd nginx.service 0");
  await viaHelper("svc-logs systemd nginx.service 999999");
  const log = callLog();
  expect(log).toContain("-n 1 -o json");
  expect(log).toContain("-n 500 -o json");
});

test("svc-logs docker: RFC3339 timestamps (ns, offsets), keyword levels, ANSI stripped, newest first, untimed lines kept", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "docker", name: "web" }]));
  const r = await viaHelper("svc-logs docker web 10");
  expect(r.code).toBe(0);
  const lines = JSON.parse(r.out).data.lines as { ts: number; level: string; msg: string }[];
  expect(lines.map(l => l.msg)).toEqual(["no timestamp here", "panic: boom", "warning: slow query", "plain info line", "ERROR connection refused"]);
  expect(lines.map(l => l.level)).toEqual(["info", "error", "warn", "info", "error"]);
  expect(lines[1].ts).toBe(Date.UTC(2023, 10, 14, 22, 13, 23));
  expect(lines[2].ts).toBe(Date.UTC(2023, 10, 14, 22, 13, 22, 500)); // 23:13:22.5+01:00
  expect(lines[3].ts).toBe(Date.UTC(2023, 10, 14, 22, 13, 21));
  expect(lines[4].ts).toBe(Date.UTC(2023, 10, 14, 22, 13, 20, 123)); // ns truncated to ms
  expect(lines[0].ts).toBe(0); // untimed lines keep no timestamp
  expect(callLog()).toContain("docker logs --timestamps --tail 10 -- web");
});

test("svc-logs lxc runs journalctl inside the container via pct exec", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "lxc", name: "101" }]));
  const r = await viaHelper("svc-logs lxc 101 5");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).data.lines.length).toBe(5);
  expect(callLog()).toContain("pct exec 101 -- journalctl -n 5 -o json --no-pager");
});

test("svc-logs refuses a non-allowlisted unit (exit 3, denied) and never calls the tool", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const r = await viaHelper("svc-logs systemd other.service 10");
  expect(r.code).toBe(3);
  expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "denied" });
  expect(callLog()).toBe("");
});

// The helper runs as root. Its result must be created with O_EXCL in a root-owned
// directory and renamed into place without chowning anything in agent-writable space.
test("helper publishes the result with O_EXCL and an atomic rename, mode 0600", () => {
  const id = "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1";
  writeFileSync(req, JSON.stringify({ ts: Math.floor(Date.now() / 1000), id, verb: "bogus" }) + "\n");
  const probe = `
import importlib.util, json, os, sys
events = []
real_replace = os.replace
def rep(a, b):
    events.append(["replace", a, b, b]); return real_replace(a, b)
os.replace = rep
real_open = os.open
def op(path, flags, mode=0o777, *a, **k):
    events.append(["open", path, flags & os.O_EXCL != 0]); return real_open(path, flags, mode, *a, **k)
os.open = op
import importlib.machinery
loader = importlib.machinery.SourceFileLoader("svc", sys.argv[1])
spec = importlib.util.spec_from_loader("svc", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.main()
print(json.dumps({"events": events}))
`;
  const p = Bun.spawnSync(["python3", "-c", probe, HELPER], { env: helperEnv() });
  expect(p.exitCode).toBe(0);
  const { events } = JSON.parse(p.stdout.toString());
  const opened = events.find((e: any[]) => e[0] === "open" && e[1].includes("svc.result."));
  const replace = events.find((e: any[]) => e[0] === "replace");
  expect(opened[2]).toBe(true);
  expect(replace[1]).toMatch(new RegExp(`svc.result.${id}.tmp-`));
  expect(replace[2]).toBe(join(resultsDir, `svc.result.${id}`));
  expect(result(id)).toMatchObject({ ok: false, code: "denied" });
  expect(statSync(replace[2]).mode & 0o777).toBe(0o600);
});

// ---------- log text: ANSI stripping and keyword level upgrade (systemd + lxc journal lines) ----------

const journalOf = (rows: Record<string, string>[]) => rows.map((r, i) => JSON.stringify({ __REALTIME_TIMESTAMP: String((1700000000 + i) * 1000000), ...r })).join("\n") + "\n";

test("svc-logs strips ANSI from MESSAGE for systemd and lxc before truncation", async () => {
  const text = journalOf([
    { PRIORITY: "6", MESSAGE: "\u001b[34mdebug\u001b[39m loading module" },
    { PRIORITY: "6", MESSAGE: "\u001b[31mERROR\u001b[0m boom" },
    { PRIORITY: "6", MESSAGE: "a".repeat(1995) + "\u001b[31m\u001b[0m" + "b".repeat(20) },
  ]);
  fakeCmd("journalctl", `cat ${fixture("j-ansi", text)}`);
  fakeCmd("pct", `case "$1" in exec) cat ${fixture("p-ansi", text)};; esac`);
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }, { kind: "lxc", name: "101" }]));
  const sys = JSON.parse((await viaHelper("svc-logs systemd nginx.service 10")).out).data.lines as { msg: string; level: string }[];
  const lxc = JSON.parse((await viaHelper("svc-logs lxc 101 10")).out).data.lines as { msg: string; level: string }[];
  // newest first: [0] = long line, [1] = ERROR boom, [2] = debug loading module
  for (const lines of [sys, lxc]) {
    expect(lines.every(l => !l.msg.includes("\u001b"))).toBe(true);
    expect(lines[0].msg).toBe("a".repeat(1995) + "bbbbb"); // 1995 a + 20 b after strip, cut to 2000
    expect(lines[0].msg.length).toBe(2000);
    expect(lines[1]).toMatchObject({ msg: "ERROR boom", level: "error" });
    expect(lines[2]).toMatchObject({ msg: "debug loading module", level: "debug" });
  }
});

test("svc-logs upgrades info/missing PRIORITY by keyword in the cleaned msg (lxc and systemd)", async () => {
  const text = journalOf([
    { MESSAGE: "plain no level" },                                  // missing PRIORITY, no keyword -> info
    { PRIORITY: "6", MESSAGE: "\u001b[31mFatal\u001b[0m: disk gone" }, // info -> error (case-insensitive)
    { PRIORITY: "5", MESSAGE: "Traceback (most recent call last)" },  // notice -> error
    { PRIORITY: "6", MESSAGE: "Exception in handler" },               // -> error
    { PRIORITY: "6", MESSAGE: "PANIC now" },                          // -> error
    { PRIORITY: "6", MESSAGE: "WARNING: low memory" },                // -> warn
    { PRIORITY: "6", MESSAGE: "warn retrying" },                      // -> warn
    { PRIORITY: "6", MESSAGE: "[debug] cache miss" },                 // -> debug
    { MESSAGE: "terror and debugger are not keywords" },              // word match only -> info
    { PRIORITY: "6", MESSAGE: "error text at info priority" },        // info -> error
    { PRIORITY: "4", MESSAGE: "error-ish but PRIORITY 4 is warn" },   // 0-4 authoritative -> warn
    { PRIORITY: "3", MESSAGE: "debug only but PRIORITY 3 is error" }, // authoritative -> error
    { PRIORITY: "2", MESSAGE: "warning but PRIORITY 2 is error" },    // authoritative -> error
    { PRIORITY: "7", MESSAGE: "error mention at debug priority" },    // 7 is not info/missing -> keep debug
  ]);
  fakeCmd("journalctl", `cat ${fixture("j-up", text)}`);
  fakeCmd("pct", `case "$1" in exec) cat ${fixture("p-up", text)};; esac`);
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }, { kind: "lxc", name: "101" }]));
  for (const cmd of ["svc-logs systemd nginx.service 50", "svc-logs lxc 101 50"]) {
    const r = await viaHelper(cmd);
    expect(r.code).toBe(0);
    const lines = (JSON.parse(r.out).data.lines as { msg: string; level: string }[]).reverse(); // back to file order
    expect(lines.map(l => l.level)).toEqual([
      "info", "error", "error", "error", "error", "warn", "warn", "debug", "info",
      "error", "warn", "error", "error", "debug",
    ]);
  }
});

// ---------- gate: concurrent callers queue on a lock instead of failing "busy" ----------

/** Fake svc helper: answers each queued request ok:true after `delayS`, like the real helper would after its path unit fires. */
function fakeHelper(delayS = 0.3) {
  const script = join(dir, "fake-helper.sh");
  writeFileSync(script, `#!/bin/bash
while :; do
  if [ -f "${req}" ] && [ $(( $(date +%s) - $(stat -c %Y "${req}" 2>/dev/null || date +%s) )) -lt 150 ]; then
    id=$(head -n1 "${req}" | sed -n 's/.*"id":"\\([^"]*\\)".*/\\1/p')
    sleep ${delayS}
    rm -f "${req}"
    printf '{"ok":true,"data":{"items":[]}}' > "${resultsDir}/svc.result.$id"
  fi
  sleep 0.02
done
`);
  const p = Bun.spawn(["bash", script], { stdout: "ignore", stderr: "ignore" });
  return () => p.kill();
}
const runGate = (cmd: string, extra: Record<string, string> = {}) =>
  Bun.spawn(["bash", GATE], { env: { ...gateEnv(cmd), ...extra }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
const finish = async (p: ReturnType<typeof runGate>) => ({
  code: await p.exited, out: await new Response(p.stdout).text(), err: await new Response(p.stderr).text(),
});

test("four concurrent gate calls all queue and succeed (none print 'busy')", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const stop = fakeHelper(0.3);
  try {
    const procs = [1, 2, 3, 4].map(() => runGate("svc-list"));
    const rs = await Promise.all(procs.map(finish));
    for (const r of rs) {
      expect(r.err).not.toMatch(/busy/i);
      expect(r.code).toBe(0);
      expect(JSON.parse(r.out)).toMatchObject({ ok: true });
    }
    expect(existsSync(req)).toBe(false);
  } finally { stop(); }
});

test("a stale svc.request (older than 150 s) is cleared and the call succeeds", async () => {
  writeFileSync(allow, JSON.stringify([{ kind: "systemd", name: "nginx.service" }]));
  const staleId = "5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
  writeFileSync(req, JSON.stringify({ id: staleId, verb: "list", ts: 1 }) + "\n");
  const t = Date.now() / 1000 - 200; utimesSync(req, t, t);
  const stop = fakeHelper(0.1);
  try {
    const r = await finish(runGate("svc-list"));
    expect(r.err).not.toMatch(/busy/i);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true });
    expect(existsSync(req)).toBe(false);
  } finally { stop(); }
});

test("a fresh svc.request from another actor with no helper => exit 3 'busy' after the short lock wait", async () => {
  writeFileSync(req, JSON.stringify({ id: "6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b", verb: "list", ts: Math.floor(Date.now() / 1000) }) + "\n");
  const before = readFileSync(req, "utf8");
  const r = await finish(runGate("svc-list", { CCAGENT_SVC_LOCK_WAIT: "1", CCAGENT_SVC_WAIT: "1" }));
  expect(r.code).toBe(3);
  expect(r.err).toMatch(/busy/i);
  expect(readFileSync(req, "utf8")).toBe(before); // not ours: left alone
});

// ---------- user-level systemd services: kind "user", item name "<username>:<unit>" ----------

const LOGINCTL = "1000 tunitz\n999 svc\n1001 nodir\n1002 broken\n1003 Tun\n";
const USER_UNITS_1000 = "syncthing.service loaded active running Syncthing\nbroken.service loaded failed failed Oops\n";
const RD = (uid: number) => join(dir, "run", String(uid));
/** Fake loginctl (uid table), runuser (fails for user "broken") and per-uid user units. /run/user/1001 is absent. */
function setupUsers() {
  for (const u of ["1000", "999", "1002", "1003"]) mkdirSync(RD(Number(u)), { recursive: true });
  writeFileSync(join(dir, "user-units-1000"), USER_UNITS_1000);
  fakeCmd("loginctl", `case "$1" in list-users) cat ${fixture("lu", LOGINCTL)};; esac`);
  fakeCmd("runuser", `u=""; while [ "$1" != "--" ]; do if [ "$1" = "-u" ]; then shift; u="$1"; fi; shift; done; shift; if [ "$u" = broken ]; then echo boom >&2; exit 1; fi; exec "$@"`);
}

test("gate accepts user items shaped <username>:<unit> and rejects malformed ones (exit 2, nothing queued)", async () => {
  writeFileSync(allow, "[]");
  const ok = await viaHelper("svc-act user tunitz:foo.service restart");
  expect(ok.code).toBe(3); // reached the helper, which denies it: not allowlisted
  expect(JSON.parse(ok.out)).toMatchObject({ ok: false, code: "denied" });
  const cases = [
    "svc-act user foo.service restart",                        // no username part
    "svc-act user -x:foo restart",                             // username may not start with '-'
    "svc-act user Tun:foo restart",                            // username is lowercase only
    "svc-act user tunitz:-bad restart",                        // unit may not start with '-'
    "svc-act user tunitz:foo.service reload",                  // bad action
    "svc-act user " + "a".repeat(33) + ":foo.service restart", // username > 32 chars
    "svc-logs user foo.service 10",
    "svc-logs user tunitz:-bad 10",
  ];
  for (const c of cases) expect([c, gateSync(c).exitCode]).toEqual([c, 2]);
  expect(callLog()).toBe("");
});

test("helper discover: user rows come from loginctl+runuser; system uids, missing runtime dirs, failing users and bad names are skipped", async () => {
  setupUsers();
  const r = await viaHelper("svc-discover");
  expect(r.code).toBe(0);
  const users = (JSON.parse(r.out).data.items as any[]).filter(i => i.kind === "user");
  expect(users).toEqual([
    { kind: "user", name: "tunitz:syncthing.service", state: "active", detail: "Syncthing" },
    { kind: "user", name: "tunitz:broken.service", state: "failed", detail: "Oops" },
  ]);
  expect(callLog()).toContain("runuser -u tunitz -- env XDG_RUNTIME_DIR=" + RD(1000));
  expect(callLog()).not.toContain("runuser -u svc");
  expect(callLog()).not.toContain("runuser -u nodir");
  expect(callLog()).not.toContain("runuser -u Tun");
});

test("helper discover: a missing loginctl yields no user rows and no error", async () => {
  setupUsers();
  Bun.spawnSync(["rm", "-f", join(bin, "loginctl")]);
  const r = await viaHelper("svc-discover");
  expect(r.code).toBe(0);
  expect((JSON.parse(r.out).data.items as any[]).filter(i => i.kind === "user")).toEqual([]);
});

test("svc-list reports user items from discovery; allowlisted but absent ones are missing", async () => {
  setupUsers();
  writeFileSync(allow, JSON.stringify([{ kind: "user", name: "tunitz:syncthing.service" }, { kind: "user", name: "tunitz:gone.service" }]));
  const r = await viaHelper("svc-list");
  expect(r.code).toBe(0);
  const items = JSON.parse(r.out).data.items as any[];
  expect(items.find(i => i.name === "tunitz:syncthing.service")).toMatchObject({ kind: "user", state: "active", detail: "Syncthing" });
  expect(items.find(i => i.name === "tunitz:gone.service")).toMatchObject({ kind: "user", state: "missing" });
});

test("helper act on a user item runs exactly: runuser -u <user> -- env XDG_RUNTIME_DIR=… DBUS_SESSION_BUS_ADDRESS=… systemctl --user <action> -- <unit>", async () => {
  setupUsers();
  writeFileSync(allow, JSON.stringify([{ kind: "user", name: "tunitz:syncthing.service" }]));
  const r = await viaHelper("svc-act user tunitz:syncthing.service restart");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toMatchObject({ ok: true });
  const rd = RD(1000);
  expect(callLog().trim().split("\n")).toEqual([
    "loginctl list-users --no-legend",
    `runuser -u tunitz -- env XDG_RUNTIME_DIR=${rd} DBUS_SESSION_BUS_ADDRESS=unix:path=${rd}/bus ${join(bin, "systemctl")} --user restart -- syncthing.service`,
    "systemctl --user restart -- syncthing.service",
  ]);
});

test("helper denies user acts that are not allowlisted, target system users, lack a session, or name protected units", async () => {
  setupUsers();
  writeFileSync(allow, JSON.stringify([
    { kind: "user", name: "tunitz:syncthing.service" }, { kind: "user", name: "svc:foo.service" },
    { kind: "user", name: "tunitz:sshd.service" },
  ]));
  const denied = async (name: string) => {
    const r = await viaHelper(`svc-act user ${name} restart`);
    return JSON.parse(r.out);
  };
  expect(await denied("tunitz:broken.service")).toMatchObject({ ok: false, code: "denied" }); // not allowlisted
  expect(await denied("svc:foo.service")).toMatchObject({ ok: false, code: "denied" });        // uid 999 is a system user
  expect(await denied("tunitz:sshd.service")).toMatchObject({ ok: false, code: "denied" });    // protected unit
  expect(callLog()).not.toContain("runuser");
  rmSync(RD(1000), { recursive: true, force: true });
  expect(await denied("tunitz:syncthing.service")).toMatchObject({ ok: false, code: "failed", error: "user session not running" });
  expect(callLog()).not.toContain("runuser");
});

test("helper re-validates user item parts itself (a compromised gate cannot inject)", () => {
  setupUsers();
  writeFileSync(allow, JSON.stringify([{ kind: "user", name: "tunitz:syncthing.service" }]));
  for (const [id, name] of [["f1f1f1f1f1f1f1f1", "-x:foo.service"], ["f2f2f2f2f2f2f2f2", "Tun:foo.service"], ["f3f3f3f3f3f3f3f3", "tunitz:-bad"], ["f4f4f4f4f4f4f4f4", "tunitz"]]) {
    helperRun({ id, verb: "act", kind: "user", name, action: "restart" });
    expect([name, result(id)]).toEqual([name, expect.objectContaining({ ok: false, code: "bad_request" })]);
  }
  expect(callLog()).not.toContain("runuser");
});

test("helper logs for a user item use exactly: journalctl --user-unit <unit> _UID=<uid> -n N -o json --no-pager", async () => {
  setupUsers();
  writeFileSync(allow, JSON.stringify([{ kind: "user", name: "tunitz:syncthing.service" }]));
  const r = await viaHelper("svc-logs user tunitz:syncthing.service 50");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out).data.lines.map((l: any) => l.msg.slice(0, 12))).toEqual(["xxxxxxxxxxxx", "no priority", "debug chatte", "disk nearly ", "café broke", "started ngin"]);
  expect(callLog()).toContain("journalctl --user-unit syncthing.service _UID=1000 -n 50 -o json --no-pager\n");
});

test("svc-allow accepts user items and rejects protected user units and bad user names", async () => {
  setupUsers();
  const ok = await viaHelper("svc-allow", Buffer.from(JSON.stringify({ items: [{ kind: "user", name: "tunitz:syncthing.service" }, { kind: "user", name: "tunitz:syncthing.service" }] })));
  expect(ok.code).toBe(0);
  expect(JSON.parse(readFileSync(allow, "utf8"))).toEqual([{ kind: "user", name: "tunitz:syncthing.service" }]);
  for (const name of ["tunitz:ccagent.service", "tunitz:ssh.service", "Tun:foo.service", "tunitz:-x"]) {
    const r = await viaHelper("svc-allow", Buffer.from(JSON.stringify({ items: [{ kind: "user", name }] })));
    expect([name, r.code]).toEqual([name, 3]);
    expect(JSON.parse(r.out)).toMatchObject({ ok: false, code: "bad_request" });
  }
  expect(JSON.parse(readFileSync(allow, "utf8"))).toEqual([{ kind: "user", name: "tunitz:syncthing.service" }]);
});
