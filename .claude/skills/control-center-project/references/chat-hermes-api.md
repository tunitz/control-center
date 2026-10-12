# Hermes api_server: facts for a chat UI

Verified against Hermes 0.21.5 at 127.0.0.1:8642 (bearer key `API_SERVER_KEY`). Re-verify after any Hermes upgrade: `GET /health` returns the version.

## Probe hygiene (applies to every probe that writes)
- Create only sessions the probe itself names or records, write their IDs to a file as they are created, and delete only from that file.
- Never select records for deletion by title prefix or any pattern. Hermes lists sessions from Discord, cron and other users alongside API sessions, and deletes are not recoverable through the API.

## Discovery
- `GET /v1/capabilities` lists features: `session_chat_streaming`, `run_stop`, `run_steer`, `run_approval_response`, `approval_events`, `session_model_lock`, `session_fork`.
- `GET /api/model/options` lists 53 providers with per-model `reasoning`, `can_disable_reasoning`, `fast`, `pricing`. It does NOT report vision support; keep a vision allowlist on the CC side.

## Sessions
- `POST /api/sessions` returns 201 with `session`. Duplicate id gives 409 `session_exists`. Empty body auto-generates an id.
- `GET /api/sessions?source=api_server&limit=&offset=` returns `{data, has_more}` with no total. Filter by `source` so only your own chats show.
- `PATCH /api/sessions/{id}` accepts only `title, pinned, archived, hidden, unread, end_reason`. Other keys give 400 `unsupported_session_field`.
- `POST /api/sessions/{id}/fork` sets the source session's `end_reason` to `branched`. Do not expose fork as a casual action.
- `GET /api/sessions/{id}/messages?order=oldest` pages messages. Default order is latest first.

## Streaming: `POST /api/sessions/{id}/chat/stream`
Body `{message: string | parts[], model_options?}`. Frames arrive in this order:
`run.started` (carries `run_id`) -> `message.started` -> `assistant.delta`* -> `tool.started` / `tool.completed` / `tool.failed` -> `assistant.completed` (`interrupted` flag) -> `run.completed` (`usage`) -> `done`. Keepalive is a `: keepalive` comment line.
- Reasoning text comes as `tool.progress` with `tool_name:"_thinking"`, not as `reasoning.*` events. It repeats the final text, so show it collapsed and only when it differs.
- `model_options.reasoning.effort` is accepted; `none` disables. Effect on output not measured.
- `run.completed.usage` carries `input_tokens` and `output_tokens`, summed over every model call of the run (so not the context size). The Hermes source (`gateway/platforms/api_server_runs.py`, `_run_usage`) also defines `cache_read_tokens` and `cache_write_tokens`; the parser keeps them when present, but they have not been seen in a live frame yet, so check one before relying on them.
- A `model` override in the body did NOT change the runtime model. Model switching needs `POST /api/sessions/{id}/model` (source only, not verified live).

## Disconnect and concurrency
- A client disconnect mid-stream INTERRUPTS the run and stores a canned "Your request was not processed" assistant message. The run is not finished in the background. So the CC server, not the browser, must own the Hermes stream, and the UI must mark such turns failed.
- Two concurrent sends to one session are queued, not rejected with 409. The UI should disable Send while a run is active.

## Stop and steer
- `POST /v1/runs/{id}/stop` returns `stopping`; the stream then emits `assistant.completed` (`interrupted:true`), `run.cancelled`, `done`.
- `POST /v1/runs/{id}/steer` returns `accepted`, but the effect on the running turn was not observed. Do not build UI that depends on it until it is shown to work.
- `GET /v1/runs` is not a list endpoint (405). Only `GET /v1/runs/{id}` exists.

## Attachments
- Images work as `{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}` parts. Use at least 64px per side: a 4x4 image was silently dropped and the model answered as if it saw nothing.
- Hermes stores the image as the text `[screenshot]`. The image is not persisted, so CC must keep its own copy to show it in history.
- Files and PDFs are rejected with 400 `unsupported_content_type`. `POST /v1/artifacts/upload` is disabled unless browser extension control is on. Path references in the prompt are the untested workaround.

## Approvals
- `approval.request` carries `command` and `choices`. Respond with `POST /v1/runs/{run_id}/approval` `{choice}`. No pending request gives 409 `approval_not_pending`.
- Not triggered in probes: smart approval auto-allowed the commands tried. Find the config that forces prompts before building the approval card.

## Slash commands
`/compact`, `/new`, `/help` sent as chat text reach the model as plain text. Implement commands client-side.

## Background subagent reports
- A `delegate_task` dispatched in a turn returns at once (its tool row says `background`). The result is not pushed to the open stream. It lands later as a transcript row (`async_delegation_complete`), and it is only read when a new message or a poll reaches Hermes.
- So CC owns the report. While a session's `awaiting` count is >0, the server polls `GET /api/sessions/{id}/messages?order=latest` every 5 s over HTTP. No model call is made during the wait.
- When a new completion row appears and the session is idle, the server starts one internal turn with no stored user message. The browser attaches to it as a normal running turn.
- Stop waiting after 30 minutes. Keep the awaiting state in the CC database so a restart does not drop it.
- Measured once with haiku: dispatch at 0 s, the completion row was seen at about 8 s, and the report turn finished at about 16 s, with one short reply.

## Auth
All `/api/*` routes need the bearer key; without it you get 401. Keep the key on the CC server only.
