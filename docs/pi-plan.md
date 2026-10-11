# Pi agent as a second chat backend in Control Center — plan (v1, 2026-10-11)

Status: PLAN ONLY. No Control Center code written. Evidence marked VERIFIED comes from the Pi spike in `~/projects/pi-spike` (Pi 1.1.0, real runs, DeepSeek flash). SOURCE = read in Pi docs/source, not run. Anything unmarked is a decision.

## 1. Goal

Chat tab gets a backend switch per chat: **Hermes** (today) or **Pi**. A Pi chat must support:
- Streaming text, reasoning, tool rows, stop, steer, queued follow-up, history, reopen, search, export (same as Hermes chats).
- A **live todo checklist** in the thread (like DeepSeek / Copilot chat), updated as the agent works.
- **Every Pi setting controllable from the UI** (see section 6 coverage table). Where Pi has no live API, the UI writes the setting and Control Center restarts that chat's Pi process.
- Approval cards for risky actions (bash outside the workspace, deletes), with Approve / Deny in the UI.
- Pi runs on the host as user `tunitz` (no container, decision D2) and never receives Control Center secrets: no `CC_*` env; keys live only in `~/.local/share/cc-pi/env`.

Success criteria (all measurable):
1. A new Pi chat answers, streams, and survives a browser reload mid-run.
2. A prompt "plan 3 steps, track them, do them" shows a checklist that ticks live; reload restores it.
3. Changing model, thinking level, tool set, system prompt from the UI changes the next turn (verified by `get_state` / behaviour).
4. `rm` of a file in the workspace shows an approval card; Deny leaves the file.
5. A Pi process has no `CC_*` variables in `env`. Reads of `~/.hermes`, `~/.ssh`, `~/.local/share/cc-pi/env`, Control Center data, and `curl` to `127.0.0.1:3030` each raise an approval card (Pi runs as `tunitz`, so this is a policy control, not an OS boundary).
6. Hermes chats are unchanged: full existing suite green.
7. Slash commands work in a Pi chat: every shared command (see T7b) behaves exactly as in a Hermes chat, `/credits` returns the balances with no model call, and Pi's own commands (extension commands, prompt templates, skill commands) appear in the palette and run.

Out of scope: replacing Hermes, Pi packages/marketplace UI, themes/TUI settings, voice, multi-user, image input (DeepSeek is text-only; revisit with a vision model). Pi `/login` was out of scope in this v1 plan; it is implemented in T10 below.

## 2. Current context and assumptions

Codebase facts (read at HEAD d915347):
- Server chat code: `apps/server/src/chat/{hermes,runs,watcher,routes,store,models,fake-hermes}.ts`. `HermesClient` is the only backend interface; `RunManager` owns streams, ring buffer, `chat_run_events`, stop/steer, `chat.run` feed (now with `awaiting`).
- Web: `apps/web/src/pages/Chat.tsx`, `components/chat/*`, `chat/{useThread,useSessions,reduce,tool,sse,types}.ts`.
- Contract: `docs/chat-contract.md`. Gate: `bun run typecheck` + `bun test apps/server apps/web/src`, plus a 390px browser check for UI tasks.
- CC runs in Docker, `network_mode: host`, env has `CC_MASTER_KEY`, `HERMES_API_KEY`; volumes `cc-data:/data` and the chat-uploads bind mount.
- Hermes pushes nothing; backend-neutral events are our own run events (`delta`, `reasoning`, `tool.*`, `approval`, `usage`, `done`).

