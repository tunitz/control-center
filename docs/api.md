# API reference

## Conventions

- All responses are JSON unless noted. Errors are `{ "error": "..." }` with a non-2xx status.
- Public routes: `GET /api/health`, `GET /api/auth/status`, `POST /api/auth/setup`, `POST /api/auth/login`. Everything else under `/api/` requires the session cookie.
- The session cookie is `cc_session` (HttpOnly, SameSite=Strict, 7 days). Every authenticated write (`POST`, `PUT`, `PATCH`, `DELETE`) also requires the header `x-cc: 1`; missing it returns `403`. The public `setup` write requires it too; public `login` does not.
- Login and setup are rate-limited to 5 attempts per 60 seconds per client IP.
- Route parameters such as `:id` are numeric unit IDs. `:YYYY-MM` is a calendar month in the configured IANA timezone (default `UTC`).

## Health and authentication

| Method | Path | Description |
|---|---|---|
| GET | `/api/health` | Public liveness check. Returns `{ app: "control-center", ok: true }`. |
| GET | `/api/auth/status` | Public. Returns `setupNeeded`, `needsBootstrapToken`, `localSetup`, `authed`. Used by the browser to choose setup vs login. |
| POST | `/api/auth/setup` | First run only. Body `{ bootstrap_token, password }`. Requires a valid bootstrap token (or loopback in local-dev mode) and `x-cc: 1`. Clears the token, creates the session, returns `{ ok: true }` with a `set-cookie`. |
| POST | `/api/auth/login` | Body `{ password }`. Rate-limited. Returns `{ ok: true }` with a `set-cookie`; failures are audit-logged. |
| POST | `/api/auth/logout` | Destroys the session and clears the cookie. Returns `{ ok: true }`. |
| POST | `/api/auth/password` | Body `{ current, next }`. Verifies the current password, changes it, and revokes all sessions. Returns `{ ok: true }`. |

## Units

| Method | Path | Description |
|---|---|---|
| GET | `/api/units` | Lists units with their view and current-month cost. |
| POST | `/api/units` | Body `{ name, host, ssh_port?, mac?, broadcast?, sample_interval_s? }`. Generates a key pair; returns `201` with `{ id, public_key, fingerprint }`. Default SSH port is 62478. |
| GET | `/api/units/:id` | One unit view with current-month cost. |
| PATCH | `/api/units/:id` | Body with any of `name`, `host`, `ssh_port`, `mac`, `broadcast`. Invalid input returns `400` with no changes; a host change drops the pooled connection. |
| DELETE | `/api/units/:id` | Deletes the unit and all its data. Audit-logged. Returns `{ ok: true }`. |
| GET | `/api/units/:id/installer` | Installer script for the unit. Query `format=curl` (short public-repo command) or `format=paste` (self-contained one-liner); no format returns the raw script as an attachment. Query `sudo=0` omits sudo from the generated commands. Legacy port-22 units get an installer targeting the dedicated port. |
| GET | `/api/units/:id/metrics` | Query `range=1h\|6h\|12h\|24h\|7d\|30d` (default `1h`). Returns `{ range, tier, from, to, points[], summary, energy_wh }`. `tier` is `raw` for `1h`, `1m` for `6h`/`12h`/`24h`, `15m` for `7d`/`30d`. |
| POST | `/api/units/:id/rekey` | Generates a new key pair, drops the connection, and returns `{ public_key, fingerprint }`. Re-run the installer on the unit. |
| POST | `/api/units/:id/power` | Body `{ action, confirm? }`; `action` is `shutdown`, `restart`, or `wake`. Destructive actions require `confirm: true`. Returns `{ ok: true, status: "accepted", delivery, audit_id }` on success; a lost link returns `502` with `status: "delivery_unknown"`, audited as `.unknown`. `wake` needs a MAC on the unit. |
| POST | `/api/units/:id/migration-complete` | Completes a legacy port migration: sets the dedicated port, clears `migration_pending_port` and the last error, and reconnects. Returns `{ ok: true, ssh_port }`. Fails with `400` if no migration is pending. |

## Diagnostics and reconnect

| Method | Path | Description |
|---|---|---|
| GET | `/api/units/:id/diagnostic` | Returns `{ status: "ok"\|"warn"\|"error", checks[] }`. Checks cover contact, sample freshness, host-key pin, static info, service-sync state, and port migration. |
| POST | `/api/units/:id/diagnostic/probe` | Runs `info` on the agent (15s timeout). Returns `{ ok: true, detail }` or `502` with the error detail. |
| POST | `/api/units/:id/reconnect` | Drops the pooled connection and clears the last error. Returns `{ ok: true, detail }`; the next poll reconnects. |

## Unit services

Service kinds are `systemd`, `user`, `docker`, `lxc`. Names are validated; only allowed services can be inspected or controlled.

