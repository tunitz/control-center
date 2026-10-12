# Pi chat backend: frame mapping, approval, gate

## Layout
- `pi-bridge/`: HTTP+SSE bridge in front of Pi RPC, token-protected, 127.0.0.1:3050, systemd user service.
- `pi-bridge/extensions/cc-gate.ts`: approval extension loaded by every Pi process (symlinked into Pi's extension folder).
- `pi-bridge/extensions/browser.ts` + `src/browser.ts`: the browser tools and their Pi-free helpers (see "Browser tools").
- `pi-bridge/src/skills.ts`: skill discovery, the disabled set and the launch flags (see "Skills").
- `pi-bridge/src/pi-config.ts`: the global config files and the Claude Code status. `src/login.ts`: Pi provider sign-in for the chat's `/login`. `src/pi-dirs.ts`: the working-folder picker and cwd rules.
- `apps/server/src/chat/pi.ts`: `PiClient` (implements `ChatBackend`), `mapPiEvent(event, data, model, state)` returns zero or more frames.
- `apps/server/src/chat/fake-pi-bridge.ts`: in-process fake. Scenarios by prompt text: SLOW (abort), ERR (error stop), TOOL (one bash call, ok), GATE (bash call that needs approval), TODO (one todo_write call, 2 items).

## Event -> frame
- Assistant turns store an ordered `blocks` list (`blocks_json`): text segments, tool rows (by `id`) and approval cards, in stream order. `Message.tsx` renders it so a Pi approval sits where it was requested, not above the turn. `text`/`tools` stay for search/export; a row without blocks falls back to tools-then-text. The server (`runs.ts`) builds blocks and persists them, including while an approval is pending, so a reload keeps the card; `recoverRuns` marks a pending card `ended`. Legacy `thread.approvals` is gone; approvals live in the message.
- `message_update` with `text_delta` -> delta; `thinking_delta` -> reasoning. Other update kinds are ignored.
- `tool_execution_start` -> tool.started, with a preview: the command for bash, the path for read/write/edit.
- `tool_execution_end` -> tool.completed. `isError` true means blocked or failed; the preview is the result text (cut at 300 chars).
- `tool_execution_end` for `todo_write` (not isError) also yields a `todo` frame. Read the list from `result.details.todos`, never from the widget or the text content. A todo frame is a full replace of the list; malformed items are dropped and a non-list value yields no frame.
- Live todo probe: the `cc-todo.ts` extension lives in `pi-bridge/extensions/` and is symlinked into Pi's extension folder, like cc-gate. It imports Pi packages that exist only inside Pi, so it is excluded from the bridge tsconfig; verify it by a live Pi run, not by typecheck.
- `message_end` from an assistant -> usage. Pi sends `input`, `output`, `cacheRead`, `cacheWrite` and `cost.total` per model call; the frame is a running total over the run's calls (`PiMapState`), plus `context`, the LAST call's `input + cacheRead + cacheWrite`. `input` alone is only the uncached tail, so it must never be shown as the context (`chat-ui.md`, "Tokens and context"). The raw event reaches the server unchanged, so this mapping needs only the container rebuilt, not a bridge restart.
- `extension_ui_request` with method `confirm` -> approval frame with id, command (the message), note (the title), options approve/deny. Other methods are dropped.
- `agent_settled` -> done. stopReason `aborted` is interrupted, `error` is failed with errorMessage, anything else is complete.
- `process_exit` -> done failed.

## Approval route
- `POST /api/chat/runs/:id/approval {id, choice: approve|deny}`. Returns 409 when the run is finished, nothing is pending, the id is stale, or the chat is Hermes (Hermes approvals are read-only).
- The Pi run id is the chat id. The answer goes to `POST /chats/:id/ui_response {id, confirmed}`.
- The run manager keeps `approvalId` and clears it when any non-approval frame arrives, so a stale answer is rejected.
- YOLO: when `chat_sessions.yolo` is on, the run manager calls `respondApproval(approve)` itself the moment a Pi `approval` frame arrives, and `approvePending(sessionId)` answers a request that is already waiting when YOLO is switched on. It runs with no browser attached; the web only reads and writes the flag.

## Gate policy (cc-gate)
- Asks before risky shell commands, writes outside the chat workspace, and any tool touching `~/.hermes`, `~/.ssh`, the Pi env file or the Control Center data folder.
- The protected list also covers Pi's own config files in the agent directory (prompt files, `cc-gate.json`, `cc-config.json`, `settings.json`, `models.json`, `extensions/`, `auth.json`). Without this a chat could rewrite its own rules through its write tool.
- No answer in 300 s (5 min) counts as deny.
- Overrides: `cc-gate.json` in Pi's agent directory. It can only ADD: `extraProtectedPaths` (home-relative, no `..`) and `extraRisky` (patterns that compile). Any other key is ignored. A malformed file falls back to the default policy, never to allow-all. The server's PUT rejects loosening keys with 400, and the bridge enforces the same rule, so two places must agree when a key is added.
- Browser tools: `browser_navigate` to anything other than `data:`, `about:` or loopback, and every `browser_eval`, ask first (`navigatesOut` and `evaluate` in `cc-gate.ts`). The read-only and interaction tools (snapshot, click, type, press, scroll, back, get_images, screenshot, vision, close) run silently.
- Pattern matching, not a security boundary. `python -c` can still write a file without a prompt. Say so when reporting the gate.

## Global configuration files (T6b)
- The bridge owns these files in Pi's agent directory: `cc-append-system.md` (system prompt text, passed to each chat's Pi as `--append-system-prompt`; deliberately not `APPEND_SYSTEM.md`, which Pi auto-loads and subagents would inherit), `AGENTS.md` (notes), `cc-config.json` (`defaultTools`, `claudeBridge`, `browser`), `cc-gate.json`, and `cc-skills.json` (the disabled skills, owned by `skills.ts`). `GET /config` also returns `knownTools`, `claudeCode` and `browserStatus` so the Settings card can warn about a missing prerequisite. Validation and writes live in `pi-bridge/src/pi-config.ts`: validate the whole patch first, then write each file atomically (temp + rename, mode 600). A rejected patch changes nothing.
- Empty text removes the file rather than writing an empty one.
- Pi cannot change these files: `cc-config.json`, `settings.json` and the rest are on the gate's protected list, so a toggle has to be flipped in the Settings UI.
- Each Pi process is launched with a key built in `start()` in `bridge.ts`: the tool list (`--tools`), a fingerprint of the files above, the skill launch flags, a signature of the discovered skills, and the Claude-bridge and browser switches. A different key means the next message restarts that chat's process on the same session file; a chat that is mid-run is refused with 409 and keeps going. Keep the key to what Pi reads at startup, or unrelated edits restart chats for no reason.
- Verify a config change on the live bridge by starting a chat, changing the prompt, and checking that the reply follows it (a token like an end-of-reply marker). A readback of the file alone does not prove Pi read it.
- Bridge 400 and 409 are caller errors. The server must pass their message through as 400/409, not wrap them as 502 (Pi's own refusals are 502).

## Pitfalls found by the live gate (tools/pi-live-gate.ts)
- An SSE endpoint must write bytes on open. With nothing queued the response headers wait for the first event or keepalive, and a client that awaits the stream before it prompts stalls that long (bridge: every reply 15 s late). Time the prompt call and the first token separately before blaming the model.
- Pi persists live settings (steering, follow-up, compaction, retry) in its GLOBAL settings.json. Send every setting on every run, or one chat's values leak into the others. After tests, reset `~/.local/share/cc-pi/agent/settings.json` to `{}`.
- Abort cannot finish while a tool is blocked on a question. The bridge declines open questions (extension_ui_response cancelled, fire-and-forget `write`, not `send`) and then aborts.
- Process cap 3 evicts the longest-idle chat that is not mid-run; the session file resumes it. 429 only when all are busy.
- Gate prompts that ask for a long list let the model call bash; use a no-tools story prompt for 'long run' scenarios.
- Run: start a test instance on :3031 with PI_BRIDGE_TOKEN from `~/.local/share/cc-pi/env` and DEEPSEEK_API_KEY unset, then `CC_PASSWORD=... bun run tools/pi-live-gate.ts [--skip-timeout]`. Clean `~/.local/share/cc-pi/workspace/*` and `agent/sessions/*` afterwards (test chats leave directories).

## Provider auth (Anthropic) and the Claude Code bridge
- Pi's own `anthropic` provider sends a Claude subscription token as a third-party app, and Anthropic refuses it: 400 "Third-party apps now draw from your extra usage". Enabling extra usage or setting `ANTHROPIC_API_KEY` in the Pi env file still works, but the subscription route is the Claude Code bridge below. The DeepSeek Pi models have their own key and are unaffected.
- Do not copy Hermes's way round it (it sends Claude Code's headers, system prompt and renamed tools on the wire so the subscription looks first-party). That imitation exists to get past Anthropic's billing check, can get the account suspended, and Anthropic keeps changing what it fingerprints.