Pi facts:
| Fact | Evidence |
|---|---|
| Package `@earendil-works/pi-coding-agent` 1.1.0 (the `@mariozechner` name is deprecated), MIT, needs Node >=22.19 | SOURCE npm; VERIFIED installed, Node 26.7 on host |
| `pi --mode rpc`: JSONL on stdin/stdout, split on LF only | VERIFIED |
| RPC verified: get_state, get_available_models, set_model, get_available_thinking_levels (`off,low,high,max`), set_thinking_level, prompt (streams), abort (`agent_settled {aborted:true}`), steer (queued), get_messages, get_entries, new_session, switch_session | VERIFIED |
| Tool events: `tool_execution_start {toolName,args}` / `tool_execution_end {result.content, isError, durationMs}` | VERIFIED |
| Todo: extension tool `todo_write` returns full list in `result.details.todos`; `ctx.ui.setWidget` arrives as `extension_ui_request` (fire-and-forget) | VERIFIED |
| Approval: `pi.on("tool_call")` + `ctx.ui.confirm` -> `extension_ui_request {method:"confirm"}`; reply `extension_ui_response {id, confirmed}`; declined -> tool result `isError:true` | VERIFIED |
| Sessions can be listed with SDK `SessionManager.list(cwd, dir)` / `listAll(dir)`; no RPC list command | VERIFIED |
| `settings.json` is read at process start; editing while running is NOT picked up; no RPC reload (`/reload` as a prompt just starts a model turn) | VERIFIED |
| Two Pi processes with separate session dirs run concurrently | VERIFIED |
| Images over RPC: `images` field works on `prompt` (DeepSeek flash). Accepted png/jpeg/gif/webp; autoResize default <=2000x2000, ~4.5 MiB base64 limit. Anthropic vision check SKIPPED (no key) | VERIFIED in T0 (partial) |
| Local llama at `http://192.168.31.15:8080/v1` (from Hermes `custom_providers`); `llama.tunitz.com` is NOT an API | SOURCE `~/.hermes/config.yaml`; the spike probed the wrong host. Live check SKIPPED (host offline, not woken) |
| `--session` / `--session-dir` attach at spawn restores history; read back via `get_messages` | VERIFIED in T0 |
| `setActiveTools` called from an extension command applies on the NEXT turn; `get_state` has NO active-tools field (cannot confirm via state) | VERIFIED in T0 |
| `SYSTEM.md` / `APPEND_SYSTEM.md` affect only a NEW process, not a running one | VERIFIED in T0 |
| Provider error ends with `stopReason: "error"` + `errorMessage`; abort ends with `stopReason: "aborted"`. Map by `stopReason`; `agent_settled.aborted` is unconfirmed for abort | VERIFIED in T0 |
| `get_commands` returns `name`, `description`, `source` (`extension` \| `prompt` \| `skill`), `sourceInfo`; NO argument hint field | VERIFIED in T0 |
| Extension command sent via `prompt` returns disposition `handled`: no `agent_start`, no tokens; reply arrives as `extension_ui_request` method `notify` | VERIFIED in T0 |
| Prompt-template (`/name args`) and `/skill:name` sent via `prompt` return disposition `started` and DO cost a model turn | VERIFIED in T0 |

Assumptions:
| # | Question | Assumed | Why | Resolved at |
|---|---|---|---|---|
| A1 | Where does Pi run? | Host, user `tunitz`, no container (D2). Install `~/.local/share/cc-pi` (pi 1.1.0 pinned, symlink `~/.local/bin/pi`), agent dir `~/.local/share/cc-pi/agent`, workspace `~/.local/share/cc-pi/workspace`, no CC secrets, own provider keys | Pi runs bash with no approval by default; CC container holds `CC_MASTER_KEY` and the data DB | T1 (done) |
| A2 | One Pi process per chat or shared? | One `pi --mode rpc` per active chat, cap 3 (same as `MAX_ACTIVE_RUNS`), idle exit after 10 min, resume via `switch_session` | Matches one-run-per-chat; RPC is single-session | T3 |
| A3 | How does CC talk to Pi? | A tiny Bun "pi-bridge" server on the host, run as systemd user service `pi-bridge` on `127.0.0.1:3050` (bearer `PI_BRIDGE_TOKEN`): HTTP/SSE in, spawns Pi processes, relays JSONL. CC (docker, host network) reaches it on `127.0.0.1:3050`. CC never mounts Docker socket | Avoids `docker exec` privileges; keeps one narrow, authenticated port | T1, T2 |
| A4 | Effort mapping | UI Off/Low/Med/High -> Pi `off/low/low/high`; "Max" appears only when Pi reports it for the model | Pi levels are per-model (`get_available_thinking_levels`) | T6 |
| A5 | Keys | DeepSeek and Anthropic keys go into `~/.local/share/cc-pi/env` (chmod 600), written once by tun; the bridge loads them for Pi | CC must not hold them; Pi cannot read Hermes config | T1 VERIFY |
| A6 | Chat id | CC chat id = random UUID; Pi session file path stored in `chat_sessions.backend_ref` | Hermes id was the chat id; Pi has no create-by-id | T3 |
| A7 | Todo source of truth | `result.details.todos` of the last `todo_write` on the branch; widget lines only as a fallback render | Details survive reload and fork; widget is TUI text | T5 |
| A8 | Default Pi tool set | `read, bash, edit, write, grep, find, ls` + `todo_write`; Hermes-style approval for bash/write outside the workspace | Safe default; changeable in UI | T4 |

