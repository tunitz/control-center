import { readFileSync } from "node:fs";
import { join } from "node:path";

export const agentFile = (name: string) => readFileSync(join(import.meta.dir, "../../../agent", name), "utf8");
const b64 = (name: string) => (Buffer.from(agentFile(name)).toString("base64").match(/.{1,76}/g) ?? []).join("\n");

/**
 * Self-contained installer: the agent files are embedded, so the unit never has to reach the Control Center.
 * With `pubkey` baked in it is a per-unit script; without it, it takes the public key as $1 (release asset).
 */
export function installScript(opts: { pubkey?: string; from?: string; interval: number }) {
  const fromOpt = opts.from ? `,from=\\"${opts.from}\\"` : "";
  const keyLine = opts.pubkey
    ? `PUBKEY=${JSON.stringify(opts.pubkey)}`
    : `PUBKEY="\${1:-}"
INTERVAL="\${2:-${opts.interval}}"
[ -n "$PUBKEY" ] || { echo "usage: sudo bash $0 '<ssh-ed25519 public key from the Control Center>' [interval_s]"; exit 1; }`;
  return `#!/usr/bin/env bash
# Control Center agent installer (self-contained, no network access to the Control Center needed). Run as root.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
INTERVAL=${opts.interval}
${keyLine}
id ccagent >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ccagent --shell /bin/bash ccagent
mkdir -p /opt/ccagent /var/lib/ccagent/.ssh
base64 -d > /opt/ccagent/ccagent.sh <<'B64_ccagent_sh'
${b64("ccagent.sh")}
B64_ccagent_sh
base64 -d > /opt/ccagent/ccagent-gate <<'B64_ccagent_gate'
${b64("ccagent-gate")}
B64_ccagent_gate
base64 -d > /opt/ccagent/uninstall.sh <<'B64_uninstall_sh'
${b64("uninstall.sh")}
B64_uninstall_sh
chmod 755 /opt/ccagent/ccagent.sh /opt/ccagent/ccagent-gate /opt/ccagent/uninstall.sh
printf 'INTERVAL=%s\\nDIR=/var/lib/ccagent\\n' "$INTERVAL" > /etc/ccagent.conf
printf '%s\\n' "command=\\"/opt/ccagent/ccagent-gate\\",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding${fromOpt} $PUBKEY" > /var/lib/ccagent/.ssh/authorized_keys
chmod 700 /var/lib/ccagent/.ssh; chmod 600 /var/lib/ccagent/.ssh/authorized_keys
chown -R ccagent:ccagent /var/lib/ccagent
# power verbs only: exactly these two commands, no wildcard
SYSCTL=$(command -v systemctl)
printf 'ccagent ALL=(root) NOPASSWD: %s ${"power" + "off"}, %s ${"re" + "boot"}\\n' "$SYSCTL" "$SYSCTL" > /etc/sudoers.d/ccagent; chmod 440 /etc/sudoers.d/ccagent
visudo -cf /etc/sudoers.d/ccagent >/dev/null
# RAPL counters are root-only on newer kernels: make readable at boot
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
systemctl daemon-reload; systemctl enable --now ccagent.service
sleep 2; systemctl is-active ccagent.service
echo "ccagent installed. The Control Center connects over SSH (port 22) and will mark this unit online within a poll interval."
`;
}
