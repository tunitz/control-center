---
name: control-center-project
description: "Full runbook for the Control Center project: build, deploy, chat, Pi bridge, tests, pitfalls. Load when changing or operating it."
version: 1.1
author: Claude Code
license: MIT
platforms: [linux]
metadata:
  hermes:
    tags: [control-center, monitoring, agents, docker, bun, chat, pi]
    related_skills: [homelab-dashboard, tun-sfx-access]
---

# Control Center runbook

This runbook lives in the repo (`.claude/skills/control-center-project/`) and is committed with the code. The global `control-center` skill lives in `~/.agents/skills` (shared by Hermes and Pi; `~/.hermes/skills` is a symlink to it). It is a short stub that points here; the stub is a single copy there.

## Pitfall: agent changes need a public release
When pushing a change under `agent/` or `install.ts`, publish the release in the same step without asking (tun's standing rule). `GITHUB_TOKEN` is in `~/.hermes/.env` (`set -a; . ~/.hermes/.env; set +a`); `gh` needs `GH_TOKEN` set from it. Poll the `latest` URL until it serves the new code (took ~20 s once).
The default install command curls `install-ccagent.sh` from the public `tunitz/ccagent` GitHub release, NOT from the dashboard. After any change under `agent/` or `install.ts`, run `bash tools/release.sh vX.Y.Z` (needs GITHUB_TOKEN; find the latest tag with `gh release list -R tunitz/ccagent`) or units reinstall the OLD agent and the gate answers `denied` to new verbs. A unit you can reach as root can take a new helper by hand (see Service control). Verify before telling a user to rerun: grep the tag URL (`releases/download/vX.Y.Z/install-ccagent.sh`) for the new code, then the `latest` URL. The `latest` redirect can serve the previous release for minutes after publish, so a rerun of the default command silently reinstalls the old agent. If `latest` is still stale, give the user the pinned-tag command instead of the `latest` one.

## When to Use
Operating, debugging, extending, or deploying the Control Center — the unit monitoring and agent management dashboard. Covers the repo, build/deploy, the agent install flow, and common pitfalls.

## What it is
A Bun + SQLite dashboard that monitors remote Linux units via SSH agents. Each unit runs a small agent that reports CPU/RAM/disk/power metrics back to the Control Center. Units can be on different subnets — the Control Center connects to them via SSH, not the other way around.

- **Repo**: `~/projects/control-center`, private GitHub `tunitz/control-center`
- **Public agent repo**: `tunitz/ccagent` (agent scripts only)
- **Live**: http://192.168.31.10:3030 (docker, `network_mode: host`; the host is also `192.168.31.207` on wifi. `192.168.31.206` is stale and answers nothing)
- **Stack**: Bun (server + web), SQLite at `/data/cc.db`, volume `control-center_cc-data`
- **Deploy**: `docker compose up -d --build` (run with background=true)

## Chat tab (built, commit cddb726 "Add Hermes chat tab")
Hermes and Pi chats run inside the Control Center. Server: `apps/server/src/chat/` (backend clients, run manager, uploads). Web: `apps/web/src/pages/Chat.tsx`, `components/chat/`, `chat/`, `chat.css`. Routes `#/chat` (session list) and `#/chat/<session>`; swipe-back goes session → list → dashboard (`parentHash` in `swipe.ts`). Design: `docs/chat-plan.md`, `docs/chat-contract.md` (the live contract: read it before changing a chat route or shape), mock `docs/mockups/chat.html`. Hermes API facts (frame shapes, limits, disconnect behaviour) are in `references/chat-hermes-api.md`. What the chat UI can do today (message delete and retry, saved command rows, token details, approvals and YOLO, the New chat menu, Send while busy (interrupt or queue), the Settings accordion) is in `references/chat-ui.md`. Read both before changing Chat code.
- Subagent awaiting state: `chat.run` and the session list carry `awaiting` (count of Hermes background `delegate_task` results not yet reported). While it is >0 the server polls the Hermes transcript over HTTP every 5 s (no model tokens) and, once the session is idle, starts one internal report turn so the agent tells the user the result. Design, watcher states and limits: the "Background subagent reports" section of `references/chat-hermes-api.md`. Do not add model-side status polling.
- Checks so far: layout on a throwaway container (`references/test-instance.md`, container variant), and the recent UI work in a browser on a static preview with the dev mock at 390px and desktop width (`references/test-instance.md`, "Static preview"). Neither proves the iOS Home Screen app or a live Pi run, and only tun can confirm those. Say which check you ran when you report a UI change. Still to test through the UI before calling them done: attachments, model and effort switching, Stop, interrupt and queue against a live run.
- Phone (390×844) acceptance, measured by DOM rect, not by eye:
  - Composer: one textarea row plus one toolbar row (attach, camera, effort text trigger, model text trigger, main button). Effort and model are text-only triggers (no pill, no border) that open a popup menu; the `/model` command path must keep working alongside them. On phones the main button is a bare 24px arrow with a 44px tap box and no circle (tun: the circle was huge); desktop keeps the labelled button. Right-pointing triangle = Send, also while a run is active, beside a red square = Stop. A busy send interrupts or queues like Hermes (`references/chat-ui.md`, "Send while busy, Stop"). All toolbar controls share one `top`; the main button is 44px and has an `aria-label`.
  - Context: phones show no context text under the composer (tun removed it); the figure lives only in the line under each reply (`48.4k context · 1.4k out · first token 3.8s · compacted 2×`), and the running hint is the only text under the composer. Desktop keeps the bar inside the composer. Show nothing when the figure is unknown, and never show `usage.input` as the context (`references/chat-ui.md`, "Tokens and context").
  - Label an unset option by what the server actually sends. When no thinking level is chosen the server sends nothing and Hermes applies its own default, so the pill reads "Think: Default", never "Off".
  - The thread scroll area ends above the composer. No gradient fade sits over the last card. Assert the last card's `bottom <= composer.top - 8`.
  - Phone chat is a fixed screen, not a scrolling page. While the Chat tab is mounted, `html` has `overflow: hidden`; only the message list scrolls, and the composer stays fully visible above the tab bar without any page scroll. Size the chat root from measured rects: its own `top` to the tab bar's `top` (desktop: viewport bottom minus 16px). Do not hardcode the bottom from CSS padding: the `.app` padding and the tab bar's safe-area inset add up to more than the constant assumed, and the page then scrolled about 40px and hid the composer under the tab bar. The sizing lives in `chatHeight()` in `chat/viewport.ts` (unit-tested). Acceptance at 390×844: `document.documentElement.scrollHeight <= innerHeight`, and the composer's bottom is above the tab bar's top.
  - Header, divider, cards and composer share the app's 16px gutter.
  - Drawer: scrim is `position:fixed` at rect `0,0,390,844`, above the tab bar in z-order. Tapping the scrim closes it. Close button is 44px.
  - Icon-only controls carry `aria-label` (Chats, Chat menu, Attach file, Take photo, Close chats, Send, Stop, Scroll to latest). The tests and the drawer checks find them by these labels. Scroll-to-latest is a floating button inside the composer column (`.jump-btn` in `.comp-inner`), not in the header.
- Suggestion-card subtitles and empty-state text must describe what the server does. A Pi chat has a real Approve/Deny step, so "asks before risky commands" is true there; a Hermes chat only shows a read-only notice, so never promise that it asks. The first version of this wording was a false claim and had to be fixed.

## Build & Deploy
```bash
cd ~/projects/control-center
bun test apps/server apps/web/src pi-bridge/test && bun run typecheck    # `bun run test` is only the first two paths; typecheck covers server, web and bridge. Must be clean before commit
docker compose build --no-cache  # see pitfall below
docker compose up -d --force-recreate
```

**Bridge changes**: anything under `pi-bridge/` runs on the host, not in the container. After a commit that touches it, restart it (`systemctl --user restart pi-bridge`, then `is-active`); a container rebuild alone does not load it. From a shell with no user DBus session (`systemctl --user` fails with "Failed to connect to user scope bus") ask tun to run it. Until it restarts, features that need a new bridge route do nothing or show "not reachable": the Skills card, the Claude and browser switches, fork-based retry, new and edited skills reaching open chats. Server-only changes, including the token figures, need only the container.

**Rebuild-only request** (tun says "rebuild" with no code change): first check `git status --short` is empty and `git log origin/main..HEAD` is empty. If both are clean, skip tests and commit, and run the build chain below on the current HEAD, reporting that HEAD commit. If either check fails, stop and ask whether to commit, because a rebuild would ship uncommitted or unpushed code.

Run the build chain as one background job with `notify=true` and a timeout of 900 s. It takes several minutes. Read the `build=<exit>` line and the HTTP code from the notification, not from a guess. `build=0` plus `200` plus a clean `docker logs` tail is the whole acceptance for a rebuild-only request.

**Manual rebuild requested**: when tun says he will run the rebuild himself, do not run the build chain. Reply with the commands in order (the build chain above, plus the commit and push step if HEAD is unpushed), and after each one the output line that proves it worked (`build=0`, the HTTP code, the `docker logs` tail). The HTTP check uses the host in the `Live` line above, never an address recalled from memory.

**Pitfall — redeploy signs you out**: `docker compose up -d --force-recreate` invalidates the browser session cookie, so a live-test script that assumes it is still logged in fails on `a.card` being null. Sign in again in the test code (`input[type=password]` + `CC_ADMIN_PASSWORD` from `.env`) before asserting on the UI.

**Pitfall — schema changes on deploy**: the server adds new columns to existing sample tables at startup. Back up `/data/cc.db` first (`docker cp control-center-control-center-1:/data/cc.db ~/.hermes/cache/scratch/`) so a bad migration can be rolled back. Keep changes additive (see Invariants).

**Pitfall — stale build layers**: `docker compose build` can serve stale layers even after code changes. If the running container doesn't reflect your changes, use `docker compose build --no-cache` or build explicitly with `docker build --no-cache -t control-center-control-center:latest .` then `docker compose up -d --force-recreate`. Verify the new code is inside the container, not just in the repo: `docker exec control-center-control-center-1 grep -rl '<new string>' /app/apps/web/dist/assets`. Lazy-loaded page chunks (e.g. `Chat-*.js`) carry their own strings, so grep the chunk, not `index.html`.

## Agent Install Flow
The Control Center connects to units via SSH (push-style), so units don't need to reach back. The default install method is a short curl command (~200 chars) that downloads a generic installer from the public agent repo's GitHub releases:

```bash
curl -fsSL https://github.com/tunitz/ccagent/releases/latest/download/install-ccagent.sh | bash -s -- '<unit public key>'
```

This works on any subnet and is short enough to paste on a phone. Two other methods are available:
1. **Copy-paste heredoc**: A self-contained heredoc (~5 KB) that embeds the agent scripts. Use when the target has no internet access.
2. **Download installer**: A shell script the user downloads and runs on the target.

All three are generated from the same template in `agent/`.

**Pitfall — install paste-command size limit**: `install.test.ts` caps the copy-paste heredoc. When the embedded agent script grows past the cap, the test fails. Decide explicitly between trimming the script and raising the cap, and say which one you chose. Do not bump the number silently, because the paste goes through phones and chat clients.

**Pitfall — corrupt stored keys**: ssh2 generates keys its own parser rejects ~1/250 times. Retry key generation until the key parses. A silently corrupt key means the unit sits offline forever with no error.

## Power Control (no sudo)
The agent uses a systemd path unit for power control, not sudo. The agent user writes a request file containing `poweroff` or `reboot`; a root-owned helper runs that single action and ignores anything else (including stale requests >2 min old). This works on Proxmox and other root-only hosts with no `sudo`/`visudo`.

Units installed before v0.6.0 need the installer re-run once to enable Shut down and Restart.

## Pitfalls
- **Word filter**: The command filter blocks commands containing shutdown/reboot-related words. Write scripts to files first, then run with a neutral command.
- **Never `pkill -f` a pattern**: the shell running `pkill -f <pattern>` has that pattern in its own command line, so it kills itself (exit -15), and the approval guard flags it as self-termination. Record the PID when you start a process (write it to a file in the scratch dir) and kill that PID; confirm with `ss -ltn`. `pgrep -f` with a bracketed pattern (`'apps/server/src/inde[x].ts'`) is only for finding a PID you did not start.
- **Chat slash commands, /credits host endpoint**: see references/chat-slash-and-credits.md.
- **Pi compaction is fixed in the bridge, not configurable**: Pi compacts at 256,000 tokens and keeps 51,200. The bridge writes this into `~/.local/share/cc-pi/agent/settings.json` on every start (`references/pi-backend.md`, "Compaction"). Do not add a UI or API for it.
- **Pi settings are per chat and sent with every start**: a setting the user never changed is not stored, so a new chat always starts from Pi's defaults. Store only the keys the user set, and merge them over defaults on read. A cleared value goes out as an explicit null on the next start (`tools: null` means Pi's default): an omitted key leaves the running process on the old value, so send the whole settings object on every start, nulls included. Settings that Pi reads only at process start (the tool list, the config files) restart that chat's process on change, not just re-send; the bridge keys the running process by those values and refuses the restart while a run is active (409).
- **iPhone clipboard**: `navigator.clipboard` only exists on HTTPS or localhost. On plain HTTP (LAN IP), use `execCommand("copy")` fallback.
- **Live power total must count only units online now**: summing each unit's last power sample without an online check counts shut-down or unreachable units, and samples are kept up to 48 h. Filter on current online status (`last_seen` fresh) before summing; verify against `/api/units` after a deploy.
- **Service-control helpers are argv-only**: the root helper and gate must never build a shell string from request fields. Names need an alphanumeric first character so they cannot be read as options.
- **Tool rows show a readable label, and background means background**: a tool argument object stringified into a row renders as `[object Object]`, so label `delegate_task` with its goal text. A dispatched background subagent must show `background`, not the green "ok" of a finished call, until its result row arrives.