## 3. Architecture

```
Browser ──HTTPS──> Control Center (bun, :3030)
                     │  HermesClient  ──> Hermes :8642        (existing)
                     │  PiClient      ──> pi-bridge 127.0.0.1:3050 (new, bearer token, loopback only)
                     ▼
              RunManager  (unchanged: ring buffer, chat_run_events, chat.run feed, watcher)

host, user tunitz  (no container; no CC env; secrets in ~/.local/share/cc-pi/env, chmod 600)
  pi-bridge (bun, systemd user unit, 127.0.0.1:3050)  ── spawns ──>  node pi --mode rpc  (1 per active chat, cwd=~/.local/share/cc-pi/workspace/<chat>)
                                   ├─ ext cc-todo   (todo_write, details + widget)
                                   ├─ ext cc-gate   (approval: confirm via extension_ui_request)
                                   └─ ext cc-bridge (get/set tools, system prompt, settings snapshot)
  paths: ~/.local/share/cc-pi/workspace (chat workspaces); ~/.local/share/cc-pi/agent (settings.json, models.json, sessions/, extensions/); pi symlink ~/.local/bin/pi
```

Event mapping (Pi -> existing run events): `agent_start` -> `run.started`; `message_update.text_delta` -> `delta`; `thinking_delta` -> `reasoning`; `tool_execution_start/end` -> `tool.started/completed`; `message_end.usage` -> `usage`; `agent_settled` -> `done`, with the outcome taken from the last assistant message `stopReason` (`aborted` -> `interrupted`, `error` -> `failed` with `errorMessage`; do not rely on `agent_settled.aborted`, unconfirmed for abort); `extension_ui_request confirm` -> `approval` (now actionable); `setWidget cc-todo` -> new `todo` event.

New run event `todo` `{ items: [{id, content, status}] }` (full replace). Additive: old clients ignore unknown events (memory rule: ship additive).

## 4. DECISIONS LOCKED (section 4 overrides anything below)

| # | Decision |
|---|---|
| D1 | Pi is a **second backend**, not a replacement. Hermes stays default. Backend chosen at chat creation, immutable for that chat. |
| D2 | Pi runs **on the host as user `tunitz`** (no container). Decided by tun. The container route was built in T1, found unable to enforce egress without root, and abandoned. Accepted tradeoff: Pi's bash tool has the same filesystem and secret access as `tunitz`, so cc-gate (D3) is the only guard. cc-gate must cover reads and writes outside the workspace and the secret paths (`~/.hermes`, `~/.ssh`, `~/.local/share/cc-pi/env`, Control Center data). |
| D3 | Approval for Pi is real (Approve/Deny), unlike Hermes (read-only notice). Default-deny when no browser answers within 120 s. |
| D4 | Settings changes that Pi cannot apply live restart only that chat's Pi process, **between turns** (never mid-run). The UI says "applies next message". |
| D6 | Slash commands: the existing client-side set (`/new /model /reasoning /stop /retry /title /export /pin /archive /delete /steer /credits /help`) is **backend-neutral** and works unchanged in Pi chats because the browser handles it before anything is sent. Pi's own commands are added to the palette only in Pi chats, from `get_commands`. `/credits` stays the host endpoint (`GET /api/chat/credits`, `credits-http.service`); Pi never sees it, so it costs no tokens and Pi never has a route to it. `/pc` and `/llama` stay out of chat (same rule as Hermes). |
| D5 | Todo tool is a CC-owned extension `cc-todo`, not the upstream example (the example is TUI-oriented and uses add/toggle semantics; we want full-list replace like Copilot). |

## 5. Workstreams and tasks

