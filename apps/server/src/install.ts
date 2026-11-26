import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const isCompiled = import.meta.dir.startsWith("/$bunfs") || /^[A-Za-z]:[\\/]+~BUN/i.test(import.meta.dir);
const agentBaseDir = isCompiled ? dirname(process.execPath) : join(import.meta.dir, "../../..");

export const agentFile = (name: string) =>
  readFileSync(join(process.env.CC_AGENT_DIR ?? join(agentBaseDir, "agent"), name), "utf8");
const slim = (src: string) => src.split("\n").filter((l, i) => i === 0 || (l.trim() !== "" && !/^\s*#/.test(l))).join("\n") + "\n";
const b64 = (name: string) => (Buffer.from(slim(agentFile(name))).toString("base64").match(/.{1,76}/g) ?? []).join("\n");

export const DEFAULT_SSH_PORT = 62478;
const validateSshPort = (port: number) => {
  if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 22)
    throw new Error("invalid ssh port: expected an integer in 1..65535 other than 22");
  return port;
};

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
 * An optional sshPort is passed as $3 (with the default interval as $2); omitting it keeps the legacy command byte-for-byte.
 */
export function curlCommand(o: { repo: string; tag: string; pubkey: string; sudo?: boolean; sshPort?: number; interval?: number }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo)) throw new Error("invalid repo");
  if (!/^[\w.-]+$/.test(o.tag)) throw new Error("invalid tag");
  // Any printable OpenSSH comment is valid; the key blob itself is base64 and the whole
  // value is single-quoted, so no shell metacharacter can escape.
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+( [^\n']*)?$/.test(o.pubkey)) throw new Error("invalid public key");
  const base = o.tag === "latest" ? "releases/latest/download" : `releases/download/${o.tag}`;
  const interval = o.interval ?? 5;
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) throw new Error("invalid interval");
  // $1 is the key, $2 the interval, $3 the dedicated SSH port.
  const args = o.sshPort === undefined ? "" : ` ${interval} ${validateSshPort(o.sshPort)}`;
  return `curl -fsSL https://github.com/${o.repo}/${base}/install-ccagent.sh | ${o.sudo === false ? "" : "sudo "}bash -s -- '${o.pubkey}'${args}`;
}

/**
 * Self-contained installer: the agent files are embedded, so the unit never has to reach the Control Center.
 * With `pubkey` baked in it is a per-unit script; without it, it takes the public key as $1 (release asset).
 * Control Center SSH uses a dedicated sshd on a non-standard port; the system sshd on 22 is never touched.
 */
