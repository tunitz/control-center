import { test, expect } from "bun:test";
import { installScript } from "./install";

const pub = "ssh-ed25519 AAAATESTKEY cc-test";
test("installer is self-contained: no network callback, embeds agent files and key", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).not.toMatch(/curl|wget|BASE=|TOKEN/);
  expect(s).toContain(pub);
  for (const f of ["ccagent.sh", "ccagent-gate", "uninstall.sh"]) expect(s).toContain(`/opt/ccagent/${f}`);
  expect(s).toContain("base64 -d");
  expect(s.startsWith("#!/usr/bin/env bash")).toBe(true);
});
test("embedded payloads decode back to the real agent files", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  const blobs = [...s.matchAll(/<<'B64_(\w+)'\n([\s\S]*?)\nB64_\1\n/g)];
  expect(blobs.length).toBe(3);
  const gate = blobs.find(b => b[1] === "ccagent_gate")!;
  expect(Buffer.from(gate[2].replace(/\s/g, ""), "base64").toString()).toContain("SSH_ORIGINAL_COMMAND");
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