Every task ends: `bun run typecheck` + `bun test apps/server apps/web/src` green -> "Look at it" step -> break test -> commit (on tun's go). Failing test first.

### Workstream A — isolation and bridge

**T1 Host install (done).** Skill: none needed.
- Outcome: Pi 1.1.0 pinned in `~/.local/share/cc-pi`, symlink `~/.local/bin/pi`, agent dir `~/.local/share/cc-pi/agent`, workspace `~/.local/share/cc-pi/workspace`, secrets in `~/.local/share/cc-pi/env` (chmod 600). No sudo used. The container route was built, found unable to enforce egress without root, and abandoned (D2).
- Test: `pi --version` prints 1.1.0; RPC `get_state` answers; secrets file mode is 600.
- Removed with the container route: its egress tests, container `env`/`/data` tests, and `docker exec` checks.

**T2 pi-bridge (host).** Runs as systemd user unit `pi-bridge` on `127.0.0.1:3050`, bearer `PI_BRIDGE_TOKEN`. Protocol (CC -> bridge): `POST /chats/:id/start {sessionPath?, model, thinking, settings}`, `POST /chats/:id/prompt {message}`, `.../steer`, `.../follow_up`, `.../abort`, `.../ui_response {id, confirmed|value}`, `.../command {name,args}` (passes RPC commands through an allowlist), `GET /chats/:id/events?after=<n>` SSE with an event counter, `GET /sessions` (SDK `SessionManager.listAll`), `DELETE /chats/:id`.
- Bridge keeps a per-chat ring of Pi events, so CC can reconnect (Pi itself has no replay besides `get_entries`).
- JSONL framing: LF-only splitter (a unit test with `\u2028` inside a string, which breaks readline).
- Stop/error result per run comes from `stopReason` (see T4 and section 3); the bridge forwards it in the terminal event.
- Tests: framing, allowlist rejects `bash`/unknown commands, auth required, process cap 3 -> 429, idle reaper.

### Workstream B — server adapter

**T3 Backend interface.** Skill: none needed.
- Extract the common surface from `HermesClient` into `ChatBackend` (createSession, deleteSession, setModel, listModels, startRun, stopRun, steerRun, completions optional). `HermesClient` becomes one implementation; `PiClient` the second. No behaviour change for Hermes (existing tests are the proof).
- Migration (additive): `chat_sessions.backend TEXT NOT NULL DEFAULT 'hermes'`, `backend_ref TEXT`, `pi_settings_json TEXT`.
- `POST /sessions {backend:"pi"}` -> bridge `start`; model list for Pi from `get_available_models` (cached 60 s), merged into `GET /models` with `backend` field.
- Tests: fake bridge server (like `fake-hermes.ts`) scripted from the real events recorded in the spike; Hermes suite unchanged.

**T4 PiClient frame mapping + approval.**
- Map events per section 3 into `HermesFrame`-shaped frames (rename type to `Frame` later; do not rename now).
- Stop mapping uses `stopReason` from the last assistant message (`aborted` -> `interrupted`, `error` -> `failed` with `errorMessage`), not `agent_settled.aborted` (T0 verified the stopReason values).
- Approval: `approval` event gets `id` and `options`; new route `POST /runs/:id/approval {id, choice}` -> bridge `ui_response`. Run state `needs_approval` already exists. Timeout 120 s -> deny.
- `cc-gate` policy (v1): confirm for `bash` matching `rm|sudo|chmod|chown|curl|wget|ssh|dd|mkfs|>` outside an allowlist and for `write/edit` outside `~/.local/share/cc-pi/workspace/<chat>`; also confirm any read or write touching `~/.hermes`, `~/.ssh`, `~/.local/share/cc-pi/env`, or Control Center data; everything else runs. No answer within 120 s = deny. Policy is data in `pi_settings_json`, editable in the UI.
- Tests: confirm false -> tool result isError, file survives (the spike case, as an automated test against the real Pi in T9); frame mapping table test; timeout -> deny.

**T5 Todo.**
- `cc-todo` extension (spike version is the base): tool `todo_write` full replace, details `{todos}`, rebuild on `session_start` / `session_tree`.
- Bridge emits `todo` run event from `tool_execution_end` where `toolName==="todo_write"` (details), not from the widget (A7).
- Persist last list on the assistant message (`todo_json` column, additive) so reload and history show it; `GET /sessions/:id/messages` returns `todos`.
- Tests: reducer handles `todo` replace; message round-trip; reload restores; fork keeps branch list.

### Workstream C — settings

**T6 Settings model and apply path.** Slice T6a (DONE, live-verified on real Pi): thinking level (from the chat effort), steering mode, follow-up mode, auto compaction, auto retry, manual compact; stored per chat in `pi_settings_json`, sent with every bridge `start`. Slice T6b-server (DONE, live-verified: system prompt took effect and the restart kept the session): global system prompt, AGENTS.md, default and per-chat tools, stricter-only gate rules, restart-on-change in the bridge. Not built, by decision: API keys (set once over SSH), models.json/llama (after the tun-sfx test), advanced settings.json form, extension toggles. The web screens for T6b live in Settings (global card "Pi agent") and a per-chat "Pi options" sheet in the chat menu (tun, 2026-10-11). Coverage table (UI must expose each row):

| Setting | Live over RPC? | UI control | Apply |
|---|---|---|---|
| Model / provider | yes `set_model` | existing picker | immediate |
| Thinking level | yes `set_thinking_level` | existing effort control, levels from `get_available_thinking_levels` | immediate |
| Steering mode, follow-up mode | yes | toggle (one-at-a-time / all) | immediate |
| Auto compaction on/off, manual compact | yes | toggle + "Compact now" | immediate |
| Auto retry on/off | yes | toggle | immediate |
| Session name | yes `set_session_name` | rename (already exists) | immediate |
| Active tools | no (via cc-bridge `setActiveTools`) | checklist | next message |
| System prompt (APPEND_SYSTEM.md / SYSTEM.md) | no | text area, append vs replace | next message (restart) |
| AGENTS.md | no (file) | editor | next message |
| Compaction thresholds, branch summary, retry limits, image resize/block, shell path/prefix, http proxy, transport, thinking budgets | no (settings.json) | one "Advanced" form generated from a typed schema | restart |
| models.json (custom endpoints incl. llama `192.168.31.15:8080/v1`) | no (file) | provider list: add/edit/remove, test button | restart |
| API keys | no (auth.json / env) | write-only field per provider, stored only in `~/.local/share/cc-pi/env` (chmod 600) | restart |
| Skills, prompt templates, extensions enabled | no (files/settings) | enable/disable list | restart |
| Approval policy (cc-gate) | via bridge | rule list | next message |

- Settings are stored per chat (`pi_settings_json`) over a global default (`settings` table). Server validates against a TS schema built from Pi's documented keys (T0 below checks the live schema), rejects unknown keys.
- Restart path: bridge `start` again with new files; `switch_session` to the same session file; no history loss. Never while a run is active (409, UI says "wait for the run").
- Keys are write-only: never returned by any API; audit log records the change without value.
- Tests: schema accept/reject; apply order; 409 mid-run; keys never in responses or logs (grep test over server logs in the live gate).

**T0 (first, 1 hour): re-spike the gaps** in `~/projects/pi-spike`, before T1. Status after the T0 run:
- (a) ANSWERED partial: image over RPC works on DeepSeek flash (limits in section 2). Anthropic vision check still open (no key).
- (b) ANSWERED: `--session`/`--session-dir` attach restores history (`get_messages`).
- (c) PENDING: llama at `192.168.31.15:8080/v1` as a `models.json` provider. Needs tun-sfx online (WoL); host was offline, not woken.
- (d) ANSWERED: `setActiveTools` from an extension command applies on the next turn; `get_state` has no active-tools field.
- (e) ANSWERED: SYSTEM.md / APPEND_SYSTEM.md affect only a new process.
- (f) ANSWERED: error -> `stopReason "error"`, abort -> `stopReason "aborted"`.
- (g) ANSWERED: `get_commands` gives name, description, source, sourceInfo, no argument hints; extension command via `prompt` is `handled`, no model turn.
- (h) ANSWERED: prompt templates and `/skill:name` return `started` and cost a model turn.
Exit: (c) is the only open item; its affected row in the coverage table (none yet) is downgraded if tun-sfx stays offline at T1.

### Workstream D — web

**T7b Slash commands (runs with T7).** Skill: `control-center` (references/chat-slash-and-credits.md).
- Shared set stays in `apps/web/src/chat/slash.ts`. The palette becomes `COMMANDS` + backend commands; `parseSlash` returns `{kind:"backend"}` for a backend command so it is sent as text to that backend, and `unknown` stays a local notice.
- Pi commands: bridge exposes `GET /chats/:id/commands` -> RPC `get_commands` (name, description, source = extension | prompt | skill). CC passes it through `GET /sessions/:id/commands` (cached per Pi process; refreshed after a settings restart). Shown with a small source tag; ordering: shared first, then Pi.
- Name clashes: shared commands win. A Pi command with a shared name is shown as `/pi:<name>` and sent as `/<name>` to Pi (VERIFIED in the spike: `/reload` sent as a prompt does NOT reload; it starts a model turn, so Pi built-in TUI commands such as `/reload`, `/login`, `/tree` are NOT offered). Only extension, prompt-template and skill commands are offered.
- Extension commands run without a model turn when the extension handles them. VERIFIED in T0 (`cc-ping`-style command via `prompt`): disposition `handled`, no `agent_start`, zero tokens, reply arrives as `extension_ui_request` method `notify`.
- Palette cannot show argument hints for Pi commands (`get_commands` has no hint field). Prompt-template and skill commands carry a tag saying they use a model turn.
- Pi-side custom commands owned by CC (`cc-` prefix, extension `cc-bridge`): `/tools` (show/set active tools), `/system` (show the effective system prompt length and sources), `/todos` (print the current todo list). Each returns text through `ctx.ui.notify`; the bridge turns it into a local row (the same collapsible row as `/credits`).
- Result display: any command output longer than one line goes into the thread as the collapsible local row (not stored in Hermes/Pi history), never under the composer.
- `/credits` in a Pi chat: unchanged path (browser -> CC -> host endpoint). It must never be forwarded to Pi. Test: a Pi chat sends `/credits`, the bridge receives no prompt.
- `/retry` in a Pi chat resends the last user text as a new prompt (not Pi's `clone`/`fork`); `/steer` maps to Pi `steer`; add `/followup <text>` -> Pi `follow_up` (Pi-only, shown only in Pi chats); `/compact` becomes available in Pi chats (RPC `compact`) and stays hidden in Hermes chats.
- Tests (written first): palette per backend (Hermes: shared only; Pi: shared + Pi list), clash rule, `/credits` never reaches the backend, `/compact` hidden for Hermes and wired for Pi, command list refresh after restart, unknown command text built from the full list.
- Live gate (T8): in a real Pi chat run `/help`, `/credits`, `/compact`, `/followup`, one extension command (`cc-ping`), one prompt-template command, one skill command; screenshot at 390px.

**T7 UI.** Skill: `frontend-design`, `ui-copy-rules`. Client value first, minimal surface:
- New-chat control: backend choice (Hermes / Pi), defaulting to last used.
- Todo panel: a collapsible checklist pinned above the composer while the run is active and after it ends if any item is not completed; `[x]/[~]/[ ]` icons; count "2/5". No new page.
- Approval card: command, Approve / Deny, countdown. Replaces "Approve this in Hermes" for Pi chats only.
- Settings: per-chat sheet opened from the chat header (phone: full-screen), sections Model, Thinking, Tools, Prompt, Advanced, Providers/keys; each row shows "applies now" or "applies next message".
- Queue: while running, composer offers Steer (now) and Follow-up (after the run), matching Pi.
- Wording per `ui-copy-rules`; no sentence-case violations; every control has a label for screen readers.
- Tests: reducer, todo panel render (props), settings form validation, approval timeout display.
- Gate: 390px screenshots of empty chat, running with todos, approval card, settings sheet; read aloud each for overlap/truncation.

### Workstream E — testing and release

**T8 Live gate against real Pi** (costs a few cents of DeepSeek flash): scripted scenarios from section 1 criteria 1–5, run through the real UI path (CC test instance on a spare port, as done for the watcher), including reload mid-run, two chats concurrently, Deny, settings change then next message, and a pi-bridge restart mid-idle.

**T9 Release.** Deploy order: pi-bridge systemd user unit first (idle), then CC API, then web (memory rule: API before web). Back up `cc-data` volume before the migration. Update `docs/chat-contract.md`, `docs/chat-plan.md` pointer, the `control-center` skill (new backend, ports, env), and memory. Push, verify on `:3030`.

Milestones:
| M | Contains | Done when |
|---|---|---|
| M0 | T0 re-spike | six questions answered |
| M1 | T1 T2 T3 T4 | a Pi chat streams, stops, approves, with Hermes untouched |
| M2 | T5 T6 | todos + all coverage rows work |
| M3 | T7 T8 T9 | deployed, 390px verified |
Excluded from M1: settings UI, todo panel, image input.

## 6. Risks, tradeoffs, open questions

| # | Risk / tradeoff | Mitigation |
|---|---|---|
| R0 | Pi has full user access on the host (runs as `tunitz`) | cc-gate default-deny with a 120 s timeout; no API for editing the cc-gate policy by unauthenticated callers |
| R1 | Pi is YOLO by default; a prompt-injected page could run commands as `tunitz` | No CC secrets in Pi's env, secret paths covered by cc-gate, cc-gate default policy, workspace-only writes by default, no Docker socket |
| R2 | No RPC reload: settings changes cost a process restart (~1–2 s, resume via `switch_session`) | Apply only between turns; show "applies next message" |
| R3 | "Everything controllable" is false for TUI-only things (themes, custom components) | Out of scope list; coverage table is the contract |
| R4 | Pi package rename/deprecation (`@mariozechner` -> `@earendil-works`) | Pin exact version, bump deliberately, T8 as upgrade gate |
| R5 | Extensions run in-process with Pi's permissions | Only CC-authored extensions loaded; `extensions` setting is read-only in the UI; skills/prompts from the UI are data, not code |
| R6 | Effort scales differ (Pi `off,low,high,max` vs CC four) | A4 mapping; levels come from Pi per model |
| R7 | Bridge is a new network service | Bearer token, bound to 127.0.0.1, single caller, rate limit, allowlisted commands |
| R8 | Second backend doubles the test matrix | Shared contract tests run against both fakes; Hermes suite is the regression guard |
| R9 | Pi event ring in the bridge is lost on bridge restart | CC marks the run `interrupted` (existing `recoverRuns` logic) and the session file keeps history |
| R10 | Accepted: host-user Pi, no container (D2) | Weaker isolation than a container; tradeoff recorded in D2, guarded by cc-gate |
| R11 | Rejected: porting Hermes's todo into this | Hermes has its own tool; this plan is Pi-only |
| R12 | Local llama check (T0 c) still pending: tun-sfx offline, not woken | Run T0 (c) when tun-sfx is online; the llama provider stays unverified until then |

Open questions:
| # | Question | Default | Decided at |
|---|---|---|---|
| OQ1 | Which provider/model is Pi's default? | **LOCKED (tun, 2026-10-11): default `anthropic/claude-sonnet-5-5`, fallback `deepseek/deepseek-flash`** | done |
| OQ2 | Should Pi chats see the same uploads dir as Hermes? | No; uploads copied into `~/.local/share/cc-pi/workspace/<chat>/uploads` by the bridge | T3 |
| OQ3 | Should Pi chats appear in the same sidebar? | Yes, with a small backend tag | T7 |
| OQ4 | Does the watcher/await logic apply to Pi? | No: Pi has no background subagents | T3 |
| OQ5 | Anthropic key in Pi's env? | **LOCKED: yes** (tun adds it to `~/.local/share/cc-pi/env`, chmod 600; also needed for the vision test) | done |
| OQ7 | Should Pi's prompt-template and skill commands show in the palette? | **RESOLVED (T0):** Yes, with a source tag saying they use a model turn; no argument hints (not in `get_commands`); hide any command whose source is a Pi built-in TUI command | T0 (g)(h) done |
| OQ6 | tun-sfx llama online for tests? | WoL then test. OPEN: T0 did not wake the host (check (c) pending) | T0 (c) |

Build status: tun builds this in a separate session; nothing is started from the planning session.

Final step: push to GitHub `tunitz/control-center`, deploy in the order above, verify live, update skill + memory.

## T7 status (web, 2026-10-11)

DONE and driven in a 390px browser against a throwaway Control Center + the real bridge and Pi: model picker with Pi tag (picking a Pi model starts a Pi chat, a chat keeps its backend), Pi chat label and placeholder, approval card (Approve/Deny, 44px, Approved/Denied/Not answered afterwards, full command shown), task list under the tool rows, thinking-level choices narrowed to what Pi reports, `/compact`, "Pi options" sheet (per-chat tools, queue modes, auto compaction/retry, Compact now), Settings card "Pi agent" (extra instructions, notes, default tools, stricter-only approval rules).
Not built, by decision: Pi slash commands / prompt templates (T7b), API keys, llama endpoint, advanced form.
Bugs found by the live drive and fixed: model ids resolved against the wrong backend on send/PATCH; a start that did not name tools reset a chat's tools; cleared tools override not reaching a running process; long DeepSeek names clipped the composer toolbar; approval command scrolled sideways.

## T8 status (live gate, 2026-10-11)

DONE: `tools/pi-live-gate.ts` passes 14 of 14 against a throwaway Control Center, the real bridge, real Pi and DeepSeek flash (about 2 minutes with the 2-minute approval timeout). Run: start a test instance on :3031 (see the control-center skill, test-instance reference), then `CC_PASSWORD=... bun run tools/pi-live-gate.ts` (add `--skip-timeout` to skip the 2-minute scenario).
Bugs the gate found, each fixed with a test that failed first:
- The bridge's event stream sent no bytes until its first 15 s keepalive, so every Pi reply started 15 s late. It now sends a comment line on open (run time of a plain answer: 15 s -> 1.1 s).
- The fourth chat got a 429 while three idle chats held processes for 10 minutes. The bridge now closes the longest-idle chat to make room (429 only when all are mid-run).
- Pi stores live settings in its global `settings.json`, so one chat's values leaked into the next. The server now sends all four settings on every run.
- Stop while an approval was waiting hung for 15 s and left the run stuck. The bridge now declines open questions before aborting.

## Models and Anthropic in Pi (2026-10-11)

- Hermes picker: Sonnet 5.5, Haiku 5.5, DeepSeek Flash (OpenAI and local Llama removed by tun).
- Pi picker (curated in `apps/server/src/chat/pi.ts`): all DeepSeek models, and only Opus 5.5, Sonnet 5.5, Haiku 5.5 from Anthropic (Pi lists 18 Anthropic models). The sidebar tags every chat Hermes or Pi.
- Anthropic in Pi uses `ANTHROPIC_OAUTH_TOKEN` in `~/.local/share/cc-pi/env` (the bridge passes it to Pi). It is a Claude subscription token. LIVE RESULT: Anthropic answers third-party apps with 400 "Third-party apps now draw from your extra usage, not your plan limits", so Pi's Anthropic models need extra usage enabled on the account (or an API key in `ANTHROPIC_API_KEY`).

## T10 status: `/login` in the chat (2026-10-12)

DONE. Pi's provider sign-in is available from a Pi chat as `/login [provider]`; the T7b note that
Pi built-in TUI commands are not offered still holds for `/reload`, `/tree` and the rest, but
`/login` now has a server-driven implementation.

- The bridge owns one Pi `ModelRuntime` pointed at `~/.local/share/cc-pi/agent` (the same
  `auth.json` the spawned `pi --mode rpc` processes read), so a completed sign-in is usable on the
  next run without restarting any chat. One sign-in runs at a time.
- `pi-bridge/src/login.ts` maps the runtime's `prompt()`/`notify()` to SSE (`prompt`, `auth`) and
  back over HTTP; `pi-bridge/src/bridge.ts` exposes `/auth/providers`, `/auth/login`,
  `/auth/login/:id/{events,response,cancel}` behind the bearer token. `auth.json` is never returned.
- Server routes live in `apps/server/src/chat/routes.ts`; the web sheet is
  `apps/web/src/components/chat/LoginSheet.tsx` (open from the chat menu via `/login`).
- Model curation changed so a signed-in provider is actually useful: only Anthropic is trimmed to
  Opus/Sonnet/Haiku 5.5; every other provider Pi has a key for is shown.
- Tests: `pi-bridge/test/login.test.ts` (scripted runtime), route tests in
  `apps/server/src/chat/backend-routes.test.ts`, palette tests in `apps/web/src/chat/slash.test.ts`.
  Live-verified against the installed Pi 1.1.0: `/auth/providers` lists the real provider set and a
  DeepSeek API-key sign-in prompts for a `secret`, then cancels cleanly.
