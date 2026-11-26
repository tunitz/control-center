---
name: control-center-project
description: "Contributor runbook for the Control Center project: build, test, agent releases, service control, migrations and documentation. Load when changing or operating it."
license: MIT
platforms: [linux]
---

# Control Center contributor runbook

This repo-committed skill is a short index, not the source of truth. Canonical documentation:

- `README.md` — overview and entry point
- `docs/installation.md` — install and first-run setup
- `docs/operations.md` — service control, backups and day-to-day operation
- `docs/api.md` — HTTP API
- `docs/development.md` — build, test, web and mobile-width verification
- `docs/troubleshooting.md` — diagnosis and recovery

Mobile routing: general browser and mobile-width checks are in `docs/development.md`; iOS Home Screen swipe-back is in `references/mobile-swipe-back.md`.

Read the relevant doc before changing code. Keep this runbook limited to facts that are easy to miss.

## What it is

A Bun + SQLite dashboard that monitors remote Linux units over SSH. Each unit runs a small agent that reports CPU, RAM, disk and power metrics. The dashboard connects out to units, so units need no inbound access to it. The server serves the web bundle from `apps/web/dist`; state lives in the configured data directory (`CC_DATA`).

## Build and test

From the repo root:

```bash
bun test apps/server apps/web/src   # server and web unit tests
bun run typecheck                   # server and web type checks
bun run build                       # web bundle + compiled server
bash tools/test_all.sh              # tests, typecheck and agent shell syntax
bun run build:web                   # web bundle only
```

The server reads `apps/web/dist`, so rebuild the web bundle after every web change. Read the actual pass/fail counts from each run before reporting a result; a truncated pipe or a bare exit code is not evidence.

## Agent release flow

The installer is published on a separate public agent repo. Changes under `agent/` only reach units through a new release.

1. Sync `agent/*` to the public agent repo (`<owner>/<repo>`) and commit there.
2. Run `bash tools/release.sh vX.Y.Z` with `GITHUB_TOKEN` supplied through the environment. Never hardcode, echo or print the token.
3. Verify the pinned tag URL (`releases/download/vX.Y.Z/install-ccagent.sh`) serves the new installer, then check the `latest` URL. The `latest` redirect can serve the previous release for a few minutes after publishing; if it is still stale, hand out the pinned-tag command instead.
4. Existing units pick up a new helper only when the installer is re-run. A unit reachable as root can take a new helper by hand (see `references/service-control.md`); new units use the installer.

The offline copy-paste installer is capped at `18000` bytes by `apps/server/src/install.test.ts`. If helper or installer code crosses the cap, decide explicitly whether to trim the script or raise the limit; do not bump the number silently.

## Service control

Per-unit services (systemd, Docker, LXC and per-user systemd units) are managed from the unit page only. Full design and testing procedure: `references/service-control.md`.

Key facts:

- Gate verbs: `svc-list`, `svc-discover`, `svc-act`, `svc-logs`, `svc-allow`.
- Requests are files under `/var/lib/ccagent`; a systemd path unit starts the root helper.
- Results live in a `ccagent`-owned `/run/ccagent` and are published with `O_EXCL|O_NOFOLLOW` and `fchown` on the helper's own verified file descriptor.
- The helper validates argv, the allowlist and protected units, and resolves user services through `loginctl`/`runuser`. The gate waits for the result, deletes it and exits `0` (ok) or `3` (failure).
- The installer writes an ownership manifest at `/etc/ccagent/firewall.json` and discovers the nftables input chain from the live ruleset (any family/table) instead of hard-coding `inet filter`.
- Never build a shell string from request fields, and never use `pkill -f` patterns — the pattern matches the shell running it. Record a PID and kill that PID.

## Migrations and schema changes

- Schema changes must be additive (`CREATE TABLE IF NOT EXISTS`); the database is the only copy of unit data and history.
- Back up the database before a deploy that can change it, so a bad migration can be rolled back.
- Update every explicit column list for a changed table (INSERT lists, SELECT lists and row mappers). A blanket replace also adds the column to INSERTs that do not set it.
- Add a migration test that builds the old table with rows, opens it through `openDb`, reads the new column's default, writes to it and reopens. A fresh-database test alone does not prove an additive migration.
- Literal strings cast into a typed union need `as const`, or typecheck fails.

## Throwaway instance

Use `references/test-instance.md` for UI or API checks against a disposable server (scratch `CC_DATA`, `CC_NO_POLL=1`, throwaway `CC_ADMIN_PASSWORD` and `CC_MASTER_KEY`, spare port). Check the real API JSON as well as the rendered UI, and stop the process by PID before reporting done. Never use live credentials or print secrets.

## Security invariants

- Never print `.env` contents or secrets. Pass tokens into files file-to-file inside a script; tool output can mask bearer-like strings, so verify by length or a prefix count rather than by reading the value back.
- Use throwaway credentials and a scratch data directory for tests.
- Root helpers accept argv only, re-validate everything, and must hand result files to the gate user with a verified `fchown`.
- Protected units (`ccagent*`, `ssh`, `sshd`) are never controllable.
- Do not use pattern-based process killing; kill by recorded PID and confirm the listener is gone.

## Docs check

Run `bash tools/check_docs.sh` before committing documentation or skill changes. It flags stale/personal markers and broken relative Markdown links, and must print `docs check ok`.
