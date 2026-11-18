# Control Center production deployment

The production runtime is the Bun-compiled executable `dist/control-center` plus the
Vite bundle in `apps/web/dist`. The executable does **not** embed the web UI or the
agent scripts: both are read from disk at request time.

## Build

```bash
cd /home/tunitz/projects/control-center
systemctl --user stop control-center
bun run build            # build:web (apps/web/dist) + build:server (dist/control-center)
systemctl --user start control-center
```

Stop the service before rebuilding. The service runs the ELF at
`dist/control-center`; overwriting a running executable fails with `ETXTBSY`.
Both build outputs are git-ignored.

## Runtime

- `WorkingDirectory=/home/tunitz/projects/control-center`
- `EnvironmentFile=.../.env` supplies `HOST`, `PORT` and the secrets.
- `CC_DATA=.../data` (SQLite, git-ignored)
- `CC_WEB=.../apps/web/dist`
- `CC_AGENT_DIR=.../agent` (installer sources, not build output)
- The compiled binary does not auto-load `.env`; systemd provides it.

## Service unit

The tracked definition is `deploy/systemd/control-center.service`. Install it as a
user unit and reload systemd:

```bash
ln -sfn /home/tunitz/projects/control-center/deploy/systemd/control-center.service \
  ~/.config/systemd/user/control-center.service
systemctl --user daemon-reload
systemctl --user restart control-center
```

Do not commit `dist/`, `apps/web/dist/`, `data/`, or `.env`.