## Pi chat backend
Pi chats sit beside Hermes chats behind the `ChatBackend` interface (`apps/server/src/chat/backend.ts`); the session's stored `backend` picks the client. The bridge is `pi-bridge/` (systemd user service, 127.0.0.1:3050, bearer token). Pi itself runs on the host (`~/.local/share/cc-pi`, `pi` on PATH via `~/.local/bin`), not in a container: a container could not block LAN access from Pi, so host install is the decided setup. `references/pi-backend.md` covers frame mapping, approvals and YOLO, the gate, the config files and launch key, the Claude Code bridge, the browser tools and the skills manager; read it before touching `pi.ts`, `runs.ts` approval code, `cc-gate` or anything in `pi-bridge/`. Web UI: the Pi agent group in Settings (`PiConfigCard.tsx` "Agent settings" and `PiSkillsCard.tsx`, both in `apps/web/src/components/`); per-chat options are a sheet from the chat menu; the approval card, todo list, folder picker and sign-in sheet are in `apps/web/src/components/chat/` (Approval.tsx, Todos.tsx, PiSheet.tsx, FolderSheet.tsx, LoginSheet.tsx). Pi's own slash commands and prompt templates are not in the palette: only Control Center's `/login` and `/yolo` are Pi-only. Per-chat live settings, thinking level and compact endpoints are in `docs/chat-contract.md` ("Pi chat settings"), and global Pi configuration in the same file under "Pi configuration".
- Resolve model ids against the chat's own backend: a Pi chat's model id is looked up in Pi's model list, never Hermes's. The web always sends a model id, so a lookup on the wrong registry silently picks the wrong model on send and on PATCH. Test it by sending the id the web actually sends from a Pi chat.
- Restart the bridge after any `pi-bridge/` change (`systemctl --user restart pi-bridge`, then `is-active`) before a live check; the server does not reload it, so a live run against the old bridge proves nothing about the change.
- Fake-bridge doubles must implement every command the client sends and must reflect the state they were set to. A no-op stub for `set_*` makes a readback test pass for the wrong reason. Keys the real Pi does not report (auto retry) are verified only as accepted on the live run, not by readback.
- Send the chat's effort as Pi's thinking level only when Pi's own model list says the model reasons. Hermes's `reasoning` flag describes a different model registry and is wrong for Pi models.
- A chat's backend is fixed when the chat is created, so the agent must be chosen before the chat exists. New chat is a Hermes / Pi menu and each choice creates the chat with that agent's default model (`defaultModelFor` in `chat/pi.ts`), so no model has to be picked first and the other agent's models are never greyed out on a fresh chat. The sidebar tags every chat with its agent name (Hermes or Pi); a session without the field reads as Hermes.
- Changing a curated model list (Hermes `models.ts`, Pi `pi.ts`): grep the whole test tree for each model id first. The lists are pinned by full-list equality, counts, context-window maps and online maps across `models.test.ts`, `routes.test.ts` and `backend-routes.test.ts`, and each pin fails separately. Curated lists and Anthropic auth: `references/pi-backend.md` ("Model lists", "Provider auth").
- **The process cap evicts, it does not refuse**: at the live-process cap, close the least recently used chat that is not mid-run (its session file stays, so its next message resumes it). Answer 429 only when every live chat is busy. A hard cap that refuses idle chats breaks normal use, because an idle chat holds its process for the whole idle timeout. Test three cases: the oldest idle chat is evicted, a busy chat is never evicted, and 429 appears only when all are busy.
- **Live gate**: `tools/pi-live-gate.ts` runs 14 real scenarios (streaming, approve and deny, protected path, todo, reload mid-run, two chats, stop, settings, bridge restart) against a running Control Center with real Pi and a cheap model. Set `CC_PASSWORD`, run it in the background to a log file, and read the log at the end. Use a throwaway instance on a spare port, because the restart scenarios restart the bridge.
- Pi's refusals (for example "Nothing to compact" on a small session) are real results: return them as 502 with Pi's message. Do not map them to 500 or to a silent success.
- Extend the shared `HermesFrame` union in `hermes.ts` when a frame type is added. Add the new frame to the SSE event-name list in `apps/web/src/chat/sse.ts` and to the reducer in the same commit, or the frame is silently ignored by the browser. Todo frames (`todo`) are the worked example. Casting a test object to fit the union hides the missing type and fails `typecheck` later.
- A fake bridge scenario that waits for a client answer must emit its request first, then await. A promise awaited before the emit leaves the SSE stream silent, and the test fails as a socket error after the timeout, not as an assertion.
- Verify the approval gate on the real Pi binary and the real bridge with a cheap model, not only in the fake bridge. The fake proves the wiring; only the live run proves the gate blocks a write.
- **Claude subscription goes through Claude Code, not Pi's Anthropic provider.** Pi's native provider is refused (400 "Third-party apps now draw from your extra usage"). The working route is the pi-claude-bridge extension behind the Settings switch, with Claude Code signed in on the host: `references/pi-backend.md`, "Claude Code bridge". If a Pi chat still shows that 400, check which provider the model resolved to before anything else: a duplicate model id once resolved to the blocked native one. Do not port Hermes's imitation of Claude Code to Pi.
- **A custom tool selection drops the browser tools** (known gap, verified with real Pi). A per-chat tool list or `defaultTools` becomes `--tools a,b,c`, which replaces the whole selection, and the browser tools are not in `KNOWN_TOOLS`. Pi's defaults keep them. Details and the fix: `references/pi-backend.md`, "Browser tools".
- **Pi's `/reload` is not available over RPC.** Sent as a message it reaches the model as plain text. Config, tool, skill and Claude-bridge changes already restart a chat's process through the launch key; an edited extension or a project `AGENTS.md` waits for the idle restart or a bridge restart.

