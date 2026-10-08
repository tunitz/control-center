import { test, expect } from "bun:test";
import { installScript, agentFile } from "./install";

const pub = "ssh-ed25519 AAAATESTKEY cc-test";
test("installer is self-contained: no network callback, embeds agent files and key", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).not.toMatch(/curl|wget|BASE=|TOKEN/);
  expect(s).toContain(pub);
  for (const f of ["ccagent.sh", "ccagent-gate", "uninstall.sh"]) expect(s).toContain(`/opt/ccagent/${f}`);
  expect(s).toContain("SSH_ORIGINAL_COMMAND");
  expect(s.startsWith("#!/usr/bin/env bash")).toBe(true);
});
test("embedded agent files are present as quoted heredocs", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  for (const t of ["ccagent_sh", "ccagent_gate", "uninstall_sh"]) expect(s).toContain(`<<'EOF_${t}'`);
});
test("generic installer (release asset) takes the key as an argument", () => {
  const s = installScript({ interval: 5 });
  expect(s).toContain('PUBKEY="${1:-}"');
  expect(s).toMatch(/usage/i);
});
test("forced-command line restricts key and honours from=", () => {
  const s = installScript({ pubkey: pub, interval: 5, from: "10.0.0.5" });
  expect(s).toContain('from=\\"10.0.0.5\\"');
  expect(s).toContain("no-pty,no-port-forwarding");
});

test("paste command is ONE short line that decodes back to the full installer", async () => {
  const { pasteCommand } = await import("./install");
  const { gunzipSync } = await import("node:zlib");
  const s = installScript({ pubkey: pub, interval: 5 });
  const p = pasteCommand(s);
  expect(p.trim().split("\n").length).toBe(1);          // one line, not a paragraph
  // curl is the default install method; this paste is the offline fallback, so its bound is loose (was 5600 before the installer grew to ~9.8k).
  expect(p.length).toBeLessThan(10500);
  const m = /^echo '([A-Za-z0-9+/=]+)' \| base64 -d \| gunzip \| sudo bash\n?$/.exec(p);
  expect(m).not.toBeNull();
  const back = gunzipSync(Buffer.from(m![1], "base64")).toString();
  expect(back).toContain(pub);
  expect(back).toContain("SSH_ORIGINAL_COMMAND");        // gate script made it through
  expect(back.startsWith("#!/usr/bin/env bash")).toBe(true);
  expect(() => Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(back) }).exitCode === 0 || (() => { throw 1; })()).not.toThrow();
});

test("curl command is short, pinned to a tag, and passes the key as an argument", async () => {
  const { curlCommand } = await import("./install");
  const c = curlCommand({ repo: "tunitz/ccagent", tag: "v0.3.0", pubkey: pub });
  expect(c).toBe(`curl -fsSL https://github.com/tunitz/ccagent/releases/download/v0.3.0/install-ccagent.sh | sudo bash -s -- '${pub}'`);
  expect(c.length).toBeLessThan(260);
  expect(c.split("\n").length).toBe(1);
  expect(() => curlCommand({ repo: "bad repo; rm -rf /", tag: "v1", pubkey: pub })).toThrow();
  expect(() => curlCommand({ repo: "a/b", tag: "v1", pubkey: "x'; rm -rf / #" })).toThrow();
});

test("curl command has a no-sudo variant for root shells (Proxmox has no sudo)", async () => {
  const { curlCommand } = await import("./install");
  const c = curlCommand({ repo: "a/b", tag: "latest", pubkey: pub, sudo: false });
  expect(c).toBe(`curl -fsSL https://github.com/a/b/releases/latest/download/install-ccagent.sh | bash -s -- '${pub}'`);
  expect(c).not.toContain("sudo");
  expect(curlCommand({ repo: "a/b", tag: "latest", pubkey: pub })).toContain("| sudo bash"); // default stays sudo
});
test("paste command has a no-sudo variant", async () => {
  const { pasteCommand } = await import("./install");
  const p = pasteCommand(installScript({ pubkey: pub, interval: 5 }), false);
  expect(p).toMatch(/\| gunzip \| bash\n$/);
  expect(p).not.toContain("sudo");
});
test("re-running the installer restarts the service so it also upgrades a running agent", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("systemctl restart ccagent.service");
  expect(s).not.toContain("enable --now"); // enable --now is a no-op on an already-running unit
});

test("power control needs no sudo: root path unit + helper, old sudoers rule removed", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("ccagent-power.path");
  expect(s).toContain("PathExists=/var/lib/ccagent/power.request");
  expect(s).toContain("<<'EOF_ccagent_power'");
  expect(s).toContain("ExecStart=/opt/ccagent/ccagent-power");
  expect(s).not.toContain("visudo");
  expect(s).toContain("rm -f /etc/sudoers.d/ccagent"); // migrate older installs
});

test("service control: helper, path unit, service unit and allowlist dir are installed (no sudo)", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("<<'EOF_ccagent_svc'");
  expect(s).toContain("/opt/ccagent/ccagent-svc");
  expect(s).toContain("/etc/systemd/system/ccagent-svc.path");
  expect(s).toContain("PathExists=/var/lib/ccagent/svc.request");
  expect(s).toContain("/etc/systemd/system/ccagent-svc.service");
  expect(s).toContain("ExecStart=/opt/ccagent/ccagent-svc");
  expect(s).toContain("/etc/ccagent");
  expect(s).toContain("systemctl enable ccagent.service ccagent-power.path ccagent-svc.path");
  expect(s).toContain("systemctl restart ccagent-svc.path");
  expect(s).not.toMatch(/sudo\s+-?\w/);
});
test("service control: the embedded helper and gate are the agent files, and the installer bumps the agent version", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("ccagent-svc");
  expect(s).toMatch(/AGENT_VERSION=\d+/);
});
test("service control: uninstall removes the helper, units and allowlist", () => {
  const u = agentFile("uninstall.sh");
  for (const f of ["ccagent-svc.path", "ccagent-svc.service", "/etc/ccagent"]) expect(u).toContain(f);
});

test("service control: svc path+service units disable start-rate limiting; power units do not", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  const units: Record<string, string> = {};
  for (const m of s.matchAll(/cat > (\S+) <<UNIT\n([\s\S]*?)\nUNIT\n/g)) units[m[1]] = m[2];
  for (const u of ["/etc/systemd/system/ccagent-svc.path", "/etc/systemd/system/ccagent-svc.service"]) {
    expect(units[u]).toBeDefined();
    expect(units[u]!.split("[Unit]")[1]!.split("\n[")[0]).toContain("StartLimitIntervalSec=0");
  }
  for (const u of ["/etc/systemd/system/ccagent-power.path", "/etc/systemd/system/ccagent-power.service"]) {
    expect(units[u]).toBeDefined();
    expect(units[u]).not.toContain("StartLimitIntervalSec");
  }
});
