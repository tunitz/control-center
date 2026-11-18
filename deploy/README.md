# Deployment guide

The primary production runtime is the Bun-compiled executable `dist/control-center` plus the static web bundle in `apps/web/dist`. The executable does not embed the web UI or the agent scripts; both are read from disk at request time. Docker is optional (see the end).

## Directory layout

The tracked systemd unit uses `%h` (the service user's home) so it contains no machine-specific paths. Install everything under `<INSTALL_DIR>`, which the unit expects to be `%h/control-center`:

```text
%h/control-center/
├── .env                     # secrets: CC_MASTER_KEY and one of CC_ADMIN_PASSWORD / CC_BOOTSTRAP_TOKEN
├── dist/control-center      # compiled server binary (git-ignored)
├── apps/web/dist/           # built web bundle (git-ignored)
├── agent/                   # agent installer sources (not a build output)
├── data/cc.db               # SQLite data (git-ignored)
└── deploy/systemd/control-center.service
```

Create the data directory and make it writable by the service user. Keep `.env` and `data/` out of version control.

## Build

```bash
cd <INSTALL_DIR>
systemctl --user stop control-center   # if already running
bun run build                          # build:web + build:server
systemctl --user start control-center
```

Stop the service before rebuilding: overwriting a running executable fails with `ETXTBSY`. Both build outputs are git-ignored. The `agent/` directory must be present because installers are generated from its scripts.

## Configuration

The compiled binary does not auto-load `.env`, so the systemd unit supplies secrets with `EnvironmentFile=` and non-secret paths with `Environment=`. Set at least:

```dotenv
# <INSTALL_DIR>/.env
CC_MASTER_KEY='<persistent master key>'
CC_ADMIN_PASSWORD='<admin password>'
HOST=127.0.0.1
PORT=3030
```

`CC_MASTER_KEY` must be stable across restarts and is required outside local development. Back it up separately; it is never included in database backups. Use `CC_BOOTSTRAP_TOKEN` instead of `CC_ADMIN_PASSWORD` to set the password through the first-run form. See [installation](../docs/installation.md) for the full variable reference and [operations](../docs/operations.md#backup-and-restore) for backup requirements.

Bind to loopback (`HOST=127.0.0.1`) and terminate TLS at a reverse proxy when exposing the dashboard beyond a trusted network.

## Install the service

The tracked definition is `deploy/systemd/control-center.service`. Install it as a **user** unit for the service user and reload systemd:

```bash
mkdir -p ~/.config/systemd/user
ln -sfn <INSTALL_DIR>/deploy/systemd/control-center.service \
  ~/.config/systemd/user/control-center.service
systemctl --user daemon-reload
systemctl --user enable --now control-center
systemctl --user status control-center
```

The unit sets `WorkingDirectory`, `EnvironmentFile`, `PATH`, and the three path variables (`CC_DATA`, `CC_WEB`, `CC_AGENT_DIR`) relative to `%h`, matching the layout above. If you install under a different directory, update those `%h`-relative lines in a local copy of the unit.

Service control:

```bash
systemctl --user restart control-center
systemctl --user stop control-center
journalctl --user -u control-center -f
```

## Optional: Docker

The image builds the web bundle and runs the server with `CC_DATA=/data`. Keep `CC_MASTER_KEY` in `.env` and use the provided compose file, which mounts a named volume at `/data` and uses host network mode so wake-on-LAN broadcasts reach the LAN:

```bash
docker compose up -d --build
```

Docker is an alternative to the compiled binary, not the default. The compiled binary avoids a container layer and is the recommended production path.