export function installScript(opts: { pubkey?: string; from?: string; interval: number; sshPort?: number }) {
  if (!Number.isInteger(opts.interval) || opts.interval < 1 || opts.interval > 3600) throw new Error("invalid sampling interval");
  const sshPort = opts.sshPort === undefined ? DEFAULT_SSH_PORT : validateSshPort(opts.sshPort);
  // raw (quoted heredoc) embedding compresses far better inside the gzip'd one-liner than base64 does
  if (opts.from && !/^[\d.]+$/.test(opts.from)) throw new Error("invalid source IP");
  const fromOpt = opts.from ? `,from=\\"${opts.from}\\"` : "";
  const keyLine = opts.pubkey
    ? `PUBKEY=${JSON.stringify(opts.pubkey)}
PORT="$SSH_PORT"`
    : `PUBKEY="\${1:-}"
INTERVAL="\${2:-${opts.interval}}"
PORT="\${3:-\${CCAGENT_SSH_PORT:-${sshPort}}}"
[ -n "$PUBKEY" ] || { echo "usage: sudo bash $0 '<ssh-ed25519 public key from the Control Center>' [interval_s] [ssh_port]"; exit 1; }`;
  return `#!/usr/bin/env bash
# Control Center agent installer (self-contained, no network access to the Control Center needed). Run as root.
AGENT_VERSION=2
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root (sudo)"; exit 1; }
SSH_PORT=${sshPort}
INTERVAL=${opts.interval}
${keyLine}
case "$PORT" in
  ''|*[!0-9]*) echo "ERROR: invalid SSH port '$PORT' (expected an integer 1..65535 other than 22)." >&2; exit 1;;
esac
{ [ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] && [ "$PORT" -ne 22 ]; } || { echo "ERROR: invalid SSH port '$PORT' (expected an integer 1..65535 other than 22)." >&2; exit 1; }

# --- firewall preflight: detect active backends BEFORE creating the user or writing any config ---
FW_UFW=0
FW_FIREDALD=0
FW_NFT=0
FW_NFT_FAMILY=""; FW_NFT_TABLE=""; FW_NFT_CHAIN=""
FW_IPTABLES=0
# First active backend wins: ufw/firewalld may use nftables or iptables internally,
# so treat their nft/iptables rules as part of that backend, not as separate firewalls.
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then
  FW_UFW=1
elif command -v firewall-cmd >/dev/null 2>&1 && [ "$(firewall-cmd --state 2>/dev/null)" = "running" ]; then
  FW_FIREDALD=1
elif command -v nft >/dev/null 2>&1 && [ -n "$(nft list ruleset 2>/dev/null)" ]; then
  FW_NFT=1
  # Use whichever chain already hooks input. Hard-coding 'inet filter input' broke
  # hosts using ip/ip6 or a custom table name. Parse the ruleset for a filter hook.
  NFT_SPEC=$(nft -a list ruleset 2>/dev/null | awk '
    /^table / { fam=$2; tbl=$3; sub(/\{/,"",tbl); next }
    /^[[:space:]]*chain / { ch=$2; sub(/\{/,"",ch); next }
    /hook input/ { print fam " " tbl " " ch; exit }
  ')
  if [ -n "$NFT_SPEC" ]; then
    set -- $NFT_SPEC; FW_NFT_FAMILY=$1; FW_NFT_TABLE=$2; FW_NFT_CHAIN=$3
  else
    # No input hook at all: a fresh accept-policy chain cannot weaken anything.
    FW_NFT_FAMILY=inet; FW_NFT_TABLE=filter; FW_NFT_CHAIN=input
    nft add table inet filter 2>/dev/null || true
    nft add chain inet filter input '{ type filter hook input priority 0; policy accept; }' 2>/dev/null || true
    if ! nft list chain inet filter input >/dev/null 2>&1; then
      echo "ERROR: could not create an nftables input chain for port $PORT." >&2
      echo "Create one manually, then re-run the installer:" >&2
      echo "  nft add table inet filter" >&2
      echo "  nft add chain inet filter input '{ type filter hook input priority 0; policy accept; }'" >&2
      exit 1
    fi
  fi
elif command -v iptables >/dev/null 2>&1 && iptables -S INPUT >/dev/null 2>&1; then
  FW_IPTABLES=1
fi

# --- sshd preflight: make sure an sshd binary and host keys exist ---
SSHD_BIN="$(command -v sshd 2>/dev/null || true)"
if [ -z "$SSHD_BIN" ] && [ -x /usr/sbin/sshd ]; then SSHD_BIN=/usr/sbin/sshd; fi
if [ -z "$SSHD_BIN" ]; then
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update -y
    DEBIAN_FRONTEND=noninteractive apt-get install -y openssh-server
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y openssh-server
  elif command -v yum >/dev/null 2>&1; then
    yum install -y openssh-server
  else
    echo "ERROR: sshd not found and no supported package manager (apt-get/dnf/yum) to install openssh-server." >&2
    exit 1
  fi
  SSHD_BIN="$(command -v sshd 2>/dev/null || true)"
  if [ -z "$SSHD_BIN" ] && [ -x /usr/sbin/sshd ]; then SSHD_BIN=/usr/sbin/sshd; fi
  [ -x "$SSHD_BIN" ] || { echo "ERROR: openssh-server installed but the sshd binary is still missing." >&2; exit 1; }
fi
# Make the resolved binary callable as "sshd" too (e.g. /usr/sbin is not on PATH).
case ":$PATH:" in
  *":$(dirname "$SSHD_BIN"):"*) ;;
  *) PATH="$(dirname "$SSHD_BIN"):$PATH"; export PATH ;;
esac
mkdir -p /run/sshd
if ! ls /etc/ssh/ssh_host_*_key >/dev/null 2>&1; then
  command -v ssh-keygen >/dev/null 2>&1 || { echo "ERROR: no SSH host keys and ssh-keygen is unavailable." >&2; exit 1; }
  ssh-keygen -A
fi

id ccagent >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/ccagent --shell /bin/bash ccagent
# useradd --system leaves the shadow password locked with '!'. With UsePAM no, sshd rejects
# locked accounts before key auth. '*' keeps password login disabled but allows the forced key.
if command -v usermod >/dev/null 2>&1; then usermod -p '*' ccagent; fi
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
printf 'INTERVAL=%s\\nDIR=/var/lib/ccagent\\nSVC_UNIT=/etc/systemd/system/ccagent-svc.path\\nRESULTS_DIR=/run/ccagent\\nSSH_PORT=%s\\n' "$INTERVAL" "$PORT" > /etc/ccagent.conf
# Results directory owned by the gate user so it can read and delete results.
# The root helper publishes results with O_EXCL|O_NOFOLLOW and fchown on its own fd.
install -d -o ccagent -g ccagent -m 0700 /run/ccagent
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
  printf 'd /run/ccagent 0700 ccagent ccagent -\\nz /sys/class/powercap/*/energy_uj 0444 - - -\\n' > /etc/tmpfiles.d/ccagent-rapl.conf
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

# --- dedicated sshd on the Control Center port: the system sshd / port 22 is never touched ---
{
  printf 'Port %s\\nListenAddress 0.0.0.0\\n' "$PORT"
  for k in /etc/ssh/ssh_host_*_key; do
    [ -f "$k" ] && printf 'HostKey %s\\n' "$k"
  done
  printf '%s\\n' \\
    'PermitRootLogin no' \\
    'AllowUsers ccagent' \\
    'PubkeyAuthentication yes' \\
    'PasswordAuthentication no' \\
    'KbdInteractiveAuthentication no' \\
    'PermitEmptyPasswords no' \\
    'AuthorizedKeysFile /var/lib/ccagent/.ssh/authorized_keys' \\
    'AllowAgentForwarding no' \\
    'AllowTcpForwarding no' \\
    'X11Forwarding no' \\
    'PermitTunnel no' \\
    'GatewayPorts no' \\
    'PermitUserEnvironment no' \\
    'UsePAM no' \\
    "PidFile /run/ccagent-sshd.pid"
} > /etc/ssh/ccagent_sshd_config
cat > /etc/systemd/system/ccagent-sshd.service <<UNIT
[Unit]
Description=Control Center dedicated SSH (port $PORT)
After=network.target
[Service]
ExecStart=$SSHD_BIN -D -e -f /etc/ssh/ccagent_sshd_config
Restart=on-failure
[Install]
WantedBy=multi-user.target
UNIT
# Validate before enabling: a bad config must not leave a failing unit behind.
sshd -t -f /etc/ssh/ccagent_sshd_config
systemctl daemon-reload
systemctl enable ccagent-sshd.service
systemctl restart ccagent-sshd.service

systemctl daemon-reload; systemctl enable ccagent.service ccagent-power.path ccagent-svc.path
systemctl restart ccagent-power.path
systemctl restart ccagent-svc.path
# restart (not just start): a re-run must replace a running agent with the freshly installed code
systemctl restart ccagent.service
sleep 2; systemctl is-active ccagent.service

# --- open the port on every active firewall backend, idempotently ---
# Every rule we add carries a stable ownership marker. The manifest lets uninstall.sh
# remove only our rules and never a same-port rule that someone else created.
FW_MARKER="ccagent-control-center-$PORT"
FW_IP6=0
if [ "$FW_UFW" = 1 ]; then
  if ! ufw status 2>/dev/null | grep -q "\${PORT}/tcp"; then
    ufw allow "\${PORT}/tcp" comment "\$FW_MARKER"
  fi
fi
if [ "$FW_FIREDALD" = 1 ]; then
  if ! firewall-cmd --query-port="\${PORT}/tcp" >/dev/null 2>&1; then
    firewall-cmd --permanent --add-port="\${PORT}/tcp"
    firewall-cmd --reload
  fi
fi
if [ "$FW_NFT" = 1 ]; then
  if ! nft list chain "\$FW_NFT_FAMILY" "\$FW_NFT_TABLE" "\$FW_NFT_CHAIN" 2>/dev/null | grep -q "\$FW_MARKER"; then
    nft add rule "\$FW_NFT_FAMILY" "\$FW_NFT_TABLE" "\$FW_NFT_CHAIN" tcp dport "\${PORT}" accept comment "\$FW_MARKER"
  fi
fi
if [ "$FW_IPTABLES" = 1 ]; then
  if ! iptables -C INPUT -p tcp --dport "$PORT" -m comment --comment "$FW_MARKER" -j ACCEPT >/dev/null 2>&1; then
    iptables -I INPUT -p tcp --dport "$PORT" -m comment --comment "$FW_MARKER" -j ACCEPT
  fi
  if command -v ip6tables >/dev/null 2>&1 && ip6tables -S INPUT >/dev/null 2>&1; then
    FW_IP6=1
    if ! ip6tables -C INPUT -p tcp --dport "$PORT" -m comment --comment "$FW_MARKER" -j ACCEPT >/dev/null 2>&1; then
      ip6tables -I INPUT -p tcp --dport "$PORT" -m comment --comment "$FW_MARKER" -j ACCEPT
    fi
  fi
  echo "NOTE: iptables rules may not persist across reboot unless your distro persists them."
fi
# Root-owned record of exactly what this installer added.
printf '{"port":%s,"marker":"%s","ufw":%s,"firewalld":%s,"nft":%s,"nft_family":"%s","nft_table":"%s","nft_chain":"%s","iptables":%s,"ip6tables":%s}\\n' \
  "$PORT" "$FW_MARKER" "$FW_UFW" "$FW_FIREDALD" "$FW_NFT" "$FW_NFT_FAMILY" "$FW_NFT_TABLE" "$FW_NFT_CHAIN" "$FW_IPTABLES" "$FW_IP6" > /etc/ccagent/firewall.json
chmod 600 /etc/ccagent/firewall.json

# --- verification ---
if ! systemctl is-active ccagent-sshd.service >/dev/null; then
  echo "ERROR: ccagent-sshd.service is not active." >&2
  exit 1
fi
PORT_CHECK_AVAILABLE=0
PORT_LISTEN=0
if command -v ss >/dev/null 2>&1; then
  PORT_CHECK_AVAILABLE=1
  ss -ltn 2>/dev/null | grep -qE "[:.]\${PORT}([[:space:]]|$)" && PORT_LISTEN=1
elif command -v netstat >/dev/null 2>&1; then
  PORT_CHECK_AVAILABLE=1
  netstat -ltn 2>/dev/null | grep -qE "[:.]\${PORT}([[:space:]]|$)" && PORT_LISTEN=1
elif [ -r /proc/net/tcp ]; then
  PORT_CHECK_AVAILABLE=1
  HEX_PORT=$(printf '%04X' "$PORT")
  grep -qiE ":\${HEX_PORT} " /proc/net/tcp /proc/net/tcp6 2>/dev/null && PORT_LISTEN=1
fi
if [ "$PORT_CHECK_AVAILABLE" = 1 ] && [ "$PORT_LISTEN" != 1 ]; then
  echo "ERROR: ccagent-sshd is not listening on port $PORT." >&2
  exit 1
fi
if [ "$PORT_CHECK_AVAILABLE" != 1 ]; then
  echo "WARNING: no listener check tool available (ss/netstat/proc/net/tcp); continuing without port verification." >&2
fi
if [ "$FW_UFW" = 1 ] && ! ufw status 2>/dev/null | grep -q "\${PORT}/tcp"; then
  echo "ERROR: ufw rule for port $PORT is missing after installation." >&2; exit 1
fi
if [ "$FW_FIREDALD" = 1 ] && ! firewall-cmd --query-port="\${PORT}/tcp" >/dev/null 2>&1; then
  echo "ERROR: firewalld rule for port $PORT is missing after installation." >&2; exit 1
fi
if [ "$FW_NFT" = 1 ] && ! nft list chain "\$FW_NFT_FAMILY" "\$FW_NFT_TABLE" "\$FW_NFT_CHAIN" 2>/dev/null | grep -q "\$FW_MARKER"; then
  echo "ERROR: nftables rule for port $PORT is missing after installation." >&2; exit 1
fi
if [ "$FW_IPTABLES" = 1 ] && ! iptables -C INPUT -p tcp --dport "$PORT" -m comment --comment "$FW_MARKER" -j ACCEPT >/dev/null 2>&1; then
  echo "ERROR: iptables rule for port $PORT is missing after installation." >&2; exit 1
fi
echo "ccagent installed. The Control Center connects over SSH (port $PORT) and will mark this unit online within a poll interval."
`;
}
