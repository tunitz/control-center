import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installScript, agentFile, curlCommand, DEFAULT_SSH_PORT } from "./install";

const pub = "ssh-ed25519 AAAATESTKEY cc-test";
test("CC_AGENT_DIR overrides where agent files and the installer are read from", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-agent-"));
  const prev = process.env.CC_AGENT_DIR;
  try {
    for (const f of ["ccagent.sh", "ccagent-gate", "ccagent-power", "ccagent-svc", "uninstall.sh"])
      writeFileSync(join(dir, f), `echo FIXTURE_${f.replace(/\W/g, "_")}\n`);
    process.env.CC_AGENT_DIR = dir;
    expect(agentFile("ccagent.sh")).toBe("echo FIXTURE_ccagent_sh\n");
    const s = installScript({ pubkey: pub, interval: 5 });
    expect(s).toContain("echo FIXTURE_ccagent_sh");
    expect(s).toContain("echo FIXTURE_uninstall_sh");
  } finally {
    if (prev === undefined) delete process.env.CC_AGENT_DIR;
    else process.env.CC_AGENT_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

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
  // curl is the default install method; this paste is the offline fallback, so its bound is loose
  // (was 5600 before the installer grew to ~9.8k, ~11.3k with user-level service support, ~12.7k with
  // disk metrics, ~15.8k with the dedicated sshd + preflight/firewall logic added for the SSH port move).
  expect(p.length).toBeLessThan(18000);
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

test("curl command propagates the configured sampling interval and accepts OpenSSH comments", () => {
  const c = curlCommand({ repo: "a/b", tag: "latest", pubkey: "ssh-ed25519 AAAA cc-Lab Node@localhost", interval: 30, sshPort: 62478 });
  expect(c).toContain("' 30 62478");
  expect(c.trimEnd()).toMatch(/ 30 62478$/);
  expect(c).toContain("cc-Lab Node@localhost");
  expect(() => curlCommand({ repo: "a/b", tag: "latest", pubkey: pub, interval: 0 })).toThrow(/interval/);
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

// --- dedicated SSH port (62478) ---

test("SSH port defaults to 62478, is baked in and recorded in /etc/ccagent.conf", () => {
  expect(DEFAULT_SSH_PORT).toBe(62478);
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("SSH_PORT=62478");
  expect(s).toContain('SSH_PORT=%s\\n');
  expect(s).toContain('"$PORT" > /etc/ccagent.conf');
  expect(s).not.toContain("port 22)");
  expect(s).toContain("port $PORT)");
});
test("invalid sampling intervals and source IPs are rejected before rendering a script", () => {
  for (const bad of [0, -1, 1.5, 3601]) expect(() => installScript({ pubkey: pub, interval: bad })).toThrow(/interval/);
  expect(() => installScript({ pubkey: pub, interval: 5, from: "1.2.3.4; rm -rf /" })).toThrow(/source IP/);
});

test("optional sshPort propagates into installScript; invalid ports are rejected", () => {
  const s = installScript({ pubkey: pub, interval: 5, sshPort: 63000 });
  expect(s).toContain("SSH_PORT=63000");
  const g = installScript({ interval: 5, sshPort: 63000 });
  expect(g).toContain('PORT="${3:-${CCAGENT_SSH_PORT:-63000}}"');
  expect(g).toContain("usage: sudo bash $0 '<ssh-ed25519 public key from the Control Center>' [interval_s] [ssh_port]");
  for (const bad of [22, 0, 65536, 1.5, -1, NaN])
    expect(() => installScript({ interval: 5, sshPort: bad })).toThrow(/ssh port/i);
});
test("sshPort propagates into curlCommand as the third argument without changing the legacy command", () => {
  expect(curlCommand({ repo: "a/b", tag: "latest", pubkey: pub, sshPort: 63000 }))
    .toBe(`curl -fsSL https://github.com/a/b/releases/latest/download/install-ccagent.sh | sudo bash -s -- '${pub}' 5 63000`);
  expect(curlCommand({ repo: "a/b", tag: "latest", pubkey: pub }))
    .toBe(`curl -fsSL https://github.com/a/b/releases/latest/download/install-ccagent.sh | sudo bash -s -- '${pub}'`);
  for (const bad of [22, 0, 65536, 1.5])
    expect(() => curlCommand({ repo: "a/b", tag: "latest", pubkey: pub, sshPort: bad })).toThrow(/ssh port/i);
});

test("agent reports df avail_mb so UI can show real available space", () => {
  const sh = agentFile("ccagent.sh");
  expect(sh).toContain("avail = $5");
  expect(sh).toContain('\\"avail_mb\\":" avail + 0');
});

test("firewall preflight runs first, detects every backend and aborts on nft without a chain", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s.indexOf("# --- firewall preflight")).toBeLessThan(s.indexOf("useradd"));
  expect(s.indexOf("# --- firewall preflight")).toBeLessThan(s.indexOf("> /etc/ccagent.conf"));
  expect(s).toContain("ufw status 2>/dev/null | grep -q '^Status: active'");
  expect(s).toContain('[ "$(firewall-cmd --state 2>/dev/null)" = "running" ]');
  expect(s).toContain('[ -n "$(nft list ruleset 2>/dev/null)" ]');
  expect(s).toContain("nft list chain inet filter input");
  expect(s).toContain("iptables -S INPUT");
  expect(s).toContain("nft add table inet filter");
  expect(s).toContain("nft add chain inet filter input");
});
test("firewall rules carry an ownership marker and a root-owned manifest for clean uninstall", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain('FW_MARKER="ccagent-control-center-$PORT"');
  expect(s).toContain('/etc/ccagent/firewall.json');
  expect(s).toContain('chmod 600 /etc/ccagent/firewall.json');
  expect(s).toContain('-m comment --comment "$FW_MARKER"');
  const u = agentFile("uninstall.sh");
  expect(u).toContain('nft delete rule inet filter input handle');
  expect(u).toContain('-m comment --comment "$FW_MARKER"');
  expect(u).toContain("rm -f /etc/ccagent/firewall.json");
  expect(() => Bun.spawnSync(["bash", "-n"], { stdin: Buffer.from(s) }).exitCode === 0 || (() => { throw 1; })()).not.toThrow();
});

test("firewall is opened idempotently for each active backend", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("ufw allow \"${PORT}/tcp\" comment \"$FW_MARKER\"");
  expect(s).toContain("firewall-cmd --query-port=\"${PORT}/tcp\"");
  expect(s).toContain("firewall-cmd --permanent --add-port=\"${PORT}/tcp\"");
  expect(s).toContain("firewall-cmd --reload");
  expect(s).toContain("nft add rule inet filter input tcp dport \"${PORT}\" accept comment \"$FW_MARKER\"");
  expect(s).toContain("iptables -C INPUT -p tcp --dport \"$PORT\" -m comment --comment \"$FW_MARKER\" -j ACCEPT");
  expect(s).toContain("iptables -I INPUT -p tcp --dport \"$PORT\" -m comment --comment \"$FW_MARKER\" -j ACCEPT");
  expect(s).toContain("ip6tables -I INPUT -p tcp --dport \"$PORT\" -m comment --comment \"$FW_MARKER\" -j ACCEPT");
  expect(s).toContain("iptables rules may not persist across reboot");
});
test("sshd preflight installs openssh-server via apt-get/dnf/yum and prepares host keys", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("command -v sshd");
  expect(s).toContain("/usr/sbin/sshd");
  expect(s).toContain("apt-get install -y openssh-server");
  expect(s).toContain("dnf install -y openssh-server");
  expect(s).toContain("yum install -y openssh-server");
  expect(s).toContain("no supported package manager (apt-get/dnf/yum)");
  expect(s).toContain("mkdir -p /run/sshd");
  expect(s).toContain("ssh-keygen -A");
  // a shadow-locked system user is rejected by sshd when UsePAM is off
  expect(s).toContain("usermod -p '*' ccagent");
});
test("a dedicated sshd config and systemd unit are installed without touching port 22", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  for (const line of [
    "Port %s", "ListenAddress 0.0.0.0", "for k in /etc/ssh/ssh_host_*_key",
    'printf \'HostKey %s\\n\' "$k"', "PermitRootLogin no", "AllowUsers ccagent",
    "PubkeyAuthentication yes", "PasswordAuthentication no", "KbdInteractiveAuthentication no",
    "PermitEmptyPasswords no", "AuthorizedKeysFile /var/lib/ccagent/.ssh/authorized_keys",
    "AllowAgentForwarding no", "AllowTcpForwarding no", "X11Forwarding no", "PermitTunnel no",
    "GatewayPorts no", "PermitUserEnvironment no", "UsePAM no", "PidFile /run/ccagent-sshd.pid",
  ]) expect(s).toContain(line);
  // any installed host key type is used (ed25519, rsa, ecdsa, ...), and keys are generated when absent
  expect(s).toContain("for k in /etc/ssh/ssh_host_*_key");
  expect(s).toContain("ls /etc/ssh/ssh_host_*_key");
  expect(s).toContain("ssh-keygen -A");
  const units: Record<string, string> = {};
  for (const m of s.matchAll(/cat > (\S+) <<UNIT\n([\s\S]*?)\nUNIT\n/g)) units[m[1]] = m[2];
  const u = units["/etc/systemd/system/ccagent-sshd.service"]!;
  expect(u).toContain("After=network.target");
  expect(u).toContain("ExecStart=$SSHD_BIN -D -e -f /etc/ssh/ccagent_sshd_config");
  expect(u).toContain("Restart=on-failure");
  expect(u).toContain("WantedBy=multi-user.target");
  expect(s.indexOf("sshd -t -f /etc/ssh/ccagent_sshd_config")).toBeLessThan(s.indexOf("systemctl enable ccagent-sshd.service"));
  expect(s).toContain("systemctl restart ccagent-sshd.service");
  expect(s).toContain("systemctl enable ccagent.service ccagent-power.path ccagent-svc.path");
  expect(s).not.toContain("enable --now");
});
test("verification checks sshd state, listener via ss/netstat/proc fallback and firewall rules", () => {
  const s = installScript({ pubkey: pub, interval: 5 });
  expect(s).toContain("systemctl is-active ccagent-sshd.service");
  expect(s).toContain("ss -ltn");
  expect(s).toContain("netstat -ltn");
  expect(s).toContain("/proc/net/tcp");
  expect(s).toContain("printf '%04X'");
  expect(s).toContain("WARNING: no listener check tool available");
  expect(s).toContain("ERROR: ufw rule for port");
  expect(s).toContain("ERROR: firewalld rule for port");
  expect(s).toContain("ERROR: nftables rule for port");
  expect(s).toContain("ERROR: iptables rule for port");
});
test("uninstall removes the dedicated sshd unit/config and only our firewall rules", () => {
  const u = agentFile("uninstall.sh");
  expect(u).toContain("systemctl disable --now ccagent-sshd.service");
  expect(u).toContain("/etc/systemd/system/ccagent-sshd.service");
  expect(u).toContain("/etc/ssh/ccagent_sshd_config");
  expect(u).toContain("SSH_PORT=62478");
  expect(u).toContain(". /etc/ccagent.conf");
  expect(u).toContain("ccagent control center");
  expect(u).toContain("firewall-cmd --permanent --remove-port=");
  expect(u).toContain('iptables -D INPUT -p tcp --dport "$SSH_PORT" -m comment --comment "$FW_MARKER" -j ACCEPT');
  expect(u).toContain("nftables detected");
  expect(u).toContain("rm -rf /opt/ccagent");
  expect(u).toContain("userdel -r ccagent");
});
