# Chat: CC server <-> web contract (v1). Both Coders build to this file; change it only via the Orchestrator.

All routes under `/api/chat`, behind the existing `cc_session` cookie auth. JSON unless stated. Errors: `{ "error": "<message>" }` with 4xx/5xx. Every non-GET route requires header `x-cc: 1` (else 403).
Timestamps are epoch milliseconds. IDs are strings.

## Types
```ts
type Effort = "off" | "low" | "medium" | "high";
type ChatModel = { id: string; provider: string; label: string; reasoning: boolean; canDisableReasoning: boolean; vision: boolean; local: boolean; online: boolean; backend?: "hermes" | "pi" };
type ChatSession = { id: string; title: string; titleAuto: boolean; model: string; provider: string; effort: Effort | null;
  pinned: boolean; archived: boolean; createdAt: number; updatedAt: number;
  runState: "idle" | "running" | "needs_approval"; runId: string | null; unread: boolean; preview: string; awaiting: number };
type Attachment = { id: string; kind: "image" | "file"; name: string; mime: string; size: number; w: number | null; h: number | null; url: string /* /api/chat/files/<id> */ };
type ToolRow = { id: string; name: string; args: Record<string, unknown> | null; preview: string | null; status: "running" | "ok" | "failed"; durationMs: number | null };
type ApprovalStatus = "pending" | "approved" | "denied" | "ended";
/** A Hermes approval is a read-only notice (no id); a Pi approval has an id and can be answered. */
type Approval = { command: string | null; note: string; id?: string; options?: string[]; status?: ApprovalStatus };
/** Ordered parts of an assistant turn, so text, tools and approvals stay in the order they happened. */
type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string }
  | { kind: "approval"; approval: Approval };
type ChatMessage = { id: string; seq: number; role: "user" | "assistant"; text: string; reasoning: string | null;
  tools: ToolRow[]; blocks: MessageBlock[]; usage: { input: number; output: number } | null; status: "complete" | "failed" | "interrupted" | "running";
  runId: string | null; model: string | null; attachments: Attachment[]; createdAt: number; error: string | null };
```
`blocks` is the ordered body of an assistant turn: text segments, tool rows (by id) and approval cards, in the order they arrived. `text` and `tools` stay for search, export and older rows; a row without `blocks_json` returns `blocks: []` and the UI falls back to tools-then-text.

## Routes
- `GET /models` -> `ChatModel[]` (curated allowlist from settings `chat.models`; default list in server code; `online` false when provider unavailable). Each entry also carries `backend: "hermes" | "pi"`. Hermes entries are `"hermes"`. Pi entries are added from the Pi bridge; if the bridge is down they are omitted with no error.
- `GET /config` -> `{ defaultModel: string; defaultEffort: Effort | null; maxUploadMb: number; contextWindow: Record<modelId, number> }`.
- `GET /sessions?q=&archived=0|1` -> `ChatSession[]` sorted pinned first then `updatedAt` desc. `q` searches title + message text via FTS and returns `{...ChatSession, snippet: string}`.
- `POST /sessions` `{ model?: string; effort?: Effort|null; backend?: "hermes" | "pi" }` -> `ChatSession` (creates the Hermes session, source `api_server`, locks the model). `backend` defaults to `"hermes"`. `backend: "pi"` requires `model` (a Pi model id from `GET /models`), creates a Pi chat on the bridge, and stores its session file. 503 when no Pi bridge is configured. `backend` is immutable after creation: a PATCH carrying `backend` is 400.
- `PATCH /sessions/:id` any of `{ title, pinned, archived, model, effort }` -> `ChatSession`. A `title` change sets `titleAuto=false`. A `model` change is locked in Hermes at the next send.
- `DELETE /sessions/:id` -> `{ ok: true }` (deletes the Hermes session, mirror rows, and files). Refused with 409 when a run is active.
- `GET /sessions/:id/messages?before=<seq>&limit=40` -> `{ messages: ChatMessage[] /* ascending seq */; hasMore: boolean }`. Newest page when `before` is absent.
- `POST /sessions/:id/send` multipart/form-data: `text` (string, may be empty if files), `model?`, `effort?`, `files` (0..6, repeated). -> `201 { runId, userMessage: ChatMessage, assistantMessage: ChatMessage }`. 409 `{error:"run active"}` if the session already has a run.
- `GET /runs/:runId/events` SSE. Header `Last-Event-ID` (or `?last=`) replays missed events. Each event: `id: <n>\nevent: <type>\ndata: <json>\n\n`. A comment `: keepalive` every 15s. Stream ends after `done`.
  - `run.started` `{ runId, sessionId, assistantMessageId, model }`
  - `delta` `{ text }` (append to assistant text)
  - `reasoning` `{ text }` (append)
  - `tool.started` `{ id, name, args, preview }`
  - `tool.completed` `{ id, ok: boolean, durationMs, preview }`
  - `approval` `{ command: string | null, note: string, id?: string, options?: string[] }`. Pi carries `id`/`options` so the card can be answered; Hermes carries neither and stays a read-only notice.
  - `usage` `{ input, output }`
  - `done` `{ status: "complete" | "failed" | "interrupted", error: string | null, model: string | null }`
