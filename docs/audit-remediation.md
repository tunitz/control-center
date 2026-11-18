# Audit remediation scope

This release addresses the full-code-audit findings in four groups. Fixes are additive where they change the database schema.

## Verification (run on 2026-11-18, no deployment)

- `bun --no-env-file --no-install test apps/server apps/web/src`: **251 pass, 0 fail**.
- `bun --no-env-file --no-install run typecheck`: clean.
- `bun --no-env-file --no-install run build:web`: clean.
- Agent shell syntax (`bash -n agent/*`) and Python helper syntax (`ast.parse`): clean.

Additional checks:

- **Legacy DB**: `data/cc.db` (with WAL/SHM) was copied to a scratch backup and the
  hash verified before any migration test. A second copy of the real schema
  (3 units, 48,325 samples) was migrated: all new columns/tables appeared and all
  row counts were preserved. The original DB was never modified.
- **Throwaway instance**: source server on port 3031 with `CC_NO_POLL=1`, scratch
  data and a throwaway password. Seed unit plus mocked SSH state. Verified at
  320px and 390px: no horizontal overflow, native modal dialogs with safe-action
  focus and Escape/light dismiss, popover menu with arrow-key entry and synced
  `aria-expanded`, labelled stacked tables in narrow containers, skip link and
  route titles, chart summaries, and zero console errors. Endpoint fields
  (`sample_fresh`, `last_sample_ts`, `host_fingerprint`, `migration_pending_port`,
  `needs_sync`) were read from the real JSON, not inferred from a helper test.
- **Throwaway container**: `docker build --no-cache` then run on port 3032; health
  200 and all new markers (`text-scale`, `data-safe`, `needs_sync`, `GiB`,
  `firewall.json`, `O_NOFOLLOW`, `avail_mb`) found inside the image.
- Agent scripts synced to `tunitz/ccagent` and published as installer **v0.14.0**;
  both the pinned tag URL and `latest` were checked for the new markers.

Deployment to the live instance is intentionally not part of this change. Before
deploying, back up the live `/data/cc.db` (plus WAL/SHM) and keep the master key
separate; the additive migrations were only proven against a copy here.

1. Trust boundary: root service helper staging, authorized first-run setup, SSH host verification, session revocation, and required production secrets.
2. Data integrity: bounded energy accounting, replay-safe recomputation, weighted rollup summaries, stale/live freshness, and complete reads before acknowledgment.
3. Operations: installer/scheduler consistency, power-action status, staged agent migration, service state reconciliation, and immutable audit attribution.
4. UI: request cancellation, native dialog semantics, mobile fit, chart gaps/summaries, and reduced background transfer.

Observable behavior is pinned by tests in the corresponding server and web test files. Deployment is intentionally not part of this change.
