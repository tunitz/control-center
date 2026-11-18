# Control Center

Dark-first dashboard for monitoring and controlling Linux units over SSH with a tiny bash agent.
Bun + SQLite backend, React + uPlot frontend, single admin login.

## Run
```
bun install && bun run build:web
CC_MASTER_KEY=<long random> CC_ADMIN_PASSWORD=<pw> CC_PUBLIC_URL=http://<this-host>:3030 bun run start
```
Or `docker compose up -d --build` with `CC_MASTER_KEY` and `CC_PUBLIC_URL` in `.env`. If `CC_ADMIN_PASSWORD` is unset, open the dashboard and set the admin password on first run. Once set, change it in Settings > Security.
`CC_MASTER_KEY` encrypts the per-unit SSH private keys at rest. Back it up: losing it means re-keying every unit.

| Env | Default | Meaning |
|---|---|---|
| PORT / HOST | 3030 / 0.0.0.0 | listen address |
| CC_DATA | ./data (source default) | SQLite location; the compiled binary must set an absolute path |
| CC_WEB | apps/web/dist (source default) | built web assets; the compiled binary must set it |
| CC_AGENT_DIR | agent (source default) | agent scripts used to build installers; the compiled binary must set it |
| CC_PUBLIC_IP | unset | if set, the key on units is restricted with `from="<ip>"` |
| CC_POLL_INTERVAL | 5 | initial poll interval (editable in Settings) |

## Compiled binary
Build the web assets first, then the executable:
```
bun run build:web
bun run build:server
```
`build:server` writes the gitignored `dist/control-center`. The web UI and agent scripts are not embedded, and the executable does not read `.env` automatically (`--no-compile-autoload-dotenv`). For a loopback-only deployment:
```
CC_MASTER_KEY='<persistent master key>' CC_ADMIN_PASSWORD='<admin password>' HOST=127.0.0.1 \
  CC_DATA=/srv/control-center/data CC_WEB=/srv/control-center/apps/web/dist \
  CC_AGENT_DIR=/srv/control-center/agent ./dist/control-center
```
Under systemd, pass the existing secrets with `EnvironmentFile=` pointing at `.env` and the non-secret runtime paths with `Environment=`. All three path variables must be set for a compiled deployment; `bun run start` keeps its source-run defaults (`./data`, `apps/web/dist`, `agent`), which do not apply to the executable because Bun resolves `import.meta.dir` to its internal virtual root rather than the working directory.

## Add a unit (no connection from the unit to the Control Center is needed)
Only the Control Center connects out to the unit (SSH on dedicated TCP port 62478, key auth), so units on another subnet work as long as the Control Center can reach them.
1. Dashboard > **Add unit** (name, host/IP, MAC for WoL). A unique ed25519 key is generated; the private half stays encrypted on the server.
2. **Short command** (default, about 200 characters; toggle **With sudo / No sudo** to match the unit: Proxmox hosts and root shells have no `sudo`): `curl -fsSL https://github.com/tunitz/ccagent/releases/latest/download/install-ccagent.sh | sudo bash -s -- '<that unit's public key>' 5 62478`. It downloads the installer from the **public** `tunitz/ccagent` repo's latest release (no login, no secrets; the dashboard repo stays private) and authorizes only that key. The unit needs internet, not access to the Control Center.
   No internet on the unit? **Offline paste** is a single-line command (about 5 KB) holding the whole installer, or **Download installer** and copy the file over.
3. Publish a new agent version with `tools/release.sh vX.Y.Z` (needs `GITHUB_TOKEN`), and copy `agent/*` into the public repo first if they changed. `CC_AGENT_REPO` / `CC_AGENT_TAG` override the repo and pin a tag (default `latest`).
4. The installer creates user `ccagent`, installs `/opt/ccagent/{ccagent.sh,ccagent-gate,uninstall.sh}`, writes `/etc/ccagent.conf`, authorizes the key with a forced command, adds a root-owned systemd path unit for power control (no sudo needed: the agent user only drops a request file with one of two words; the root helper runs that single action and ignores anything else, including stale requests), a tmpfiles rule so RAPL counters are readable, and a systemd service limited to 32 MB / 5% CPU. It configures a dedicated key-only sshd on port 62478 and opens the firewall.
5. Within one poll interval the unit shows online. Rotate a key: Settings > Units > Rotate key, then re-run the new installer on the unit. Upgrading auto-migrates existing units from 22 to 62478; those units show offline until each agent is reinstalled with the new command.

