# Contributing to Control Center

Thank you for considering a contribution to Control Center!

## Prerequisites

- [Bun](https://bun.sh/) **1.4+** (use Bun rather than `npm`/`pnpm`/`yarn`).

## Local Setup

```bash
git clone https://github.com/tunitz/control-center.git
cd control-center
bun install --frozen-lockfile
bun run build:web
CC_DEV_KEY=1 CC_NO_POLL=1 bun run start
```

## Verification Checklist

Run these checks before opening a pull request:

```bash
bun run typecheck
bun test
bun run build:web
bun run build:server:bundle
bash tools/check_docs.sh
```

Always rebuild `apps/web/dist` (`bun run build:web`) after frontend changes before testing with the Bun server, and see [docs/development.md](docs/development.md) for mobile-width and UI rules.

## Branching & Commit Conventions

1. Fork the repository or create a `feature/<name>` branch off `main` (never commit directly to `main`).
2. Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`) so Release Please can generate accurate changelogs and versions.
3. Keep SQLite schema migrations additive (`CREATE TABLE IF NOT EXISTS` / column guards), never commit `.env`, `data/`, `*.db*`, `dist/`, or private hostnames/IPs/MACs, and run `bash tools/check_docs.sh` after doc edits.

Automated and AI contributors should also follow [AGENTS.md](AGENTS.md).
