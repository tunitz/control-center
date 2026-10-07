import { test, expect } from "bun:test";
import { installScript } from "./install";

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
  expect(p.length).toBeLessThan(5200);                    // was ~12300 as a multi-line paragraph
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
test("sudoers block runs cleanly when sudo/visudo are absent (Proxmox): no abort, power reported unavailable", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  const a = s.indexOf("SYSCTL=$(command -v systemctl"), b = s.indexOf("# RAPL counters");
  const block = s.slice(a, b);
  // PATH holds only bash builtins' needs: no sudo, no visudo
  const r = Bun.spawnSync(["/usr/bin/bash", "-c", "set -euo pipefail\n" + block + "\necho CONTINUED"], { env: { PATH: "/nonexistent" } });
  expect(r.stdout.toString()).toContain("power control unavailable");
  expect(r.stdout.toString()).toContain("CONTINUED");   // set -e did not abort the install
  expect(r.exitCode).toBe(0);
});
