# Chat UI and server features: what exists, where it lives, the traps

The wire shapes are in `docs/chat-contract.md` (the source of truth). This file is the map of features built on top of them. Read it before changing `Chat.tsx`, `components/chat/`, `chat/` or `apps/server/src/chat/`.

## Message actions
- **Delete a message**: `DELETE /api/chat/sessions/:id/messages/:mid` removes the mirror row and its attachment files. 409 while a run is active. The backend's own history is not touched.
- **Retry is a rebranch**: `POST .../messages/:mid/retry` drops that user message and everything after it (and the command rows anchored at or after it), then runs the text again, so only the new reply is shown. Text only: attachments are not re-sent.
  - Pi chats also call Pi's `fork` on the matching user message first (`PiClient.forkUserMessage`, best effort), so Pi's own branch is rewound. Hermes has no rewind: its context still holds the dropped turns.
  - The bridge allowlist must contain `fork`, `clone` and `get_fork_messages` (`ALLOWED_COMMANDS`, pinned by `allowlist.test.ts`).
- Server: `deleteMessageRoute`, `retryMessageRoute` in `routes.ts`. Web: `thread.remove` and `thread.retry` in `useThread.ts`; the `/retry` command and the retry button share them.

## Command rows are saved
- Every slash command leaves a collapsible "local" row in the thread. Rows live in the `chat_commands` table (`session_id`, `seq` = the message they follow, `name`, `body`). `GET /sessions/:id/messages` returns them as `commands`; `POST /sessions/:id/commands {name, body, block?}` adds one. They are never sent to the model. Export interleaves them; delete and retry drop the ones at or after the cut.
- Page commands record through `onAction` in `Chat.tsx` (an empty result string records nothing); composer-only commands record through `p.onNote`.
- A command run while a reply streams records `block` (the reply's block count then, `midReplyBlock()` in `Chat.tsx`) and is drawn inside that reply after that many blocks (`rowsAt` in `Message.tsx`), so it sits in stream order like a tool row. The working row for a slow command uses the same slot. `block` null = after the message.
- A row renders after the message with the highest `seq` that is <= its `afterSeq` (range match, not equality). Only the newest 40 messages load but every row comes back, so an equality match used to push rows for older messages to the bottom of the thread, under the latest reply. Rows older than the first loaded message stay hidden until "Load older messages", and show at the top once nothing older exists.
- A new command: see `chat-slash-and-credits.md`.

## Tokens and context (the Pi trap)
- Pi reports `input`, `output`, `cacheRead`, `cacheWrite` per model call. With prompt caching `input` is only the uncached tail: a claude-bridge chat showed "22 in" for a prompt of about 553,000 tokens. The prompt size is `input + cacheRead + cacheWrite`. Never show `usage.input` as the context of a Pi chat. Hermes `input_tokens` is summed over every model call of the run (each tool call re-sends the chat), so it is not the context either.
- `TokenUsage` (`store.ts`, `chat/types.ts`, contract): `input`, `output`, and optional `cacheRead`, `cacheWrite`, `context` (the last call's whole prompt; Pi only), `calls`, `costUsd`, `ttftMs`, `durationMs`. Pi frames are built by `mapPiEvent` with a `PiMapState`; Hermes frames by `parseFrame` (`run.completed`).
- `ttftMs` and `durationMs` are measured by the run manager (run start to the first delta, reasoning or tool start, and to the end), so they exist for both backends. They are merged into the stored usage in `finish()`, so they appear after the reload that follows `done`. A run that fails before any token stores no usage.
- The meter: `estimateContextTokens(messages, backend)` in `chat/context.ts`. Pi uses `usage.context` as reported and returns null when no reply has it (the meter hides rather than lie). Hermes keeps its estimate (base prompt + visible text, capped by the last reported input). The window comes from the model: Pi models carry `contextWindow` from the bridge's model list, Hermes models use `config.contextWindow`.
- UI: the line under each reply is a button (`UsageRow` in `Message.tsx`) that expands to `usageRows()`. `/usage` prints `usageReportText()` from `GET /sessions/:id/usage` (`sessionUsage()` in `store.ts`). All formatting is pure and tested in `chat/usage.ts`.
- Compaction count: Pi sends no compaction event, so it is inferred. A reply whose `usage.context` is more than 25% below the previous reply's counts as one (`countCompactions` in `chat/context.ts`; the same rule in `sessionUsage()` as `UsageReport.compactions`). A manual `/compact` counts too. The usage line shows `compacted N×` (count as of that reply) and `/usage` prints `Compacted: N times`. The thread view counts only loaded messages, so it can undercount until older ones load; `/usage` covers the whole chat.
- Replies stored before these fields existed hold only input and output; their context cannot be recovered.

## Approvals and YOLO
- A pending Pi approval is the full card with Approve and Deny. Once approved, denied or ended it folds into one row like a tool call: title, one-line command preview, status chip (`approvalSummary` in `chat/approval.ts`; `.stat-ok`, `.stat-err`, `.stat-off`). Tap to see the full command. Hermes approvals have no id and stay a read-only notice.
- **YOLO is server-side**: `chat_sessions.yolo`, set by `PATCH /sessions/:id {yolo: boolean}` (the `/yolo` command). The run manager answers a Pi gate request itself when it arrives, and `approvePending` answers one that is already waiting when YOLO is switched on. It used to be a React effect, so closing the app left the gate waiting until it timed out to deny. Never put auto-approve in the web. The header and the sidebar row show a YOLO tag.

## Sidebar groups
- `Sessions.tsx` renders each `groupSessions` group (Pinned, Today, Yesterday, Previous 7 days, Older) as an accordion header (`.sec-toggle`, chevron, chat count). Pinned and Today start open, the rest closed; a search query opens all. Open state is component state only, so it resets on reload.

## New chat and the default model
- The sidebar's New chat button opens a Hermes / Pi menu (`Sessions.tsx`). Each row shows the model a new chat starts with: `defaultModelFor` and `newChoices` in `chat/pi.ts` pick the configured new-chat model, then Hermes's `defaultModel`, then the first online model of that agent. `newChat(backend)` in `Chat.tsx` creates the chat. `/new`, `/new hermes`, `/new pi` do the same. Pi chats still ask for a working folder first.
- The setting is `chat.newChatModel` in the `settings` table (`pi:<id>` for a Pi model), returned as `newChatModel` by `GET /config`. There is no Settings screen for it. In the live database it is `pi:claude-sonnet-5-5`. Change it with a one-off:
  `docker exec control-center-control-center-1 bun -e 'import{Database}from"bun:sqlite";const d=new Database((process.env.CC_DATA||"/data")+"/cc.db");d.query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("chat.newChatModel","pi:claude-sonnet-5-5")'`
- `defaultModel` stays a Hermes model on purpose: `POST /sessions` with no model uses it.

## Send while busy, Stop
- Copies Hermes's gateway `busy_input_mode: interrupt` (tun's choice; Discord does the same). A plain message sent while a run is active is a normal Send. The server (`sendRoute`, `RunManager.busyMode`) then either **interrupts** (stops the run, waits for it to end, starts the message) or **queues** it (202 `{queued, position}`) when the chat has background subagents (`awaiting` or a running `delegate_task`), a manual compaction is in flight, or a queue already exists. Queued messages sit in memory (lost on a server restart), run one at a time when the run or compaction ends, and are dropped by Stop. Cap 10, then 429. The web leaves a `/queued` row. Auto-compaction inside a Pi run cannot be detected (Pi sends no event), so it interrupts.
- `chat/sendmode.ts` decides the label, tooltip, placeholder and hint; the button stays Send while running, beside Stop. `routeInput` keeps any `/...` text a command, never a message. `/steer <text>` is the only way to steer, and the Steer button and Enter-to-steer are gone (the `steer` icon and `.btn.steer` CSS are unused).

## Settings page
- `pages/Settings.tsx` builds a `groups` array (Appearance, Monitoring, Pi agent, Security) for `components/Accordion.tsx`: one open at a time, the last one remembered in localStorage `cc:settings-open` (`lib/accordion.ts`). Closed bodies stay mounted but `hidden`, so a half-edited form keeps its text. Add a setting by adding a block inside a group's body, as an `.acc-sub` with an `.acc-subtitle`, not a `.card`. The Pi agent group holds `PiConfigCard` (titled "Agent settings") and `PiSkillsCard`.

## Dev mock
- `?chatmock=1` (or localStorage `cc-chat-mock=1`) installs `chat/mock.ts`. It must implement every route the web calls, or only the mock breaks: sessions, messages, send, retry, delete, commands, usage. Fixtures: `s-disk` is a running chat, `s-appr` is a Pi chat with answered and pending approvals. See `test-instance.md`, "Static preview".
