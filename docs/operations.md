# Operations

## Units

### Add a unit

1. Dashboard → **Add unit**: enter a name, host/IP, optional MAC and broadcast address for wake-on-LAN, and the sampling interval. A unique ed25519 key pair is generated; the private half is encrypted with `CC_MASTER_KEY` on the server.
2. The installer view opens immediately. Choose an installer:
   - **Short command** — downloads the generic installer from the public agent repository (no login, no secrets) and passes this unit's public key. The unit needs internet access, not access to the Control Center.
   - **Offline paste** — a single command that embeds the whole installer; use it when the unit has no internet.
   - **Download installer** — saves an installer script with the unit's key embedded; copy it to the unit.
   - Toggle **With sudo / No sudo** to match the unit (root shells and Proxmox-style hosts have no `sudo`).
3. Run the command on the unit as root. The unit reaches online within one poll interval.

If `CC_PUBLIC_IP` is set, the authorized key is restricted with `from="<ip>"` so only that source address can use it.

The installer creates the `ccagent` user, installs `/opt/ccagent/{ccagent.sh,ccagent-gate,ccagent-power,ccagent-svc,uninstall.sh}`, writes `/etc/ccagent.conf`, authorizes the key with a forced command, and configures a dedicated key-only sshd on port 62478 (system sshd on port 22 is untouched). Power and service actions run through root-owned systemd path units, so no sudo is needed on the unit. Results are published through a root helper into `/run/ccagent` (owned by `ccagent`); the firewall backend used is recorded in `/etc/ccagent/firewall.json` so uninstall can reverse it.

### Reinstall a unit

Use **Reinstall** in the unit's Diagnostics panel to regenerate and copy the installer. Reinstall when the agent is missing, after a key rotation, or as the first step of a port migration. The public key and fingerprint are shown alongside the installer.

Rotating the key (**Rotate key**) generates a new key pair and drops the pooled connection; re-run the installer on the unit so the new public key is authorized.

### Legacy port migration

Units installed on port 22 are **not** migrated automatically. After an upgrade they are flagged `migration_pending_port` and stay offline until handled manually:

1. **Reinstall** the agent on the unit using the generated command (targets the dedicated port, never port 22).
2. **Finish migration** in the unit's Diagnostics panel. This clears the pending port, records the dedicated port, clears the last error, and reconnects on the next poll.

Both steps are required; the unit remains offline between them. See [troubleshooting](troubleshooting.md#service-sync-drift) if it stays offline after migration.

### Edit a unit

Unit page → **Power** menu → **Edit IP / MAC**: change name, host/IP, SSH port, MAC and broadcast address. Changing the host or port reconnects immediately and keeps history and the SSH key, so the agent does not need reinstalling. Invalid input leaves the unit unchanged.

### Remove a unit

Unit page → **Power** menu → **Remove unit** (or Settings → Units → Remove). This deletes the unit, its history, energy data, and key from the Control Center, and is audit-logged. It does not touch the unit itself; run `sudo /opt/ccagent/uninstall.sh` on the unit to remove the agent, user, firewall rule, and services.

## Reconnect and diagnostics

The Diagnostics panel runs database-only checks and can contact the unit:

- **Agent reachable** — recent successful poll.
- **Fresh sample** — recent telemetry sample.
- **SSH host key pinned** — first-contact pin recorded and verified on later connections.
- **Static info** — CPU/RAM/GPU information reported.
- **Service allowlist synced** — stored changes reached the unit.
- **Dedicated SSH port in use** — no pending legacy-port migration.

**Probe** runs `info` on the agent to confirm the SSH path end to end. **Reconnect** drops the pooled connection and clears the last error so the next poll reconnects. Use these before reinstalling. The dashboard also shows the last-sample age and a stale badge for units that stopped reporting. See [troubleshooting](troubleshooting.md) for a step-by-step approach.

## Power actions

**Shutdown**, **Restart**, and **Wake** are available from the unit's Power menu. Destructive actions require confirmation. Wake-on-LAN needs a MAC address; it broadcasts to the configured broadcast address.

Responses are explicit: `accepted` means the command was sent (or the WoL packet broadcast); `delivery_unknown` means the connection was lost around the action, so the outcome cannot be confirmed. Every action is audit-logged.

## Service control

### Control Center process

Docker is the recommended production runtime:

```bash
docker compose up -d --build
docker compose logs -f control-center
docker compose restart control-center
docker compose down
```

For a compiled-binary deployment, run the executable under your host's existing process supervisor with `CC_DATA`, `CC_WEB`, and `CC_AGENT_DIR` set. The [deployment guide](../deploy/README.md) includes a generic binary invocation and an optional systemd example. Stop the process before rebuilding the executable; overwriting a running binary fails with `ETXTBSY`.

### Unit services

The Services panel works from an allowlist: only allowed services can be inspected or controlled.

- **Discover** asks the agent for candidate services of kind `systemd`, `user`, `docker`, or `lxc`.
- **Allow** replaces the stored allowlist. It is saved as unsynced and pushed to the unit; it is marked `synced` only after the agent confirms.
- **Reconcile** re-pushes the stored allowlist, for example after a reinstall or when a unit returns online.
- **Logs** and **start / stop / restart** act only on services present in the allowlist. Log lines are clamped to 1–500.

If a push fails, the API reports `needs_sync: true` and the Diagnostics panel shows a pending allowlist. Use Reconcile to clear it. See [troubleshooting](troubleshooting.md#service-sync-drift).

## Alerts and maintenance windows

Alerts are evaluated every minute for enabled units:

- **offline** — no successful poll in the expected window (enabled by default).
- **stale** — no recent telemetry sample while the unit is reachable (enabled by default).
- **disk** — a mount at or above a threshold (default 90%); opt-in per unit.

Active alerts appear on the dashboard. Rules are managed per unit in Settings (enable/disable and disk threshold, 1–100). Maintenance windows suppress alerts for selected weekdays and a minute range, either fleet-wide or for one unit; windows whose end minute is earlier than the start wrap past midnight. Times use Asia/Manila local time. See [data and cost](data-and-cost.md#manila-day-boundaries).

## Backup and restore

Backups are consistent SQLite snapshots (`VACUUM INTO`) with a small manifest, and can be downloaded from Settings or `GET /api/backup`.

- The master key is **never** included in a backup. A restore requires the same `CC_MASTER_KEY` to decrypt stored unit SSH keys; keep it in a separate, durable location.
- Restore is transactional and keeps the database connection open. It replaces the tables present in the backup and reports the table count.
- The manifest records a schema version; a backup from an incompatible version is rejected. Restore expects a genuine Control Center `.db` backup with the `backup_meta` table.
- The `masterKeyRequired` flag is returned by both the backup status and restore endpoints; the UI repeats the warning.

Back up before upgrades and before any migration test. Record the master-key custodian and an operator contact (`<ADMIN_EMAIL>`) in your runbook.

## Audit log

Settings → Audit (or `GET /api/audit`) shows the most recent entries, newest first: logins and failures, setup, password changes, unit add/update/delete/reconnect/rekey, power actions (including failed and unknown delivery), rate and settings changes, service allowlist changes, alert rule and maintenance-window changes, backup creation and restore, and wall samples. The default read limit is 100 (maximum 500); audit rows are retained for one year.

Continue with the [API reference](api.md) and [troubleshooting](troubleshooting.md).