- `POST /runs/:runId/stop` -> `{ ok: true }`
- `POST /runs/:runId/steer` `{ message }` -> `{ ok: true }` or 409 `{ error: "run finished" }`
- `GET /files/:id` -> bytes. Headers: correct content-type for images, `application/octet-stream` + `Content-Disposition: attachment` otherwise, `X-Content-Type-Options: nosniff`, `Cache-Control: private, max-age=3600`.
- `GET /sessions/:id/export` -> `text/markdown` attachment.
- Global `GET /api/events` (existing SSE) additionally emits `chat.run` `{ sessionId, runId, state: "running" | "idle" | "needs_approval", awaiting }`.
- `awaiting` = background subagents (Hermes `delegate_task`) dispatched in the session whose result has not arrived. Hermes never pushes them: it writes an `async_delegation_complete` row into the session transcript. While `awaiting > 0` the server polls `GET /api/sessions/{id}/messages?order=latest` every 5s (HTTP only, no tokens). When a new row appears and the session is idle, it starts one internal turn (no user message stored in CC) so the agent reports the result; the browser sees a `chat.run` running event and attaches. The wait is dropped after 30 min. State lives in `chat_await` / `chat_seen`.

## Rules the UI relies on
- One active run per session; the sidebar shows `runState`.
- A message with `status:"interrupted"` or `"failed"` is never shown as a normal reply.
- `title` is auto-set after the first assistant reply to the first 8 words of the first user message (`titleAuto=true`).
- Model is per session. New sessions use `config.defaultModel`.
- Reasoning effort is a hint, sent only when the model has `reasoning:true`.

## Pi chat settings (additive)

Pi chats only (`backend: "pi"`); Hermes chats get 400.

- `GET /api/chat/sessions/:id/pi-settings` -> `{ settings: { steeringMode, followUpMode, autoCompaction, autoRetry }, thinkingLevels: string[] }`. Stored overrides merged over Pi's defaults (`one-at-a-time`, `one-at-a-time`, `true`, `true`). `thinkingLevels` is the model's list from Pi (empty while a run is active or when the bridge is down).
- `PATCH /api/chat/sessions/:id/pi-settings` with any subset of those four keys -> `{ settings }`. Unknown keys, wrong types and an empty body are 400; 409 `run active` during a run. Applied by Pi at the start of the next run.
- `POST /api/chat/sessions/:id/pi-compact` `{ instructions? }` -> `{ tokensBefore, tokensAfter }`. 409 during a run; 502 with Pi's message when there is nothing to compact.
- The chat's `effort` is sent to Pi as its thinking level when the model reports reasoning.

## Pi configuration (additive)

Global, shared by every Pi chat; stored by the bridge as files in Pi's agent dir. It takes effect on a chat's next message: the bridge restarts that chat's Pi process (same session file, history kept) when the config or the chat's tools changed since launch. A change while the chat has an active run is refused (409 `run active`).

- `GET /api/chat/pi-config` -> `{ appendSystemPrompt, agentsMd, defaultTools: string[] | null, gate: { extraProtectedPaths: string[], extraRisky: string[] }, knownTools: string[] }`.
- `PUT /api/chat/pi-config` with any subset of `appendSystemPrompt` (text, 32 000 chars max, "" removes it), `agentsMd` (same), `defaultTools` (known names, `null` = Pi default), `gate`. Bridge validation errors come back as 400 with the message; 503 when no bridge is configured.
- `gate` can only add rules: `extraProtectedPaths` (paths under the home directory, no `..`) and `extraRisky` (patterns that must compile). Loosening keys are rejected.
- Per-chat `tools` (`string[] | null`) is part of `pi-settings` (GET/PATCH) and overrides `defaultTools`; `null` removes the override.
- Pi's own config files (prompt, notes, gate and tool config, extensions) are on the gate's protected list, so a Pi chat cannot rewrite its own rules.

## Pi working directory (additive)

A Pi chat may start in a directory the user picks, instead of `workspace/<chatId>`. The choice is fixed when the chat is created.

- **Browse**: `GET /api/chat/pi/dirs?path=<abs>` (default: the bridge user's HOME) → `200 {path, parent|null, entries:[{name,path}]}`. Only subdirectories, sorted by name case-insensitively, dot-folders omitted. `parent` is null at HOME.
- **Create folder**: `POST /api/chat/pi/dirs {parent, name}` → `201 {path,name}`. `name`: 1–64 chars, no `/`, no NUL, not starting with `.`. `409` if it exists. Needs `x-cc`.
- The bridge's `400`/`409` pass through with their `{error}` message; they are not wrapped as `502`. With Pi off, both routes answer `503`.
- **Create**: `POST /api/chat/sessions {backend:"pi", model, cwd?}`. `cwd` is an optional string, allowed only for `backend:"pi"` (`400` otherwise). `cwd` is validated by the bridge (same rules as browse, plus the chosen-cwd rule below). Invalid → `400`, nothing is stored.
- **Session JSON**: `cwd: string | null`. `null` for Hermes chats and for default-workspace Pi chats. The stored value is `chat_sessions.cwd` (nullable TEXT, additive migration).
- **Rules** (enforced by the bridge, pi-bridge/src/pi-dirs.ts):
  - Paths are absolute, resolved with realpath, and must lie inside HOME. Symlinks that escape HOME are rejected.
  - Protected: `~/.hermes`, `~/.ssh`, `~/.local/share/cc-pi` (the Pi agent dir), `~/projects/control-center/data`, and anything under them. Listing skips protected entries.
  - A chosen cwd must not be, contain, or sit inside a protected path. HOME itself is allowed as a cwd.
- **Resume**: every Pi `/start` sent by the server carries the chat's stored `cwd`, so a reaped chat resumes in the same directory. The bridge keeps the cwd for the chat's life; a `/start` with a different cwd returns `409`.
- **Bridge**: `GET /dirs?path=`, `POST /dirs {parent,name}`, and `POST /chats/:id/start {cwd?}`. `/start` echoes `cwd` (and `state.cwd`). Without `cwd`, the chat runs in `workspace/<chatId>` as before.
