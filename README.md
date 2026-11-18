# Control Center

A dark-first dashboard for monitoring and controlling Linux units over SSH with a small bash agent.
The server is Bun + SQLite; the web UI is React + uPlot. There is one admin login.

## Features

- Fleet dashboard with hero cards, live power, and per-unit charts; stale samples are labelled with their age.
- Agent diagnostics (reachability, sample freshness, host-key pin, static info, service sync, port migration) plus an `info` probe and Reconnect.
- Power actions (shutdown, restart, wake-on-LAN) that report `accepted` or `delivery_unknown` honestly.
- Service allowlist per unit with a `synced` flag and explicit Reconcile; start/stop/restart and logs for allowed services.
- Alerts for offline, stale, and disk conditions with per-unit rules and maintenance windows.
- Daily energy history in Asia/Manila time with CSV export, monthly rates, and a stated cost basis.
- SQLite backup and transactional restore with master-key separation.
- Optional wall-power input and measured cost basis.
- Host-key pinning on first contact; encrypted per-unit SSH keys; session cookies, CSRF, rate limiting, and an audit log.

## Stack and scope

- Server: Bun, SQLite (WAL), single admin account (argon2id password).
- Web: React + uPlot static bundle served by the same process.
- Agent: a self-contained bash installer that sets up a dedicated, key-only sshd on TCP port 62478. The Control Center only connects outward to units; units do not need to reach it.

## Quick start

```bash
bun install
bun run build:web
CC_MASTER_KEY='<long random string>' CC_BOOTSTRAP_TOKEN='<at least 8 characters>' bun run start
```

Open `http://<this-host>:3030`. On first run, set the admin password using the bootstrap token.
See [installation](docs/installation.md) for the full environment reference, compiled-binary and Docker options, and first-run setup.

`CC_MASTER_KEY` encrypts the per-unit SSH private keys at rest. Back it up separately: losing it means re-keying every unit. See [operations](docs/operations.md#backup-and-restore).

## Add a unit

1. Dashboard → **Add unit** (name, host/IP, optional MAC for wake-on-LAN). A unique ed25519 key pair is generated; the private half is encrypted on the server.
2. Copy the installer command for that unit (short curl, offline paste, or download) from **Install** and run it on the unit.
3. The unit appears online within one poll interval.

Details, including legacy port-22 migration and unit removal, are in [operations](docs/operations.md#units).

## Documentation

- [Installation](docs/installation.md)
- [Operations](docs/operations.md)
- [API reference](docs/api.md)
- [Data and cost](docs/data-and-cost.md)
- [Development](docs/development.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Deployment guide](deploy/README.md)

## Security notes

The installer authorizes a forced-command key that can only run the read, ack, info, service-control, and power verbs. Login is rate-limited with argon2id and a HttpOnly, SameSite=Strict session cookie; all writes require the `x-cc: 1` header. Changing the admin password revokes all sessions. Serve behind TLS when exposing the dashboard beyond a trusted network.
