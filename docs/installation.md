# Installation

## Requirements

- Bun 1.4 or newer (server runtime and build tool).
- Linux host for the Control Center; units are Linux hosts reachable by SSH from it.
- A persistent, secret `CC_MASTER_KEY` (any long random string).
- Outbound SSH from the Control Center to unit port 62478 (or a custom dedicated port). Units do not need inbound access to the Control Center.

## Environment variables

Set secrets in a `.env` file or in the process environment. The compiled binary does not auto-load `.env`; supply it through the service manager (see below).

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3030` | HTTP listen port. |
| `HOST` | `0.0.0.0` | Listen address. Use `127.0.0.1` behind a reverse proxy. |
| `CC_DATA` | `<source>/data` | Directory for `cc.db` (SQLite). Set an absolute path for compiled-binary and container deployments. |
| `CC_WEB` | `<source>/apps/web/dist` | Built web assets. Set an absolute path for compiled-binary and container deployments. |
| `CC_AGENT_DIR` | `<source>/agent` | Agent scripts used to build installers (not a build output). Set an absolute path for compiled-binary and container deployments. |
| `CC_MASTER_KEY` | required outside local dev | Encrypts per-unit SSH private keys at rest. Keep it stable across restarts and backups. |
| `CC_ADMIN_PASSWORD` | unset | If set, seeds the admin password on an empty database. Otherwise use first-run setup with `CC_BOOTSTRAP_TOKEN`. |
| `CC_BOOTSTRAP_TOKEN` | unset | One-time secret (min 8 characters) that authorizes the first-run setup form. Consumed after setup. |
| `CC_POLL_INTERVAL` | `5` | Initial poll interval in seconds; editable later in Settings. |
| `CC_PUBLIC_IP` | unset | If set, the authorized key on units is restricted with `from="<ip>"` to this source address. |
| `CC_AGENT_REPO` | project public agent repo | Repository in `owner/name` form used to build the short curl installer URL. Override with your own fork, for example `<AGENT_REPO>`. |
| `CC_AGENT_TAG` | `latest` | Release tag for the curl installer; pin a specific tag for reproducibility. |
| `NODE_ENV` | unset | Set to `production` for normal deployments. |
| `CC_DEV_KEY` | unset | `1` enables local-development mode (a built-in dev master key and loopback setup without a bootstrap token). Never use in production. |
| `CC_NO_POLL` | unset | `1` disables starting the poller (useful for tests and seeding). |

The dashboard derives links from the incoming request; there is no separate public-URL setting.

## First-run setup

The admin account uses a single password. One of the following must be true:

1. Seed a password: set `CC_ADMIN_PASSWORD` before the first start. The hash is created on an empty database only; later changes are made in Settings.
2. Use a bootstrap token: leave `CC_ADMIN_PASSWORD` unset and set `CC_BOOTSTRAP_TOKEN` (min 8 characters). The dashboard shows a setup form; enter the token and the new admin password. The token is hashed on storage and cleared after setup.

Passwords must be at least 8 characters. Changing the admin password revokes all active sessions.
Without a seeded password or a bootstrap token, setup is only possible from loopback in local-development mode (`NODE_ENV` not `production` and `CC_DEV_KEY=1`).

## Run from source

```bash
bun install
bun run build:web
CC_MASTER_KEY='<long random string>' \
CC_BOOTSTRAP_TOKEN='<at least 8 characters>' \
bun run start
```

Source runs use relative defaults (`./data`, `apps/web/dist`, `agent`). Override them with `CC_DATA`, `CC_WEB`, and `CC_AGENT_DIR` if you run from another directory.

## Compiled binary

Build the web bundle first, then the executable:

```bash
bun run build:web
bun run build:server
```

`build:server` writes `dist/control-center` (git-ignored). The executable does not embed the web UI or the agent scripts, and it does not auto-load `.env`. Set all three path variables explicitly:

```bash
CC_MASTER_KEY='<persistent master key>' \
CC_ADMIN_PASSWORD='<admin password>' \
HOST=127.0.0.1 \
CC_DATA=<INSTALL_DIR>/data \
CC_WEB=<INSTALL_DIR>/apps/web/dist \
CC_AGENT_DIR=<INSTALL_DIR>/agent \
<INSTALL_DIR>/dist/control-center
```

Bun resolves `import.meta.dir` inside the compiled binary to an internal virtual root, so source-run path defaults do not apply to the executable. Run the binary under your host's existing process supervisor; see the [deployment guide](../deploy/README.md) for Docker and compiled-binary options.

## Optional: Docker

The image builds the web bundle and runs the server with `CC_DATA=/data`. Keep `CC_MASTER_KEY` in `.env` and mount a named volume for `/data`:

```bash
# .env (never commit)
CC_MASTER_KEY='<persistent master key>'
```

```bash
docker compose up -d --build
```

The compose file uses host network mode so wake-on-LAN broadcasts reach the LAN and units are reachable by IP. To run on a conventional bridge network, set `HOST` and `PORT` accordingly and ensure outbound SSH to unit port 62478. A container needs the web bundle and agent scripts present in the image (the Dockerfile builds them in), but data must live in the mounted volume.

For production deployments the compiled binary is the primary path; Docker is optional. Continue with [operations](operations.md).
