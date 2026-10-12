# Service control: design and flow

Since the agent runs as the unprivileged `ccagent` user, it cannot call systemctl, docker or pct as root directly. The flow uses a file-based request and a root-owned executor:

1. The Control Center sends an SSH command to the agent gate (`agent/ccagent-gate`). Verbs: `svc-list`, `svc-discover`, `svc-act <kind> <name> <start|stop|restart>`, `svc-logs <kind> <name> <n>`, `svc-allow`.
2. The gate validates every positional word (kind in systemd/docker/lxc, name pattern, action in the fixed set, n clamped 1–500). It parses with `read -r -a` and never evaluates a supplied word.
3. The gate writes a request file `svc.request` (first line JSON with id, verb, kind, name, action, n, ts; body only for allow) under `/var/lib/ccagent`, then waits for `svc.result.<id>`.
4. A root-owned systemd path unit (`ccagent-svc.path`, `PathExists=` the request file) starts `ccagent-svc.service`, which runs `/opt/ccagent/ccagent-svc`.
5. The helper deletes the request first, rejects a `ts` older than 120 s or more than 60 s in the future, checks the id is 32 hex chars, then checks the allowlist before any action.
6. Results go to `svc.result.<id>` as JSON with `ok` and either `data` or `code`/`error`. The gate prints it and exits 0 or 3.

Key rules:
- Allowlist lives at `/etc/ccagent/services.json`, written only by the `allow` verb (max 200 items, validated).
- Protected: any `ccagent*` systemd unit, `ssh`, `ssh.service`, `sshd`, `sshd.service`, `sshd@*`.
- LXC names are numeric VMIDs only. Docker and systemd names follow the strict pattern.
- Log lines are normalised to `{ts, level, msg}` and returned newest first.
- Upgrades: units installed before service control need the installer re-run to get the helper, path unit and `/etc/ccagent`.

Known limit: the `ccagent` user owns the request directory, so a compromised agent user could write a request. The server-pushed allowlist already has the same trust level.

## Result file ownership
The helper runs as root and writes `svc.result.<id>`. The gate runs as `ccagent` and must read and delete it. The helper therefore chowns the temp file to the owner of `/var/lib/ccagent` (from `os.stat` on the dir) before `chmod 0600` and `os.replace`. Keep that order. Without the chown the gate gets `Permission denied`.

## Log normalisation
- Strip ANSI escape sequences (`\x1b\[[0-9;]*[A-Za-z]`) from the message before truncating, for every kind (systemd, docker, lxc). Coloured app output otherwise shows up as `[34mdebug[39m`.
- Journal PRIORITY 0-4 is authoritative (0-3 error, 4 warn). Priority 5/6 or missing means the app chose its own level, so upgrade by whole-word match on the cleaned text: error|fatal|panic|exception|traceback gives error, warn|warning gives warn, debug gives debug. Otherwise keep info.
- Docker lines still use substring matching, which is unchanged.

## User-level services (shipped)
System discovery (`systemctl list-units` with no `--user`) never lists a login user's services, so user units come from a separate path:
- The root helper runs `loginctl list-users` and keeps users with uid >= 1000 and a live `/run/user/<uid>`. Users with no live session are skipped, because they have no user manager to query. `ccagent` (system uid) is filtered out by the uid rule.
- Each user's units are queried as that user through `runuser`, with the user's `XDG_RUNTIME_DIR` set. Argv is built from validated fields only, never a shell string.
- Logs come from `journalctl --user-unit <unit> _UID=<uid>`.
- Manage shows one group per user, labelled `User services (<user>)`. Rows show the bare unit name, and the full `user:unit` name is the tooltip.
- Start, stop and restart use the same request-file path and protected-name rules as system units (`ccagent*`, ssh, sshd).
- Changing the helper needs a new public agent release. Units pick it up only on reinstall, so an empty user group after an update means the unit still runs the old agent (see SKILL.md, Pitfall: agent changes need a public release).
- The installer's paste command has a size ceiling, currently 12000 bytes. Adding helper code past it breaks the paste with no clear error; raise the limit deliberately, do not shrink the helper to fit.

## Testing on a real host
Unit tests cannot show the privilege boundary works. After any change to the gate or helper, run the gate as the real service user on the host:
```
su -s /bin/bash ccagent -c 'SSH_ORIGINAL_COMMAND=svc-list /opt/ccagent/ccagent-gate'
```
Expect `{"ok": true, ...}`. Then run each verb that changed. For an allowlist test, pipe JSON into `SSH_ORIGINAL_COMMAND=svc-allow` on stdin, then reset it to `{"items":[]}` afterwards. Refused names such as `ssh.service` must return `not allowlisted`. Clear `/var/lib/ccagent/svc.*` leftovers before a run. Do not restart or stop a real service just to test.

Tests to keep green: `apps/server/src/svc-agent.test.ts` (gate round trip and denial cases), `services.test.ts` (validators and builders), `install.test.ts` (installer contains helper, units and uninstall paths).