## Edit a unit
Unit page > Power menu > **Edit IP / MAC** (or Settings > Units > Edit): name, host/IP, SSH port, MAC and broadcast address. Changing the IP or port reconnects immediately and keeps history and the SSH key, so the agent is not reinstalled. Input is validated and nothing changes if any field is invalid.
Power control uses a systemd path unit instead of sudo, so it works on Proxmox and other root-only hosts. Units installed before v0.6.0 need the installer re-run once to enable Shut down and Restart; until then the button says so.

## Remove a unit
Unit page > Power menu > **Remove unit** (or Settings > Units > Remove). This deletes the unit and all of its history, energy data and key from the Control Center and is audit-logged. It does not touch the unit itself: run `sudo /opt/ccagent/uninstall.sh` there to remove the agent, user, sudoers and service.

## Agent log format
`/var/lib/ccagent/metrics.jsonl` (mode 0600), one line per sample; `null` = unsupported:
```
{"v":1,"ts":1791360005,"cpu_pct":12.4,"cpu_mhz":3810,"cpu_w":28.1,"cpu_uj":918273645123,"gpu_pct":3,"gpu_mhz":210,"vram_used_mb":812,"gpu_w":19.0,"gpu_uj":null,"ram_used_mb":6120,"ram_free_mb":8230,"ram_cached_mb":4410,"swap_used_mb":0}
```
Handoff: the poller runs `read` (the gate renames the log to `metrics.<ns>.reading` and prints it), ingests (dedupe on unit+ts), then `ack <file>` deletes it and anything older. A crash before ack means a re-read next cycle: no loss, no duplicates. The agent caps the log at 5 MB if nobody reads it.

## Data and cost
Raw samples are kept 48 h, 1-minute rollups 30 d, 15-minute rollups 90 d (the retention setting clamps to 90). Energy comes from the RAPL counter delta, falling back to integrating watts; gaps over 3x the interval are never interpolated. Cost = current-month kWh (Asia/Manila month) x that month's rate. Editing the rate only writes the current month; `PUT /api/rates/<past month>` is rejected, and a new month copies the previous rate.
GPU power is read from hwmon (AMD) or nvidia-smi. CPU power needs Intel/AMD RAPL; units without it show "n/a".

## API (cookie session; writes need header `x-cc: 1`)
- `GET /api/auth/status` → `{setupNeeded, authed}` (public); `POST /api/auth/setup {password}` (first run only), `POST /api/auth/login {password}`, `POST /api/auth/logout`, `POST /api/auth/password {current,next}`
- `GET /api/units`, `POST /api/units {name,host,mac?}` -> `{id,public_key,fingerprint}`; `GET /api/units/:id/installer` (per-unit script); `GET|PATCH|DELETE /api/units/:id`; `POST /api/units/:id/rekey` -> `{public_key,fingerprint}`
- `GET /api/units/:id/metrics?range=1h|6h|12h|24h|7d|30d` -> `{tier,points[],summary{min,avg,max},energy_wh}`
- `POST /api/units/:id/power {action: shutdown|restart|wake, confirm:true}`
- `GET /api/cost`, `GET /api/rates`, `PUT /api/rates/:YYYY-MM` (current month only)
- `GET|PUT /api/settings`, `GET /api/audit`, `GET /api/events` (SSE)

Future service control: add a gate verb in `agent/ccagent-gate` and one entry in `apps/server/src/commands.ts`.

## Security notes
The forced-command key can only run read, ack, info and the two power verbs. Login is rate-limited (5/min) with argon2id, HttpOnly SameSite=Strict cookie, CSRF header on writes, and an audit log of logins, power actions, rate and settings changes. Serve behind TLS (reverse proxy) when exposed beyond the LAN.

## Tests
`tools/test_all.sh` runs unit tests, the in-process sshd integration test, typecheck and agent syntax checks. `tools/seed-demo.ts` seeds synthetic history for screenshots and scale tests.