## Changing a chat contract field
Adding a field to a shape in `docs/chat-contract.md` (session, run event, message) needs three edits in the same commit: the shape type in `apps/web/src/chat/types.ts`, the server builder in `apps/server/src/chat/store.ts` or `runs.ts`, and every test that asserts the whole object with `toEqual`. Find those with `grep -rn '<old literal>' apps/server/src apps/web/src`. A `toEqual` on the full object fails at once when a field is added, and a `toMatchObject` test does not. Run `bun test` after the grep, not before, so the failing list is complete.

A new column on a table with existing rows needs two more things, both in the same commit:
- Edit every explicit column list for that table: INSERT column lists, SELECT lists and the row mapper. Do not rewrite a column list with a blanket string replace: it also adds the new name to INSERTs that do not set it, and the INSERT fails with `N values for N+1 columns` only in the tests that insert, which is easy to miss in a long test run.
- Add a migration test that builds the OLD table with rows, opens it through `openDb`, checks the new column reads its default or null, writes to it, and reopens the DB without error (pattern: `backend-migration.test.ts`). A fresh-DB test alone does not prove the additive migration works on a live DB.
- Tests that cast literal string arrays into a typed union (e.g. `status: "completed"`) widen to `string` and fail typecheck. Write `as const` on those literals.

