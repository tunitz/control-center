# Troubleshooting

Work from the dashboard's Diagnostics panel first: it shows contact, sample freshness, host-key pin, static info, service-sync, and port-migration checks, and it can probe the agent and drop a stale connection.

## Offline unit

1. Check **last-sample age** and the contact check. A recent sample with no recent contact points at the SSH path; no sample points at the agent or the log.
2. Confirm the Control Center can reach the unit on its SSH port (62478 by default) and that outbound SSH is allowed. Units do not need to reach the Control Center.
3. Run **Probe** to execute `info` on the agent. If it fails, inspect the agent on the unit: `systemctl status ccagent`, and check that `/var/lib/ccagent/metrics.jsonl` is being written and read.
4. If the host address or port changed, edit the unit (history and key are kept) or use **Reconnect** to drop the pooled connection so the next poll reconnects.
5. If the host key or agent is missing, **Reinstall** the agent with the generated installer. The first successful handshake pins the host key; a changed host key is rejected.
6. If the unit is flagged with a pending legacy port, complete the two-step [port migration](operations.md#legacy-port-migration).

A lost connection during a power action is reported as `delivery_unknown`, not a confirmed failure; check the unit's state before retrying.

## Service sync drift

The stored allowlist is not trusted until the agent confirms it. If Diagnostics reports **Service allowlist pending**, or an API response includes `needs_sync: true`:

- The unit may be offline; a push cannot complete until it is reachable.
- A reinstall clears the agent's applied state. After the unit is back online, use **Reconcile** to re-push the stored allowlist. It is marked `synced` only after confirmation.
- Lists, logs, and start/stop/restart work only for services present in the allowlist; a service outside it returns `403`.

Re-saving the allowlist with **Allow** also pushes immediately and reports the new sync state.

## nftables chain discovery

The installer does not hard-code `inet filter input`. It inspects the active firewall backend in order (ufw, firewalld, nftables, iptables) and, for nftables, discovers the chain that already hooks `input` from the ruleset, including custom table names and `ip`/`ip6` families. The chosen backend and chain are recorded in `/etc/ccagent/firewall.json` so uninstall can reverse only what the installer added.

If no input hook exists, the installer creates a fresh accept-policy `inet filter input` chain. If that fails, it stops with an error asking you to create the chain manually and re-run:

```bash
nft add table inet filter
nft add chain inet filter input '{ type filter hook input priority 0; policy accept; }'
```

Verify the discovered chain with `nft list ruleset` before re-running the installer.

## Installer failures

- **Not running as root:** the installer requires root; use `sudo` where available. Root-only and Proxmox-style hosts should use the generated **No sudo** command.
- **sshd missing:** the installer installs `openssh-server` with apt-get, dnf, or yum. On a host without a supported package manager, install sshd and generate host keys (`ssh-keygen -A`) first, then re-run.
- **Invalid SSH port:** the port must be an integer in 1–65535 other than 22. The dedicated sshd never replaces the system sshd on port 22. Legacy port-22 units use the two-step migration flow: reinstall with the generated dedicated-port installer, then use **Finish migration**.
- **No internet on the unit:** use the offline paste or downloaded installer; the short curl command needs to fetch the installer from the public agent repository.
- **Wrong key restriction:** if `CC_PUBLIC_IP` is set, the key only works from that source address. Correct it or clear the variable and reinstall.

After a successful install the unit reports online within one poll interval.

## Restore requirements

A restore fails early and clearly if:

- the uploaded file is not a Control Center backup (it must contain `backup_meta`, `units`, and `settings` tables);
- the manifest's schema version does not match the running build's `SCHEMA_VERSION`;
- the manifest is corrupt.

Restore needs the **same `CC_MASTER_KEY`** that encrypted the unit SSH keys when the backup was taken. The key is never stored in the backup. Without it, stored private keys cannot be decrypted and units must be re-keyed and reinstalled. Keep the master key in a separate, durable location and record its custodian before restoring.

Restore is transactional and keeps the running connection open; a failed restore rolls back the table replacements. Back up the current database before attempting a restore or an upgrade. See [operations](operations.md#backup-and-restore) for the backup workflow.
