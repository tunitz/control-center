## Summary

<!-- Briefly describe what this PR changes and why. -->

## Type of Change

- [ ] `feat`: New feature
- [ ] `fix`: Bug fix
- [ ] `docs`: Documentation update
- [ ] `refactor`: Code refactoring
- [ ] `chore` / `ci`: Maintenance or CI/Docker update

## Verification

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes
- [ ] `bun run build:web` and `bun run build:server:bundle` succeed
- [ ] `bash tools/check_docs.sh` prints `docs check ok`

## Security & Privacy Checklist

- [ ] No `.env`, `*.db*`, SSH keys, `CC_MASTER_KEY`, private hostnames, IPs, or MAC addresses committed
- [ ] CSRF (`x-cc: 1`), session auth, and agent allowlist/protected-unit invariants remain intact