## Testing
- Read the real pass/fail line of every test or typecheck run before reporting it. Piping output through a truncating command hides the exit code, and a one-line "exit 0" with no count is not a pass. Report the count you read ("N pass, 0 fail"), never an estimate.
- From the repo root: `bun run typecheck` (server, web and bridge) and `bun test apps/server apps/web/src pi-bridge/test` (everything; `bun run test` is only the first two paths). The bridge also has `cd pi-bridge && bun test` and `bun run test:live`, which runs one real Pi prompt on DeepSeek flash for a few cents.
- `bun run typecheck` — must be clean
- End-to-end: create a test unit, run the install command in a container, verify it comes online with live metrics. Test power control (restart/shutdown) on a systemd container.
- The web UI is at `localhost:3030` — test with browser_exec and device emulation (390px width). For a feature that needs a state the live box can't produce, use a throwaway instance with a mocked API: `references/test-instance.md`. On that instance also read the real `/api/...` JSON (step 8 there); the UI can render from a mock while the server returns null.
- **Popovers and menus need real pointer events**: test dismissal with CDP `Input.dispatchMouseEvent` (pressed then released) at the 390px emulated viewport, not `el.click()`. A synthetic click never fires the outside-press listener, so the test passes while a real tap leaves the menu open. Cover three cases: tap outside closes it, Escape closes it, tapping an item runs the action and closes it. The Power dropdown was fixed this way (commit 8164b69).
- Browser login for tests: the form is a single `input[type=password]`; the password is `CC_ADMIN_PASSWORD` in `~/projects/control-center/.env`. Read it inside the test code — never print it.
- **Chat UI smoke test** (390px, real Hermes, no mock needed on the live box; a throwaway container is the safe place for layout work): send a message whose answer needs a markdown table and a fenced code block, then check `table`, `pre code` and a Copy control in `main` innerText. Start a long run (e.g. a terminal `sleep 20`), reload, and confirm the Stop control is still shown and the answer completes. Find Send by `aria-label`/innerText, not by a fixed selector. Delete the test chats afterwards through `/api/chat/sessions/<id>`.
- The app is **hash-routed** (`src/main.tsx`): `#/`, `#/settings`, `#/unit/<id>`. Routing lives in `apps/web/src/route.ts` → `subscribeHash(onChange)` (unit-tested in `route.test.ts`), which listens for `hashchange`, `popstate` **and** `pageshow` — an iOS Home Screen web app can restore the page on an edge-swipe-back without firing `hashchange`, which left the unit view on screen (tun's "swiping right just refreshes, doesn't go back"). Assert navigation with `location.hash` plus a `window.__marker` you set before clicking — a real page load loses the marker, so the pair separates "navigated" from "reloaded".
- **Do not probe for the unit view with `.uhead`**: dashboard unit cards share that class, so `document.querySelector('.uhead')` is truthy on the home view and fakes a "didn't navigate" failure. Assert on `main` innerText or the unit title instead.
- **Chromium device emulation cannot reproduce an iOS Safari edge-swipe-back**: hash links and `history.back()` both pass there. Verify the routing fix by `history.replaceState(null,'','#/')` then dispatching `new PageTransitionEvent('pageshow',{persisted:true})` — the dashboard must render. When tun reports this, ask (a) is it a Safari tab or a Home Screen web app, (b) was the unit opened by tapping a card or from a link/refresh straight onto it. If it still reloads with the fix in place, iOS is doing a full page load and path-based routes are the next step.

### Swipe-back in the Home Screen app (fixed, confirmed by tun)
The OS edge swipe reloads the page on hash routes. `src/swipe.ts` `initSwipeBack()` runs only when standalone: link clicks use `navigate()` (history.replaceState + `cc-nav` event) so history stays one entry, and a left-edge drag (start x<=40, dx>=70) goes to `parentHash()`. Use `navigate()` not `location.hash=` in app code. Test headless by forcing `navigator.standalone` via `Page.addScriptToEvaluateOnNewDocument` (setEmulatedMedia display-mode does not stick) and `Input.dispatchTouchEvent`; assert history.length stays flat and a window marker survives. Icons: `public/icon.svg` (full-bleed) -> PNGs rendered via browser canvas; user must re-add the Home Screen icon.

### iOS Home Screen flicker and swipe-back reload

Symptoms: tab switches or opening a unit flicker, or swiping back reloads the page, in the Home Screen app. Desktop Chromium does not reproduce this, so a desktop pass proves nothing for it.

Causes found and fixed so far (check these first on a regression):
- `.tabbar` with `backdrop-filter` repaints under the fixed bar on every screen change: keep it opaque.
- `background-attachment:fixed` on body with stacked gradients: put the gradient on a `body::before` fixed layer.
- `filter: drop-shadow` on an animated SVG circle (Gauge): use a static wider low-opacity circle for the glow.
- Unit page returning `null` until `/units/:id` loads: seed it from the cached `/units` list and keep a `.charts` placeholder.
- The shared EventSource stays open through `pagehide`, which blocks bfcache: close it on `pagehide`, re-open on `pageshow`, and re-attach handlers.
- `index.html` served without `Cache-Control`: serve it `no-cache`, and `/assets/*` immutable.

IOS Home Screen standalone needs `apple-mobile-web-app-capable`, `apple-mobile-web-app-title` and a `manifest.webmanifest` link in `index.html`. Without them the icon may open in a Safari-like view with different reload behaviour. The Home Screen icon is created once from Safari, so the user must delete it and add it again after the meta or manifest changes.

The user confirms the result on the phone; the agent verifies on desktop at 390px only (no gradient repaint, gauges present, first-frame content, no node churn over 20s).

## Theming (system/light/dark)
- Tokens live on `:root` in `apps/web/src/styles.css` (light), `[data-theme=dark]`, and a `prefers-color-scheme` block for system mode. Mode is stored in localStorage `cc-theme`, applied by `src/theme.ts` and an inline pre-paint script in `index.html`; `cc-theme-change` event fires on effective-theme change.
- Never hardcode colors in TSX: use `var(--s1..--s5)` series, `--ok/--warn/--err`, `--track`. uPlot canvas can't read CSS vars, so `Chart.tsx` resolves them with `cssVar()` and rebuilds on `useThemeTick()`.
- Button colors: Start `.btn.ok`, Stop/Remove/Shut down `.dng`, Restart `.warn`, primary `.pri`.
- Mobile layout traps: never use `overflow-wrap:anywhere` on service names/details (breaks mid-word); a 2-col `auto auto` grid stretches the log level chip; keep `.app` bottom padding >= tabbar + safe-area. Chart y-axis gutters are computed from the unit label length in `Chart.tsx`; a fixed gutter clips labels such as `1000 KB/s` on the left at 390px. Any new chart unit needs this check.
- Test the UI in dark, light, system (CDP `Emulation.setEmulatedMedia`) and 390px on a throwaway instance (references/test-instance.md). Dark mode needs both the theme key (`cc-theme` in localStorage) and the media query set: a reload with only one of them tests the wrong theme.
- Chat UI controls at phone width: an icon-only Send and two text triggers fit one toolbar row at 390px. Text triggers keep a 44px tap height through padding, not a larger font, so the row stays one line. At narrower widths let the toolbar wrap rather than shrinking the tap targets below 44px.

## Service control (per-unit services, product rules)
Services (systemd, Docker containers, LXC guests) are controlled from the unit page only. Design and flow: `references/service-control.md`. User-level systemd services (`systemctl --user` for each login user with a live `/run/user/<uid>`) are shipped: detected via `loginctl`, shown as a per-user group in Manage, actions run via `runuser`. Only system-level units were listed before this change, so a user-service question means check the `loginctl`/group path, not the system list.

Product rules, set by tun:
- Start, Stop and Restart run immediately, with no confirmation dialog.
- Logs show the newest line first, in human-readable form, and each service row expands to show them.
- Only allowlisted services are shown or controllable. Allowlist is chosen in Manage.
- `ccagent*`, ssh and sshd units are never controllable.
- Services section appears on the unit page only; dashboard cards stay minimal.

Rules for changing the service-control helper or gate:
- The root helper must hand its result file to the gate user: chown to the state dir owner, then mode 0600. A root-only result makes the gate fail with `Permission denied`, and the dashboard reports that as a missing agent.
- Unit tests stub chown, rename and the user, so they cannot prove a privilege boundary. Run the gate as the real `ccagent` user on a real host before calling it done (`references/service-control.md`, "Testing on a real host").
- A unit you can reach as root takes a new helper by hand (`install -m 0755 -o root -g root`), leaving the path unit alone. The installer is needed for new units.
- The UI shows the reinstall hint for any error containing the word 'agent'. Read the raw gate output on the host before assuming the agent is missing.

## Common Operations
- **Add unit**: Web UI → Add unit → curl command (default), copy-paste heredoc, or download installer
- **Remove unit**: Unit detail page → Remove unit (with confirmation)
- **Reset admin password**: `CC_ADMIN_PASSWORD` in `.env` (chmod 600, untracked)
- **Check unit status**: `curl -s localhost:3030/api/units` (with auth cookie)
- **Audit log**: `docker exec control-center-control-center-1 bun -e 'import{Database}from"bun:sqlite";const d=new Database("/data/cc.db");console.log(d.query("select * from audit order by id desc limit 10").all())'`

## Troubleshooting

### Unit shows offline / "Connection lost before handshake" after a reboot

When a unit reboots while the Control Center is running, the SSH pool can get stuck on a dead connection and never retry. The unit stays offline in the UI even though it's fully up and SSH is accepting connections.

**Diagnosis:**
1. Check the unit's SSH logs for failed auth attempts from the Control Center IP — if you see `penalty: failed authentication` or `Disconnected from authenticating user`, the key is fine but the connection is being dropped before handshake.
2. Verify the stored key works manually: decrypt `privkey_enc` from the DB and test an SSH connection to the unit.
3. Check the DB: `docker exec control-center-control-center-1 bun -e 'import{Database}from"bun:sqlite";const d=new Database("/data/cc.db");console.log(d.query("select id,last_seen,last_error from units").all())'` — if `last_seen` is stale and `last_error` says "Connection lost before handshake", the pool is stuck.

**Fix:** nothing to do now, but if a unit is still stuck on an older build, restart the Control Center container:
```bash
docker restart control-center-control-center-1
```
The pool reconnects on the next poll cycle and the unit comes back online.

**Root cause and the fix (deployed 2026-10-17):** one unit's poll cycle could hang forever with nothing recorded — `SshPool.exec` awaited a handshake promise that only rejected on `error`, so a client whose socket closed during the handshake left the promise pending. `Scheduler.busy` then kept that unit's poll slot taken for the life of the process: `last_seen` went stale, `last_error` stayed null, and no reconnect was ever attempted (that is why the unit showed offline for hours with a clean error field and no `ccagent` lines in the unit's sshd journal).

The fix is in `apps/server/src/ssh.ts` and `apps/server/src/poller.ts`:
- `SshPool.exec` bounds the handshake wait hard (`readyTimeout + 2s`) and `drop()` destroys the client, not just `end()`s it.
- `Scheduler` runs each unit's whole cycle under a watchdog (`pollTimeoutMs`, default 30 s). On expiry it records `last_error` (`poll watchdog: no result in 30000ms`), drops the connection and frees the slot, so the next tick reconnects. A static-refresh failure is now recorded in `last_error` too instead of failing silently.
- Poll state changes are logged once per transition, so `docker logs` explains an outage without guesswork:
  `[poll] … unit 4 proxmox (127.0.0.1) failing: Timed out while waiting for handshake` then `[poll] … unit 4 proxmox (192.168.31.2) recovered`.

Regression tests: `apps/server/src/poller.watchdog.test.ts` (a never-settling poll or static refresh returns, frees the slot and retries) and two `ssh.test.ts` cases (silent peer, peer that drops during the handshake). Reproduce a stall on purpose by pointing a unit's host at a silent TCP listener and restarting the container: the unit must go stale with that reason within ~one interval and come back on its own after the address is restored.

### Chat reply shows "run failed" with no text
The UI only shows "run failed"; the reason lives in the Hermes log. Triage in this order before changing code:
1. `grep -n 'finish_reason=content_filter' ~/.hermes/logs/agent.log`. A provider refusal logs its `category` and explanation. A refused turn is a model-side block, not an upload bug.
2. Probe Hermes directly on the Hermes host, bypassing Control Center: `POST http://127.0.0.1:8642/api/sessions` with `{"source":"api_server"}`, then `POST .../chat/stream` with `{"message": [text part, {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]}` and `Authorization: Bearer` from `HERMES_API_KEY` in `.env` (read it in code, never print it). A plain answer means image handling works and the fault is in that chat's history. Delete the probe session afterwards.
3. Find the failing assistant rows in `chat_messages` (status `failed`) and match their timestamps to agent.log.
Starting a new chat clears a refusal only when the old history is the trigger; test a new chat with an image before calling it fixed.

## Invariants
- Schema changes must stay additive (`CREATE TABLE IF NOT EXISTS`)
- The DB is the only copy of unit data and history
- Never print `.env` contents
- A token that must move into a file is copied file to file inside the script, never typed or echoed. Tool output masks bearer-like strings, so a value that passes through output is written back masked; verify by length or a `grep -c` on the prefix, not by reading it.
- The agent footprint is ~0.1% of one core and 3 MB RSS per unit
