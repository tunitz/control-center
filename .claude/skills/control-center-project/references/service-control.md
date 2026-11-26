# Service control: gate and root helper

Per-unit services (systemd, Docker, LXC and per-user systemd units) are managed from the unit page. The agent runs as the unprivileged `ccagent` user, so privileged work goes through a file-based request and a root helper.

## Flow

1. The dashboard sends a forced SSH command to the agent gate (`agent/ccagent-gate`). Accepted verbs: `svc-list`, `svc-discover`, `svc-act <kind> <name> <start|stop|restart>`, `svc-logs <kind> <name> <n>` and `svc-allow`.
2. The gate validates every positional word (kind, name pattern, action, `n` clamped to 1–500), parses with `read -r -a`, and never evaluates a supplied word.
3. It writes a request file under `/var/lib/ccagent`: the first line is JSON with `id`, `verb`, `kind`, `name`, `action`, `n` and `ts`; the body is used only by `svc-allow` (max 65536 bytes).
4. A root-owned systemd path unit starts the root helper (`agent/ccagent-svc`).
5. The helper re-validates argv, checks the allowlist and protected units, resolves user services through `loginctl`/`runuser`, then performs the action.
6. Results are published under `/run/ccagent`, a directory owned by `ccagent`. The helper opens a fresh random result name with `O_EXCL|O_NOFOLLOW` (a planted symlink or pre-created file cannot redirect the write) and `fchown`s it to the directory owner on its own verified file descriptor, never by path.
7. The gate waits for the result, prints it, deletes it and exits `0` on success or `3` on failure. A query request times out in seconds; an action request waits longer because systemctl/docker/pct can be slow.

## Safety rules

- Never build a shell string from request fields; argv only. Names must start with an alphanumeric character so they cannot be read as options.
- The allowlist lives at `/etc/ccagent/services.json`, written only by the `svc-allow` verb (validated, max 200 items). Only allowlisted services are shown or controllable.
- Protected units are never controllable: any `ccagent*` systemd unit, `ssh`, `ssh.service`, `sshd`, `sshd.service` and `sshd@*`.
- LXC names are numeric VMIDs only. Docker and systemd names follow the strict name pattern.
- Result files must be mode `0600` and owned by the gate user. Root-only results make the gate fail with `Permission denied`, which the dashboard reports as a missing agent; read the raw gate output before assuming the agent is gone.
- Never use `pkill -f` patterns: the pattern matches the shell running it. Record the PID when a process starts, kill that PID, and confirm with `ss -ltn`.
- Upgrades: units installed before service control existed need the installer re-run to get the helper, path unit and `/etc/ccagent` files.

## Firewall ownership manifest

The installer writes `/etc/ccagent/firewall.json` recording what it changed (including UFW, firewalld, nftables and iptables flags, and for nftables the family, table and chain). The uninstaller reads the manifest to remove only its own rules. Instead of hard-coding `inet filter input`, the installer discovers the nftables input chain from the live ruleset, so any family/table with an input chain is handled correctly.

## Paste command cap

The offline copy-paste installer is capped at `18000` bytes by `apps/server/src/install.test.ts`. If helper or installer code pushes it past the cap, decide explicitly between trimming the script and raising the limit; do not bump the number silently, because the paste is meant for phones and chat clients.

## Log normalisation

- Strip ANSI escape sequences (`\x1b\[[0-9;]*[A-Za-z]`) from the message before truncating it, for every kind (systemd, Docker, LXC). Coloured output otherwise shows up as `[34mdebug[39m`.
- Journal PRIORITY 0–4 is authoritative (0–3 error, 4 warn). Priority 5/6 or missing means the app chose its own level: upgrade by whole-word match on the cleaned text — `error|fatal|panic|exception|traceback` → error, `warn|warning` → warn, `debug` → debug. Otherwise keep info.
- Docker lines still use substring matching.
- Logs are returned newest first.

## User-level services

System discovery (`systemctl list-units` without `--user`) never lists a login user's services, so user units use a separate path:

- The root helper runs `loginctl list-users`, keeps users with uid >= 1000 and a live `/run/user/<uid>`, and skips users with no user manager. The service account is filtered out by the uid rule.
- Each user's units are queried as that user through `runuser` with `XDG_RUNTIME_DIR` set. Argv is built from validated fields only, never a shell string.
- Logs come from `journalctl --user-unit <unit> _UID=<uid>`.
- Manage shows one group per user, labelled `User services (<user>)`. Rows show the bare unit name; the full `user:unit` name is the tooltip.
- Start, stop and restart use the same request-file path and protected-name rules as system units.
- Changing the helper needs a new public agent release; units pick it up only on reinstall. An empty user group after an update means the unit still runs the old agent (see the release flow in `../SKILL.md`).

## Testing on a real host

Unit tests stub chown, rename and the user, so they cannot prove the privilege boundary. After any change to the gate or helper, run the gate as the real service user on a host:

```bash
su -s /bin/bash ccagent -c 'SSH_ORIGINAL_COMMAND=svc-list /opt/ccagent/ccagent-gate'
```

Expect `{"ok": true, ...}`. Then run each verb that changed. For an allowlist test, pipe JSON into `SSH_ORIGINAL_COMMAND=svc-allow` on stdin and reset it to `{"items":[]}` afterwards. Refused names such as `ssh.service` must return `not allowlisted`. Clear leftover `svc.*` files from the request and result directories before a run. Do not restart or stop a real service just to test.

Tests to keep green: `apps/server/src/svc-agent.test.ts` (gate round trip and denial cases), `services.test.ts` (validators and builders) and `install.test.ts` (installer contains helper, units and uninstall paths).