## Claude Code bridge (the working subscription route)
- `pi-claude-bridge` is a Pi extension that runs the real Claude Code through the Agent SDK and registers `claude-bridge/<id>` models. Extension: `~/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts` (`pi install npm:pi-claude-bridge`; override with `PI_BRIDGE_CLAUDE_BRIDGE_EXTENSION`). Claude Code CLI: `~/.local/bin/claude` (`npm install -g --prefix ~/.local @anthropic-ai/claude-code`). Its sign-in is `~/.claude/.credentials.json` (`claude auth status` shows the plan; the account is on Pro, so no `plan` key). `~/.local/share/cc-pi/agent/claude-bridge.json` sets `provider.pathToClaudeCodeExecutable`; for a Max plan add `"plan": "max"`.
- Switch: Settings, Pi agent group, "Run Claude models through Claude Code" (`claudeBridge` in `cc-config.json`). It does nothing if the extension file is missing, so a half-set switch never strands a chat.
- When it is on the bridge: (1) loads the extension with `-e` for chats and for the model probe (`listModelsOnce`), (2) leaves `ANTHROPIC_API_KEY` and `ANTHROPIC_OAUTH_TOKEN` out of the Pi child's env, because they override Claude Code's own login and every turn then fails (pi-claude-bridge issue #107), and (3) drops the native `anthropic` models from the list (`onlyUsableAnthropic` in `sessions.ts`). Step 3 matters: Pi lists `anthropic/claude-sonnet-5-5` and `claude-bridge/claude-sonnet-5-5` with the same id, the picker keys by id alone, and a duplicate resolved to the blocked provider. `curated()` in `pi.ts` trims only provider `anthropic`, so the bridge's models pass through.
- Sign in from a shell with no browser: `claude auth login` prints an OAuth URL and waits for a code on stdin, and the PKCE verifier lives in that process, so the URL is dead once the process exits. Start it detached with stdin from a FIFO that a long `sleep` holds open, read the URL from its log, give it to tun, write the code he pastes into the FIFO, wait for "Login successful.", then run `claude auth status`. Kill the `sleep` by PID (never `pkill -f`) and delete the FIFO directory.
- Verify end to end: `pi -e <extension> --model claude-bridge/claude-haiku-4-5 --print "Reply with exactly: OK"` and expect the reply, not a 400. A model-list check alone does not prove auth.

## Browser tools
- `extensions/browser.ts` registers `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_press`, `browser_scroll`, `browser_back`, `browser_get_images`, `browser_eval`, `browser_vision` (a screenshot returned as an image), `browser_screenshot` and `browser_close`. Each shells out to the `agent-browser` CLI with one session per Pi process (`cc-<pid>`), closed on exit. The bridge loads it with `-e` when `browser` is on (`browserStatus` reports the extension, the CLI and a Chromium; override the path with `PI_BRIDGE_BROWSER_EXTENSION`).
- The helpers in `src/browser.ts` are unit-tested. The extension imports Pi packages that exist only inside Pi, so it is excluded from the bridge tsconfig: verify it by a real Pi run, not by typecheck.
- Binary resolution: `CC_BROWSER_BIN`, then PATH, then the CLI Hermes bundles (`~/.hermes/tools/agent-browser-*/bin/agent-browser-linux-x64`). Chromium: `AGENT_BROWSER_EXECUTABLE_PATH`, then Hermes's (`~/.hermes/tools/chromium-*/chrome-linux64/chrome`). The Playwright Chromium on this host cannot start (`libnspr4.so` missing), so Hermes's is what works. With no CLI found the extension registers nothing.
- Known gap, verified with real Pi: a tool selection (per-chat tools in the Pi options sheet, or `defaultTools` in Settings) becomes `--tools a,b,c`, which replaces the whole selection, and the browser tools are not in `KNOWN_TOOLS`. A custom selection therefore drops them silently; Pi's defaults keep them. The fix is to append the browser tool names to `--tools` when `browser` is on.
- Check: `pi --no-session --model deepseek/deepseek-flash -e pi-bridge/extensions/browser.ts --tools browser_navigate --print 'Call browser_navigate with url "data:text/html,<h1>TOKEN-42</h1>", then reply with only the h1 text'`. Name the model: the agent dir's last-used model may be the blocked native Anthropic one.

## Skills
- Skills live in `~/.agents/skills` (shared by Hermes and Pi; `~/.hermes/skills` is a symlink to it). That is the single global root. `skills.ts` lists skills (a folder with a `SKILL.md` that has both `name` and `description`; dot-directories such as `.archive` are skipped): global from `~/.agents/skills` and the `skills` array of `<agent>/settings.json`; project from `<cwd>/.pi/skills`, `.agents/skills` up to the repo root (never above `~`) and `<cwd>/.pi/settings.json`. The project folders scanned are the distinct `chat_sessions.cwd` values of Pi chats (`listPiCwds`). The disabled paths are compared by realpath.
- Pi has no per-skill switch. The disabled set is `cc-skills.json` (absolute `SKILL.md` paths), applied at launch as `--no-skills` plus `--skill <dir>` for each enabled skill. Nothing disabled means Pi's own discovery is left alone. Skills that come from npm packages are not re-added once discovery is suppressed.
- Pi reads skills only at startup. The launch key includes `skillsSignature` (path and mtime of every discovered `SKILL.md`), so a skill that is added, edited or removed restarts an idle chat's process on its next message, with nothing to toggle. Toggling a skill also recycles idle chats at once. `GET` and `PUT /api/chat/pi/skills` front it; the UI is `PiSkillsCard.tsx` in the Pi agent settings group.
- There is no separate Pi skills copy: `~/.local/share/cc-pi/agent/skills` no longer exists, and Pi reads `~/.agents/skills` natively. Do not recreate a copy.
- Pi's own `/reload` is a terminal-screen command. Sent over RPC it reaches the model as ordinary text (tested: the model replied about the word "/reload"), so it is not offered as a chat command. Config, tool, skill and Claude-bridge changes restart a chat through the launch key; an edited extension or a project `AGENTS.md` waits for the 10-minute idle restart or a bridge restart. A real `/reload` would restart that chat's process on the same session.

## Model lists
- The Hermes picker is `DEFAULT_MODELS` in `apps/server/src/chat/models.ts`. The Pi picker is a curated subset in `apps/server/src/chat/pi.ts`, because Pi's own registry is far larger (it lists 18 Anthropic models).
- Ship exactly the list the user names, per backend. Keep every DeepSeek model in Pi's list unless told otherwise.
- Pi models carry a `contextWindow` from the bridge's list; the Pi meter reads it. The `claude-bridge/*` models are listed by the bridge while the Claude switch is on (14 of them), and the native `anthropic` ones are removed then.
- A model id on the server is accepted only if it is on that backend's curated list. Test the rejection with an id that is valid on the other backend, so the test shows the backend check and not just a missing id.

## Deploy (host-side parts)
- `pi-bridge` is a systemd user unit (`~/.config/systemd/user/pi-bridge.service`, copy of `pi-bridge/pi-bridge.service`); restart with `systemctl --user restart pi-bridge` after any change under `pi-bridge/` (it runs from the repo checkout). Linger is on.
- The CC container gets `PI_BRIDGE_TOKEN` (and optional `PI_BRIDGE_URL`) from the repo `.env` via docker-compose; empty token = Pi chats off. Host network lets it reach 127.0.0.1:3050.
- Deploy order: bridge first (idle), then the CC container. Back up `cc.db` first; the migrations are additive (chat_sessions.backend, backend_ref, pi_settings_json, cwd, yolo; chat_messages.todos_json, blocks_json; the chat_commands table).

## Live gate probe (cheap, real)
Run a Bun script that spawns the real Pi with DeepSeek flash. Answer each `extension_ui_request` by writing the response back on stdin. Use two prompts: a write to `~/.hermes/cache/scratch/...` (expect a prompt, after Deny the file must not exist) and a write inside the workspace (after Approve the file must contain the text). Delete the probe file afterwards. Scratch scripts go in `~/.hermes/cache/scratch`, not `/tmp`.

## Compaction (fixed: 256k trigger, 51,200 kept)
- Not configurable. The bridge hard-codes `COMPACT_AT_TOKENS = 256000` and `KEEP_RECENT_TOKENS = 51200` (`pi-bridge/src/pi-config.ts`). It writes them into Pi's `settings.json` at bridge startup and on every chat start (`syncCompaction`), so models added later are covered with no user action.
- Per model (from `models-store.json`): window > 256k gets `modelOverrides[provider/id].reserveTokens = window - 256000`. Window <= 256k gets Pi's default reserve 16384 and `keepRecentTokens = min(51200, floor((window - 16384) / 2))`. `anthropic/<id>` also gets `claude-bridge/<id>`.
- `compaction.enabled` is kept as Pi wrote it (default true). The per-chat auto-compaction toggle and "Compact now" in the Pi options sheet are unchanged.
- `PUT /config` rejects a `compaction` key with 400 and changes nothing. A corrupt `settings.json` makes chat starts return 400 and is never overwritten; fix the file by hand.
- Verify with `pi-bridge/test/compaction.test.ts`, or by reading `settings.json` after a chat start.
- Limit: Pi checks the threshold before each prompt, not inside a long tool loop. One prompt that runs far past the threshold still grows; the user must stop a looping run.
- `/compact` in a Pi chat calls the compact endpoint. Pi's "Nothing to compact" on a small session is returned as 502 with Pi's message (see the rule above).

## Tests
- `bun test apps/server apps/web/src` covers the mapping (`pi-map.test.ts`), the client (`pi.test.ts`) and the routes (`backend-routes.test.ts`). Full suite and `pi-bridge` tests must both be green before a commit.
- `cd pi-bridge && bun test` (or `bun test pi-bridge/test` from the repo root) covers the bridge, the gate policy (`gate.test.ts`), the config writer, skills and the browser helpers. `bun run test:live` there runs one real Pi prompt on DeepSeek flash (a few cents).
- A test that reads an SSE response body must not hand that same body to the code under test: the second reader fails with a locked-stream error that looks like a production bug. Read the stream in one place only.
- Run the server suite more than once before calling it green. A run-order-dependent failure can pass on a re-run; re-run until you see the same count every time, and report any single failure you could not reproduce.
