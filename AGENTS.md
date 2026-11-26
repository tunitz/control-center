# AGENTS.md — Control Center

## Project

Control Center is a dark-first dashboard for monitoring and controlling Linux units over SSH via a small bash agent (`agent/`).

- **Server**: Bun 1.4, SQLite (WAL), single admin account (`argon2id`), `ssh2` client (`apps/server/`).
- **Web UI**: React 18 + Vite + uPlot static bundle (`apps/web/`), served by the Bun server.
- **Agent**: Self-contained bash installer and dedicated key-only `sshd` setup (`agent/`).

## Repository map

| Path | Purpose |
| --- | --- |
| `apps/server/` | Bun HTTP/SSE server, SQLite schema/queries, SSH poller, backups, power/service routes. |
| `apps/web/` | React + uPlot frontend built into `apps/web/dist/`. |
| `agent/` | Bash agent scripts embedded into unit installers. |
| `docs/` | Installation, operations, API, development, and troubleshooting documentation. |
| `deploy/` | Deployment guide. |
| `Dockerfile`, `compose.yaml`, `compose.build.yaml` | Minimal `oven/bun:1.4-alpine` container image and Compose deployment pulling `ghcr.io/tunitz/control-center`. |

## Local development and verification

```bash
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build:web
bun run build:server:bundle   # minimal bundled JS for container runtime
bun run build                # web bundle + compiled binary in dist/control-center
```

Never commit `.env`, `data/`, `*.db*`, `dist/`, or `apps/web/dist/`.

## Docker, CI & Releases

- **`compose.yaml`** pulls `ghcr.io/tunitz/control-center:${IMAGE_TAG:-latest}` with `network_mode: host` (needed for Wake-on-LAN broadcasts and LAN unit access).
- **`compose.build.yaml`** overrides the image to build locally: `docker compose -f compose.yaml -f compose.build.yaml up -d --build`.
- **`.github/workflows/ci.yml`** runs typecheck, tests, web/server bundle build, and a non-pushing Docker build check on PRs to `main`.
- **`.github/workflows/release.yml`** runs Release Please on `main` pushes, publishes `ghcr.io/tunitz/control-center` (`linux/amd64`) to GHCR, and attaches cross-compiled Bun release archives (`linux-x64`, `darwin-arm64`, `windows-x64`) + `SHA256SUMS.txt` on release creation.

## Git & Branching Rules (Mandatory)

1. **Never commit or push directly to `main`.** All changes must go through a feature branch and Pull Request.
2. **Pull `main` first** before starting any work:
   ```bash
   git checkout main && git pull --ff-only origin main
   ```
3. **Create a `feature/<name>` branch** for all changes (e.g., `feature/add-alert-mute`), and push only `feature/<name>`.
4. **Use Conventional Commits** (`feat:`, `fix:`, `chore:`, `docs:`, `feat!:`) so Release Please auto-versions releases accurately.
