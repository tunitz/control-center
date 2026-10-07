import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const AGENT = join(import.meta.dir, "../../../agent");
let dir: string, req: string, calls: string, fake: string, unit: string, conf: string;
beforeEach(() => {
  dir = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "ccpow-"));
  req = join(dir, "power.request"); calls = join(dir, "calls.log"); fake = join(dir, "fake-systemctl"); unit = join(dir, "ccagent-power.path"); conf = join(dir, "conf");
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> ${calls}\n`); chmodSync(fake, 0o755);
  writeFileSync(conf, `DIR=${dir}\nPOWER_UNIT=${unit}\n`);
});
const helper = (content: string, ageS = 0) => {
  writeFileSync(req, content);
  if (ageS) { const t = Date.now() / 1000 - ageS; utimesSync(req, t, t); }
  return Bun.spawnSync(["/usr/bin/bash", join(AGENT, "ccagent-power")], { env: { PATH: "/usr/bin:/bin", CCAGENT_REQ: req, CCAGENT_SYSTEMCTL: fake } });
};
const ran = () => (existsSync(calls) ? readFileSync(calls, "utf8").trim() : "");
const gate = (cmd: string) => Bun.spawnSync(["/usr/bin/bash", join(AGENT, "ccagent-gate")], { env: { PATH: "/usr/bin:/bin", CCAGENT_CONF: conf, SSH_ORIGINAL_COMMAND: cmd } });

test("helper runs exactly the requested action and consumes the request", () => {
  helper("poweroff\n"); expect(ran()).toBe("poweroff"); expect(existsSync(req)).toBe(false);
});
test("helper runs reboot", () => { helper("reboot"); expect(ran()).toBe("reboot"); });
test("helper ignores anything else (a compromised agent user cannot inject commands)", () => {
  for (const bad of ["rm -rf /", "poweroff; id", "halt", "", "POWEROFF"]) { helper(bad); expect(existsSync(req)).toBe(false); }
  expect(ran()).toBe("");
});
test("helper ignores a stale request (left over from before a boot) instead of powering off again", () => {
  helper("poweroff", 600); expect(ran()).toBe(""); expect(existsSync(req)).toBe(false);
});
test("gate writes the request when the power unit is installed", () => {
  writeFileSync(unit, "");
  const r = gate("power-off"); expect(r.exitCode).toBe(0);
  expect(readFileSync(req, "utf8").trim()).toBe("poweroff");
  gate("reboot"); expect(readFileSync(req, "utf8").trim()).toBe("reboot");
});
test("gate tells the user to re-run the installer when the power unit is missing", () => {
  const r = gate("power-off"); expect(r.exitCode).toBe(3);
  expect(r.stderr.toString()).toMatch(/re-run the installer/i);
  expect(existsSync(req)).toBe(false);
});
test("gate still rejects unknown verbs", () => { expect(gate("poweroff-now").exitCode).toBe(2); });
