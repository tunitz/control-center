# Development

## Test, typecheck, and build

```bash
bun test apps/server apps/web/src   # unit and integration tests
bun run typecheck                    # server + web TypeScript
bun run build                        # web bundle + compiled server
```

`tools/test_all.sh` runs the tests, typecheck, and agent shell syntax checks (`bash -n`) in one command. Run it before finishing a change.

```bash
bash tools/test_all.sh
```

Build outputs (`dist/`, `apps/web/dist/`) and the database (`data/`) are git-ignored.

## Seed data for local verification

`tools/seed-demo.ts` creates a throwaway database with synthetic units and history for screenshots and scale tests. It is never used in production.

```bash
bun tools/seed-demo.ts <demo.db> <units> <hours> <step_seconds>
```

Run a throwaway server against it with `CC_NO_POLL=1` and a scratch data directory. Never point verification tooling at production data.

## Browser verification

When changing UI or endpoints, verify against a throwaway instance at narrow (320px) and typical (390px) mobile widths:

- no horizontal overflow or clipped controls;
- dialogs and menus are keyboard accessible (Escape dismiss, focus placement, arrow-key navigation) and stay open across live polling re-renders;
- labels, chart summaries, last-sample age, energy table, diagnostics, alerts, and backup panels render from real endpoint responses rather than inferred helpers;
- no console errors.

Confirm endpoint fields in the actual JSON before relying on them in a test.

## Additive migrations

Schema changes must be additive so an existing database upgrades in place. Add new columns and tables with idempotent guards in `apps/server/src/db.ts` (for example, check `PRAGMA table_info` before `ALTER TABLE`). Never change the meaning of an existing column in place.

When the **set of tables** changes incompatibly, bump `SCHEMA_VERSION` in `apps/server/src/backup.ts`; restores reject backups whose manifest version does not match. Backward-compatible column additions do not require a version bump because restore copies only shared columns.

Verify a migration against a **copy** of a populated database with WAL/SHM files, confirming row counts are preserved. Never migrate the live database as part of a code change.

## Agent release process

The public agent repository is separate from this project. Only the generic installer is published there; it contains no secrets.

1. Copy any changed files from `agent/*` into the public agent repository (set as `<AGENT_REPO>`) and commit them there.
2. Publish a release with the token available to maintainers:

   ```bash
   REPO='<AGENT_REPO>' bash tools/release.sh vX.Y.Z
   ```

   Export `GITHUB_TOKEN` in the environment before running the script; never put the token in the command line. This builds `dist/install-ccagent.sh` and uploads it as a release asset.
3. Verify both URLs: the pinned `releases/download/vX.Y.Z/install-ccagent.sh` and the moving `releases/latest/download/install-ccagent.sh` point at the new asset. With `CC_AGENT_TAG` unset the short installer follows `latest`; set it to a tag to pin.

Units download the installer anonymously, so never put secrets in it.

## Documentation check

All documentation lives in `README.md`, `docs/`, and `deploy/`. Run the docs check before finishing a documentation change:

```bash
bash tools/check_docs.sh
```

Keep relative links between documents, use placeholders rather than real hosts or paths, and do not document unused environment variables or unsupported features. See [installation](installation.md) for the environment reference and [operations](operations.md) for operator workflows.
