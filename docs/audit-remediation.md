# Audit remediation scope

This release addresses the full-code-audit findings in four groups. Fixes are additive where they change the database schema.

## Verification (run on 2026-11-18, no deployment)

- `bun --no-env-file --no-install test apps/server apps/web/src`: **246 pass, 0 fail**.
- `bun --no-env-file --no-install run typecheck`: clean.
- `bun --no-env-file --no-install run build:web`: clean.
- Agent shell syntax (`bash -n agent/*`) and Python helper syntax (`ast.parse`): clean.

Deployment and agent release are intentionally not part of this change.

1. Trust boundary: root service helper staging, authorized first-run setup, SSH host verification, session revocation, and required production secrets.
2. Data integrity: bounded energy accounting, replay-safe recomputation, weighted rollup summaries, stale/live freshness, and complete reads before acknowledgment.
3. Operations: installer/scheduler consistency, power-action status, staged agent migration, service state reconciliation, and immutable audit attribution.
4. UI: request cancellation, native dialog semantics, mobile fit, chart gaps/summaries, and reduced background transfer.

Observable behavior is pinned by tests in the corresponding server and web test files. Deployment is intentionally not part of this change.
