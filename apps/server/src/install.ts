import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const agentFile = (name: string) => readFileSync(join(import.meta.dir, "../../../agent", name), "utf8");
const slim = (src: string) => src.split("\n").filter((l, i) => i === 0 || (l.trim() !== "" && !/^\s*#/.test(l))).join("\n") + "\n";
const b64 = (name: string) => (Buffer.from(slim(agentFile(name))).toString("base64").match(/.{1,76}/g) ?? []).join("\n");

/**
 * One copy-paste command for a unit that cannot reach the Control Center: the installer travels inside
 * the paste, gzip+base64 on a single line (nothing is downloaded).
 */
export function pasteCommand(script: string, sudo = true) {
  return `echo '${gzipSync(Buffer.from(script), { level: 9 }).toString("base64")}' | base64 -d | gunzip | ${sudo ? "sudo " : ""}bash\n`;
}

/**
 * Short command for units that can reach GitHub: the generic installer is a release asset of the public agent repo
 * and the unit's public key is passed as an argument. tag "latest" follows the newest release.
 */
export function curlCommand(o: { repo: string; tag: string; pubkey: string; sudo?: boolean }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("invalid repo");
  if (!/^[\w.-]+$/.test(o.tag)) throw new Error("invalid tag");
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [\w.@-]+)?$/.test(o.pubkey)) throw new Error("invalid public key");
  const base = o.tag === "latest" ? "releases/latest/download" : `releases/download/${o.tag}`;
  return `curl -fsSL https://github.com/${o.repo}/${base}/install-ccagent.sh | ${o.sudo === false ? "" : "sudo "}bash -s -- '${o.pubkey}'`;
}

/**
 * Self-contained installer: the agent files are embedded, so the unit never has to reach the Control Center.
 * With `pubkey` baked in it is a per-unit script; without it, it takes the public key as $1 (release asset).
 */
export function installScript(opts: { pubkey?: string; from?: string; interval: number }) {
  // raw (quoted heredoc) embedding compresses far better inside the gzip'd one-liner than base64 does
  const fromOpt = opts.from ? `,from=\\"${opts.from}\\"` : "";
  const keyLine = opts.pubkey
    ? `PUBKEY=${JSON.stringify(opts.pubkey)}`
    : `PUBKEY="\${1:-}"
INTERVAL="\${2:-${opts.interval}}"
[ -n "$PUBKEY" ] || { echo "usage: sudo bash $0 '<ssh-ed25519 public key from the Control Center>' [interval_s]"; exit 1; }`;
  return `#!/usr/bin/env bash
# Control Center agent installer (self-contained, no network access to the Control Center needed). Run as root.
AGENT_VERSION=2
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
INTERVAL=${opts.interval}
${keyLine}
id ccagent >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ccagent --shell /bin/bash ccagent
mkdir -p /opt/ccagent /var/lib/ccagent/.ssh /etc/ccagent
cat > /opt/ccagent/ccagent.sh <<'EOF_ccagent_sh'
${slim(agentFile("ccagent.sh"))}EOF_ccagent_sh
cat > /opt/ccagent/ccagent-gate <<'EOF_ccagent_gate'
${slim(agentFile("ccagent-gate"))}EOF_ccagent_gate
cat > /opt/ccagent/ccagent-power <<'EOF_ccagent_power'
${slim(agentFile("ccagent-power"))}EOF_ccagent_power
cat > /opt/ccagent/ccagent-svc <<'EOF_ccagent_svc'
${slim(agentFile("ccagent-svc"))}EOF_ccagent_svc
cat > /opt/ccagent/uninstall.sh <<'EOF_uninstall_sh'
${slim(agentFile("uninstall.sh"))}EOF_uninstall_sh
chmod 755 /opt/ccagent/ccagent.sh /opt/ccagent/ccagent-gate /opt/ccagent/ccagent-power /opt/ccagent/ccagent-svc /opt/ccagent/uninstall.sh
printf 'INTERVAL=%s\\nDIR=/var/lib/ccagent\\nSVC_UNIT=/etc/systemd/system/ccagent-svc.path\\n' "$INTERVAL" > /etc/ccagent.conf
printf '%s\\n' "command=\\"/opt/ccagent/ccagent-gate\\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding${fromOpt} $PUBKEY" > /var/lib/ccagent/.ssh/authorized_keys
chmod 700 /var/lib/ccagent/.ssh; chmod 600 /var/lib/ccagent/.ssh/authorized_keys
chown -R ccagent:ccagent /var/lib/ccagent
# Power control without sudo: systemd (root) watches for a request file written by the agent user and runs the matching action.
# This also works on Proxmox, which ships no sudo. Older installs used a sudoers rule; remove it.
rm -f /etc/sudoers.d/ccagent
cat > /etc/systemd/system/ccagent-power.path <<UNIT
[Unit]
Description=Control Center power requests
[Path]
PathExists=/var/lib/ccagent/power.request
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/ccagent-power.service <<UNIT
[Unit]
Description=Control Center power action
[Service]
Type=oneshot
ExecStart=/opt/ccagent/ccagent-power
UNIT
cat > /etc/systemd/system/ccagent-svc.path <<UNIT
[Unit]
Description=Control Center service requests
StartLimitIntervalSec=0
[Path]
PathExists=/var/lib/ccagent/svc.request
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/ccagent-svc.service <<UNIT
[Unit]
Description=Control Center service action
StartLimitIntervalSec=0
[Service]
Type=oneshot
ExecStart=/opt/ccagent/ccagent-svc
UNIT
if command -v systemd-tmpfiles >/dev/null; then
  mkdir -p /etc/tmpfiles.d
  printf 'z /sys/class/powercap/*/energy_uj 0444 - - -\\n' > /etc/tmpfiles.d/ccagent-rapl.conf
  systemd-tmpfiles --create /etc/tmpfiles.d/ccagent-rapl.conf 2>/dev/null || true
fi
cat > /etc/systemd/system/ccagent.service <<UNIT
[Unit]
Description=Control Center metrics agent
After=network.target
[Service]
User=ccagent
ExecStart=/opt/ccagent/ccagent.sh
Restart=always
Nice=19
MemoryMax=32M
CPUQuota=5%
ProtectSystem=strict
ReadWritePaths=/var/lib/ccagent
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload; systemctl enable ccagent.service ccagent-power.path ccagent-svc.path
systemctl restart ccagent-power.path
systemctl restart ccagent-svc.path
# restart (not just start): a re-run must replace a running agent with the freshly installed code
systemctl restart ccagent.service
sleep 2; systemctl is-active ccagent.service
echo "ccagent installed. The Control Center connects over SSH (port 22) and will mark this unit online within a poll interval."
`;
}