| Method | Path | Description |
|---|---|---|
| GET | `/api/units/:id/services` | Lists services currently seen on the agent. Returns `{ items[], needs_sync, error? }`; offline units return `409` with `needs_sync`. |
| GET | `/api/units/:id/services/discover` | Asks the agent for candidate services. Returns `{ items[] }`. |
| GET | `/api/units/:id/services/allow` | Returns the stored allowlist `{ items[] }`. |
| PUT | `/api/units/:id/services/allow` | Body `{ items: [{ kind, name }] }` (max 200, deduplicated). Stores as unsynced, pushes to the agent, and returns `{ ok, items, needs_sync }`. A failed push returns `502` with `needs_sync: true`. |
| POST | `/api/units/:id/services/reconcile` | Re-pushes the stored allowlist; mark-synced only on agent confirmation. Returns `{ ok, needs_sync: false }` or `502`. |
| GET | `/api/units/:id/services/{kind}/{name}/logs` | Returns `{ lines[] }` for an allowed service. Query `n` clamps to 1–500 (default 200). |
| POST | `/api/units/:id/services/{kind}/{name}/start` | Starts an allowed service. |
| POST | `/api/units/:id/services/{kind}/{name}/stop` | Stops an allowed service. |
| POST | `/api/units/:id/services/{kind}/{name}/restart` | Restarts an allowed service. |

Start/stop/restart return `{ ok: true, ...agentData }` or `502` with `{ error }`; actions are audit-logged. A service not in the allowlist returns `403`.

## Cost, energy, and rates

| Method | Path | Description |
|---|---|---|
| GET | `/api/cost` | Current-month cost. Returns `{ month, rate, timezone, currency_code, currency_symbol, total_kwh, total_cost, total_php, wall_kwh, cost_include_wall, cost_basis, units[] }`. Each unit has `{ id, name, kwh, cost, php, currency_code, currency_symbol, basis, wall_kwh }`. |
| GET | `/api/energy` | Daily energy history. Required query `from` and `to` (`YYYY-MM-DD`, inclusive, `from <= to`); optional `unitId` (omit for all units) and `format=csv`. JSON returns `[{ day, kwh, cost, php }]`. CSV returns a `day,kwh,cost` file with quoted fields. Invalid dates return `400`. |
| GET | `/api/rates` | Lists `[{ month, rate_per_kwh, php_per_kwh, set_at }]`, newest first. Reading the current month creates it by copying the previous rate (default 10). |
| PUT | `/api/rates/:YYYY-MM` | Body `{ rate_per_kwh }` (also accepts legacy `php_per_kwh`). Only the current month may be edited; past months return `400`. Returns `{ month, rate_per_kwh, php_per_kwh, currency_code, currency_symbol }`. |

## Wall power

| Method | Path | Description |
|---|---|---|
| POST | `/api/metrics/wall` | Body `{ unit_id, watts, ts? }`. `watts` must be 0–100000 and `ts` within 5 minutes of now. Returns `{ ok: true }` on success; invalid input returns `400`, unknown unit `404`. |
| GET | `/api/metrics/wall` | Query `unit_id` (required). Returns the latest live reading `{ ts, watts }`, or `{ ts: null, watts: null }` when none is recent. |

Readings are integrated into measured wall energy; see [data and cost](data-and-cost.md#wall-power-input).

## Settings, audit, and events

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Returns `{ poll_interval_s, sample_interval_s, retention_days, cost_include_wall, timezone, currency_code, currency_symbol }`. |
| PUT | `/api/settings` | Body with any of those fields. Poll interval 1–3600s, sample interval 1–3600s, retention 1–90 days, `cost_include_wall` boolean, `timezone` valid IANA zone, `currency_code` 1–8 alphanumeric chars, `currency_symbol` 1–4 chars. Returns `{ ok: true }`; the change is audit-logged. |
| GET | `/api/audit` | Query `limit` (default 100, max 500). Returns newest-first entries with a resolved unit name. |
| GET | `/api/events` | Server-Sent Events stream. Emits `hello` on connect, `ping` every 20s, and `sample` events when new data is ingested. |

## Alerts and maintenance windows

| Method | Path | Description |
|---|---|---|
| GET | `/api/alerts` | Returns `{ active[], rules[], windows[] }`. |
| PUT | `/api/alerts/:id/{offline\|stale\|disk}` | Body `{ enabled?, threshold? }`. Upserts a per-unit rule; `threshold` must be 1–100 and applies to disk alerts. Audit-logged. |
| POST | `/api/alerts/maintenance` | Body `{ days?, start_minute, end_minute, unit_id? }`. `days` is a comma-separated list of weekday numbers `0`–`6` (default all); minutes are `0`–`1439`; an omitted `unit_id` makes it fleet-wide. Audit-logged. |
| DELETE | `/api/alerts/maintenance/:id` | Removes a maintenance window. Audit-logged. |

## Backup and restore

| Method | Path | Description |
|---|---|---|
| GET | `/api/backup/status` | Returns `{ masterKeyRequired: true, schemaVersion, note }` describing the master-key separation. |
| GET | `/api/backup` | Downloads a `.db` backup (consistent snapshot plus manifest) as `application/octet-stream`. Audit-logged. |
| POST | `/api/restore` | Multipart form with field `file` containing a Control Center `.db` backup. Validates the manifest and schema version, then restores transactionally. Returns `{ ok, tables, masterKeyRequired }`; invalid files return `400`. Audit-logged. |

Restore requirements are in [operations](operations.md#backup-and-restore) and [troubleshooting](troubleshooting.md#restore-requirements).
