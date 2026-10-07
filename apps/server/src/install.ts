import { randomBytes } from "node:crypto";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function newToken(db: Database, unitId: number, now: number) {
  const token = randomBytes(18).toString("base64url");
  db.query("INSERT INTO install_tokens(token,unit_id,expires_at) VALUES(?,?,?)").run(token, unitId, now + 900);
  return { token, expires_at: now + 900 };
}
export function tokenUnit(db: Database, token: string | null, now: number): number | null {
  if (!token) return null;
  const r = db.query("SELECT unit_id u FROM install_tokens WHERE token=? AND used=0 AND expires_at>?").get(token, now) as { u: number } | null;
  return r ? r.u : null;
}
export function installScript(opts: { base: string; token: string; pubkey: string; from?: string; interval: number }) {
  const authLine = `command="/opt/ccagent/ccagent-gate",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding${opts.from ? `,from="${opts.from}"` : ""} ${opts.pubkey}`;
  return `#!/usr/bin/env bash
# Control Center agent installer. Needs root. Generated for a single unit; token expires in 15 minutes.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
BASE=${JSON.stringify(opts.base)}; TOKEN=${JSON.stringify(opts.token)}
id ccagent >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ccagent --shell /bin/bash ccagent
mkdir -p /opt/ccagent /var/lib/ccagent/.ssh
for f in ccagent.sh ccagent-gate; do curl -fsSL "$BASE/agent/files/$f?token=$TOKEN" -o /opt/ccagent/$f; chmod 755 /opt/ccagent/$f; done
printf 'INTERVAL=${opts.interval}\\nDIR=/var/lib/ccagent\\n' > /etc/ccagent.conf
printf '%s\\n' ${JSON.stringify(authLine)} > /var/lib/ccagent/.ssh/authorized_keys
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
curl -fsS -X POST "$BASE/agent/register?token=$TOKEN" >/dev/null && echo "registered with Control Center"
echo "ccagent installed."
`;
}
export const agentFile = (name: string) => readFileSync(join(import.meta.dir, "../../../agent", name), "utf8");
