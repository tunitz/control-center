# Hermes Chat in Control Center — implementation plan (v2, 2026-10-11; v1 same day, spikes folded in at §0)

Status: PLAN ONLY. No app code written. Mockup: `docs/mockups/chat.html`. Evidence for every Hermes claim below comes from live probes on Hermes 0.21.5 (marked VERIFIED) or from source reading (marked SOURCE). Anything unmarked is a decision.

## 0. DECISIONS LOCKED (v2, 2026-10-11, after spikes S1-S4 on live Hermes 0.21.5) — overrides anything below that conflicts
Header version: v2 (spike results folded in; v1 text kept below, superseded lines marked **[SUPERSEDED]**).

| # | Locked decision | Evidence | Replaces |
|---|---|---|---|
| L1 | **Model per chat = `POST /api/sessions/{id}/model` `{"model","provider"}` before the send.** Re-POST to change mid-chat; context survives. Never send `model`/`provider` in the chat body (ignored once the session has a stored model). No unlock endpoint: the picker always names a model; "clear" = start a new chat. Confirm per turn from `assistant.completed.runtime.model`, never from the model's own words. | VERIFIED: haiku -> sonnet -> deepseek in one session, runtime changed each time, code word recalled. Body override ignored. `PATCH model:null` 400, `POST /model {}` 400. | F3, R3 (fallback "fixed at creation" NOT needed) |
| L2 | **Custom `source` is rewritten to `api_server`.** Allowed: api_server, hermes_browser, browser, cli, telegram, discord, slack, desktop, dashboard. CC creates chats with `source:"api_server"` and **owns the list itself** (`chat_sessions` table = the registry of ids). Never list Hermes sessions to build the sidebar. | VERIFIED: `source:"control-center"` came back `api_server`; `?source=control-center` returned 0. | F9, R2 |
| L3 | **Files/PDFs = absolute host path in the prompt.** Agent uses `read_file` (txt, csv, docx, PDF) or `terminal` (5 MB file) and answered correctly 6/6. Prompt wording: `Attached file: <abs path> (<name>, <mime>, <size>)` prepended to the user text. Chat body file parts are rejected (`unsupported_content_type`), so no inline-file path exists. | VERIFIED 6 files incl. unicode/CJK/space filename. Text-layer PDF only. | F6, R4 |
| L4 | **Upload dir = bind mount at the identical absolute path.** compose adds `/home/tunitz/.hermes/cache/chat-uploads:/home/tunitz/.hermes/cache/chat-uploads` (CC writes, Hermes reads; same string both sides). The container has only `/data` today, so without this the path is invalid for Hermes. Subdir per chat, random file ids, sanitised display name kept in DB only (disk name = `<id>.<ext from sniffed mime>`). | VERIFIED: container sees only `/data`. Bind itself NOT yet tested (VERIFY at A4: write in container, read by Hermes, check uid). | new |
| L5 | **Scanned/image-only PDFs unsupported in v1.** Host has no pdftotext/tesseract, no sudo. UI shows a one-line hint on PDF attach: "Text PDFs only". Image attachments still go inline as `image_url` (F5). Revisit with a user-space extractor only on tun's go. | VERIFIED tools absent; scanned PDF NOT tested. | new |
| L6 | **Approvals: card is OUT of v1.** Default mode is `smart`, which auto-approved a flagged `rm -rf`; no `approval.request` was ever emitted, so the card cannot be built or tested honestly. Building it needs `approvals.mode: manual` globally (also changes Discord). tun chose plan-only: no config change. Revisit as its own decision. The route `POST /v1/runs/{id}/approval {"choice"}` and choices `once|session|always|deny` are SOURCE-only. A3 must still handle an `approval.request` frame if one ever appears (store it, show "needs approval in Hermes", do not hang). | SMART mode observed; manual NOT tested. | F8 approval part, B6 card |
| L7 | **Steer is IN v1 (queued-input behaviour).** `POST /v1/runs/{id}/steer {"message"}` -> 200 `accepted:true` and the run's output changed (PINEAPPLE). Only valid while the run is active; after finish it is 409 `run_not_accepting_steer`. UI: while a run is active the composer button becomes "Steer" next to Stop; on 409 show "Run already finished" and keep the text. **Runs must be started with `POST /v1/runs {"input","session_id"}` for steer to work**; the plan's streaming path (`/chat/stream`) exposes `run_id` in `run.started`, and steer on a stream run is NOT tested -> VERIFY at A2 (fallback: use `/v1/runs` + `/v1/runs/{id}/events`). | VERIFIED on `/v1/runs`. | F8, R8 |
| L8 | **Reasoning effort: ship the control as a hint, Off/Low/Med/High, only for models flagged `reasoning`.** Spike data (n=1 each, `reasoning_tokens` 0 everywhere) did not show an effect. Send as `model_options:{"reasoning":{"enabled":true,"effort":"low"}}` (accepted). Label "hint" in Settings. | VERIFIED accepted; effect NOT shown. | F4, R6 |
| L9 | **CC container -> Hermes works** (`bun fetch http://127.0.0.1:8642/health` = 200 from inside `control-center-control-center-1`). The CC `.env` needs `HERMES_API_KEY` (= `API_SERVER_KEY`); compose passes it through. Key is read once at boot, never logged, never sent to the browser. | VERIFIED reach; key plumbing is a task. | F1 |
| L10 | **Evidence of Hermes self-report is not trusted.** Model identity and "what tool ran" come from frames (`runtime`, `tool.started`). A model that was switched mid-chat will still say its old name. | VERIFIED | new |
| L11 | **Test hygiene (S5) was followed in S1-S4**: 15 sessions created by the probe, ids recorded in a file, deleted only from that file (all 200). | VERIFIED | S5 |

### Still open (need a decision or a check, none blocks M1)
| # | Item | Default | Resolved at |
|---|---|---|---|
| O1 | Bind mount permissions (container uid vs host dir) | Create dir mode 0775 owned by tunitz; run the container user via `user:` if needed | A4 |
| O2 | Does `/chat/stream` run_id accept `/steer` and `/stop`? (stop VERIFIED earlier on a stream run per F8; steer only on `/v1/runs`) | Use stream for sends, test steer at A2 | A2 |
| O3 | Does the local llama provider (`custom:local-llama`) lock and answer? Not probed | Listed in picker only if its online check passes | A5 |
| O4 | Reasoning effect real? | Keep as hint; retest n>=5 with `reasoning_tokens` before calling it a feature | M3 |
| O5 | Approvals mode `manual` globally | Not done; own decision with tun | after M3 |
| O6 | OCR for scanned PDFs | Not done | after M3 |

### Task deltas from locked decisions
- A2 Hermes client: `lockModel(id, model, provider)` called only when the chat's model differs from `chat_sessions.model_locked`; stores the confirmed value after the first `assistant.completed.runtime`; `createSession` uses `source:"api_server"`.
- A4: add the bind mount + upload dir creation + path builder (single function, no string concatenation from user input) + test that `../../x`, NUL, and very long names cannot escape the dir.
- A5: models list = allowlist intersected with `/api/model/options` availability (`unavailable_models` excluded).
- A3: handle frames `approval.request` (store, mark run `needs_approval`), and 409 on steer.
- B4: add Steer state to the composer; PDF hint text.
- B6: approval card **removed**; replaced by a read-only "needs approval in Hermes" row.
- Milestones: M3 loses the approvals item; M2 gains Steer.

## 1. Goal
A "Chat" tab in Control Center (CC) to talk to Hermes from the phone or desktop, modern and minimal, with what people expect from an AI chat:
- many chats, instant switching, rename / pin / archive / delete, search
- pick model and reasoning effort per chat
- send images and files
- streamed answers with markdown + code (copy button), visible tool calls and reasoning
- stop a running turn, approve/deny risky commands
- usage and context meter, export, dark/light, 390px first

Success: from an iPhone Home Screen app, start a chat, attach a photo, switch model, close the app mid-answer, reopen, and the answer is complete.

Out of scope v1: voice, image generation, sharing links, multi-user accounts, editing past messages, message regenerate (see §9 R7), cron/skills management UIs.

## 2. Facts that shape the design
| # | Fact | Design consequence |
|---|---|---|
| F1 | Hermes api_server is `127.0.0.1:8642`, bearer `API_SERVER_KEY`. CC runs `network_mode: host`, so it can reach it. CC `.env` already names `HERMES_API_KEY`. (SOURCE+host-net, reach NOT yet tested) | Browser never talks to Hermes. CC server proxies; key stays server side. |
| F2 | Client disconnect mid-stream INTERRUPTS the run and writes a canned fake assistant message (VERIFIED). | CC server owns the Hermes stream (a "run manager"), independent of the browser. Browser reattaches via CC's own SSE with replay. |
| F3 **[SUPERSEDED by L1]** | Body model override did not change the runtime model (VERIFIED). `POST /api/sessions/{id}/model` exists (SOURCE, unverified). | Spike S1 before building the picker. |
| F4 | Effort via `model_options.reasoning.effort` accepted, `none` disables (VERIFIED accepted, effect not measured). `/api/model/options` has per model `reasoning` / `can_disable_reasoning` flags, 53 providers. No vision flag. | Curated allowlist of models in CC settings; capability map for vision kept by CC. |
| F5 | Images OK as `image_url` data URLs; images <=4x4 silently dropped; Hermes stores only `[screenshot]` text (VERIFIED). | CC stores originals, re-renders them in history, downsizes/validates client side (min 64px). |
| F6 **[SUPERSEDED by L3-L5]** | Files and PDFs are rejected on chat/stream; artifact upload disabled (VERIFIED). | CC saves uploads to a host directory Hermes can read and puts the path in the prompt (spike S2 to verify). Small text files may be inlined. |
| F7 | SSE frames: `run.started{run_id}`, `message.started`, `assistant.delta`, `tool.started/completed/failed`, `tool.progress{tool_name:_thinking}` (reasoning), `assistant.completed`, `run.completed{usage}`, `done` (VERIFIED). | Map these 1:1 into CC's own event schema. Reasoning arrives as `_thinking` progress, duplicates the final text: show collapsed, only if it differs. |
| F8 **[PARTLY SUPERSEDED by L6, L7]** | Stop `POST /v1/runs/{id}/stop` works (VERIFIED). Steer accepted, effect unverified. Approval API exists but `approval.request` never fired (smart approval auto-allowed). | Stop in v1. Steer hidden unless S3 proves it. Approval card built from SOURCE shape, gated behind S3. |
| F9 **[SUPERSEDED by L2]** | Sessions API: create / list (`source` filter) / get / messages / PATCH(title,pinned,archived,hidden) / delete / fork (VERIFIED). Fork ends the source session. Discord and cron sessions share the list. | Create CC chats with `source:"control-center"` (S1 confirms a custom source is accepted) and list only that. No fork button in v1. |
| F10 | `/compact`, `/new`, `/help` through chat/stream are plain text (VERIFIED). | Slash palette is client side: /new, /model, /reasoning, /stop. No /compact in v1. |
| F11 | Concurrent turns on one session queue silently (VERIFIED). | UI disables send while a run is active; the typed text can be queued client side. |
| F12 | Hermes request cap 10 MB; list endpoint has no total, no text search (VERIFIED/SOURCE). | Images resized to <=2048px, <=6 MB encoded. Search is CC side (§4 FTS). |
| F13 | CC has no markdown lib, no multipart, hand-rolled router in `apps/server/src/index.ts`, SSE via `Set` of controllers, additive `CREATE TABLE IF NOT EXISTS`. | Add `marked`, `dompurify`, `highlight.js/lib/core` (few languages), lazy-loaded with the Chat route only. |

## 3. Architecture
```
 Browser (React, #/chat/:id)
    | cookie auth, fetch + EventSource
    v
 CC server (Bun)  --- /api/chat/*
    |  Run manager: one task per active run; reads Hermes SSE to the end
    |  even if every browser left; appends events to a ring buffer + DB
    |  SQLite: chat_sessions, chat_messages (+FTS5), chat_attachments
    |  Files: /data/chat-uploads (originals) + host dir for Hermes path refs
    v
 Hermes api_server 127.0.0.1:8642  (Bearer API_SERVER_KEY, server side only)
```
Source of truth: Hermes owns the model context; CC keeps a mirror of every message it sends/receives (text, tool rows, usage, attachments, status) so it can search, render images, show failed/interrupted turns correctly and survive Hermes quirks (F2, F5).

### CC API (all behind the existing `cc_session` cookie)
- `GET /api/chat/models` curated models with flags `{id, provider, label, reasoning, canDisableReasoning, vision, local, online}`
- `GET /api/chat/sessions?q=&archived=` · `POST /api/chat/sessions` · `PATCH /api/chat/sessions/:id` (title, pinned, archived, model, effort) · `DELETE`
- `GET /api/chat/sessions/:id/messages?before=` (paged, newest page first)
- `POST /api/chat/sessions/:id/send` multipart {text, model?, effort?, files[]} -> `{runId}`
- `GET /api/chat/runs/:runId/events` SSE with `Last-Event-ID` replay (ring buffer + DB)
- `POST /api/chat/runs/:runId/stop` · `POST /api/chat/runs/:runId/approval` {choice}
- `GET /api/chat/files/:id` (auth, correct content-type, `Content-Disposition`, `nosniff`)
- `GET /api/chat/sessions/:id/export?fmt=md`
- Global `/api/events` gets `chat.run` events (running/finished) so the sidebar dot and a Chat-tab badge update live.

### Data (additive migrations in the same `db.exec` block)
- `chat_sessions(id=hermes session id, title, title_auto, model, provider, effort, pinned, archived, created_at, updated_at, run_state, unread)`
- `chat_messages(id, session_id, seq, role, text, reasoning, tools_json, usage_json, status[complete|failed|interrupted], run_id, created_at)` + `chat_messages_fts` (FTS5, trigger-synced)
- `chat_attachments(id, message_id, kind[image|file], name, mime, size, sha256, path, w, h)`
- Settings keys: `chat.models` (allowlist), `chat.defaultModel`, `chat.defaultEffort`, `chat.maxUploadMb`.

## 4. Features and where they come from
| Feature | How | Verified? |
|---|---|---|
| Multiple chats, instant switch | sessions list from CC DB; active chat cached in memory, hash route `#/chat/:id` | CC side |
| New chat, rename, pin, archive, delete | CC DB + Hermes PATCH/DELETE | Hermes parts VERIFIED |
| Auto title | after first reply: title = first 6-8 words of the user message, editable (no extra LLM call) | decision |
| Search | FTS5 over CC mirror (title + text), results show snippet | CC side |
| Model switch | per chat; applies from the next send (S1) | S1 |
| Reasoning effort | Off/Low/Med/High; hidden for models without `reasoning`; Off only if `canDisableReasoning` | accepted VERIFIED |
| Image upload | picker, camera on phone, paste, drag-drop; client resize; thumbnails in thread | VERIFIED |
| File upload | save + path reference; text <=64 KB inlined | S2 |
| Streaming markdown | `marked` + DOMPurify; tables scroll inside wrapper; code block language label + Copy | CC side |
| Tool calls | collapsed group, args monospace, duration, status; expand for preview/output | VERIFIED frames |
| Reasoning | collapsed "Thought for Ns" row | VERIFIED frames |
| Stop | button replaces Send during run | VERIFIED |
| Approvals | inline card | S3 |
| Usage | per message `in/out tokens` (VERIFIED); context meter = last input tokens / model window from a CC table; cost estimated from `/api/model/options` pricing, shown as "est." | partly |
| Export | Markdown download | CC side |
| Failed/interrupted turns | red "Interrupted" marker, never rendered as a real reply (F2) | VERIFIED need |
| Dark/light/390px | existing tokens, no hardcoded colours | convention |

## 5. UI summary (see mockup)
- Desktop: header tabs Dashboard / Chat / Settings; Chat = 280px sessions column + centred 760px thread; one shared column for thread and composer.
- Phone: bottom tabbar; sessions in a drawer from the hamburger; model + thinking controls move to the composer footer as small pills; all tap targets >=44px; safe-area padding.
- Accent only on New chat, Send, primary approval. Muted text >=4.5:1. Three font sizes (13/14/15).
- Empty state: heading + one-line note ("Hermes can run commands on this machine."). No suggestion cards.

## 6. Security
- Chat gives the agent a terminal. Anyone with a CC session can run commands as the Hermes user. CC's argon2 login, `HttpOnly` + `SameSite=Strict` cookie and LAN-only exposure are the only gate. Decision D3 below: add a chat login-rate limit, and show an always-visible "Hermes can run commands" note in the first-run empty state.
- Hermes key never reaches the browser; never logged.
- Uploads: size cap, extension/mime sniff, stored under random ids, served only through the authed endpoint with `nosniff` and `attachment` disposition for non-image types; filenames sanitised before they enter a prompt path (argv-style rule: no shell string built from names).
- Markdown output sanitised (DOMPurify), links `rel=noreferrer noopener`, no inline HTML images from remote hosts (avoids tracking pixels): remote images render as links.
- Enforce the `x-cc: 1` header server side on every non-GET chat route (client sends it already; enforcement unconfirmed).
- Explicit Bun `maxRequestBodySize` (25 MB) on chat routes only.

## 7. Workstreams and tasks
Rules for every task: failing test first; `bash tools/test_all.sh` green; browser check at 390px in light + dark on a throwaway instance (`references/test-instance.md` of the control-center skill); one commit per task, only on tun's go. Hermes-dependent code is tested against a fake Hermes (small Bun server replaying captured frames) plus one live smoke at the end.

**S0 Spikes (read/probe only, Researcher; no app code)**
- S1: confirm `POST /api/sessions/{id}/model` really changes the runtime model; confirm custom `source`; confirm model list entries usable (anthropic, openai, deepseek, local-llama); measure whether effort low vs high changes output tokens on a reasoning model. Gate: if model switch cannot be made per chat, fall back to "model fixed at chat creation" and change the mock.
- S2: place a text file and a PDF in a host dir and ask the agent to read it through the prompt path; test that a bind-mounted dir is the same path inside the CC container and on the host.
- S3: find the config that makes terminal commands emit `approval.request` for api_server runs (check `approvals.mode`), capture one real frame, test `/approval`. Test `steer` with a visible effect. Gate: if not reproducible, ship v1 without the approval card and say so.
- S4: CC container reaches `http://127.0.0.1:8642/health` (run `docker exec` curl). Bun reads a Hermes SSE and survives a 5 min idle with `: keepalive`.
- S5: clean-test hygiene: every probe uses session ids the probe itself created and records them in a file; deletion only from that file (see incident, §10).

**A Server (Coder 1; disjoint files `apps/server/src/chat/*`, `db.ts` additions, `index.ts` route wiring last)**
- A1 DB tables + FTS + migration test (additive, backup note).
- A2 Hermes client module: list models, create/patch/delete session, send stream, stop, approval; typed frames; fake Hermes server fixture from captured frames.
- A3 Run manager: start run, fan-out to subscribers, ring buffer + DB append, replay by `Last-Event-ID`, finish/fail/interrupted handling, startup recovery (runs left `running` after a CC restart become `interrupted` or are re-attached if Hermes still reports `running`), one active run per session, global concurrency cap 3.
- A4 Routes + auth + body limits + `x-cc` enforcement; multipart parsing; upload store (sha256, size/mime checks); file endpoint.
- A5 Models endpoint (curated allowlist, capability map, online check for `local-llama` at 192.168.31.15:8080).
- A6 Search, export, auto-title, usage/cost.

**B Web (Coder 2; `apps/web/src/pages/Chat*.tsx`, `components/chat/*`, `chat.css` imported by the chat chunk, `main.tsx` route + tab edits last)**
- B1 Route + tabs (header and tabbar in sync) + lazy chunk.
- B2 Sessions panel/drawer: list, groups, search, row menu, inline rename, archived view.
- B3 Thread: message rendering, markdown/code/copy, tool group, reasoning row, usage line, failed/interrupted marker, scroll anchoring + "Jump to latest".
- B4 Composer: autogrow, Enter/Shift+Enter, slash palette, attachments (picker/camera/paste/drop), resize + progress, Stop/Send swap, context meter, model and thinking controls (inline desktop, pills on phone).
- B5 Streaming client: EventSource with replay, reconnect on `pageshow`/visibility, run badge.
- B6 Approval card (if S3 passes), empty state, export, settings for model allowlist in Settings page.
- B7 iOS Home Screen checks: no `backdrop-filter`, no fixed-background gradients, keyboard-open layout (visualViewport), swipe-back stays working with `navigate()`.

**C Verification (me, no delegation of verification)**
- Read diffs line by line for the upload store, file endpoint, multipart parser and the Hermes client (security-sensitive).
- Real-user path in a browser: new chat, send, stream, switch chat during a run, reload mid-run, attach image, attach PDF, switch model, change effort, stop, delete, search, export, light/dark/390px.
- Break tests: kill the CC container mid-run; stop Hermes mid-run; 10 MB image; zero-byte file; filename `../../x`; markdown with `<script>`; two tabs sending to the same chat.
- Backup `/data/cc.db` before deploy (`docker cp`), then `docker compose build --no-cache`, `up -d --force-recreate`, re-login, confirm bundle hash changed.

## 8. Milestones
| Slice | Contents | Done means |
|---|---|---|
| M0 | S1-S5 | Report with captured frames; gates decided |
| M1 | A1-A4, B1-B3, B5 | Text-only chats: create, switch, stream, markdown, stop, survive reload mid-run |
| M2 | A5, B4 (models, effort, images, files), A6 | Model/effort switching, attachments, search, export |
| M3 | B6, B7, polish | Approvals (if possible), iOS checks, Settings allowlist |
Excluded from M1: attachments, model/effort UI, search.

## 9. Risks, trade-offs, decisions (need tun)
| # | Risk / trade-off | Proposal |
|---|---|---|
| R1 | Agent with terminal reachable from a web login | Accept (LAN only, same trust level as Discord); add login rate limit |
| R2 | Hermes mixes chats with Discord sessions | Own `source:"control-center"`; CC lists only its own. Existing Discord chats are not importable in v1 |
| R3 | Model switching may be impossible per chat (F3) | Decided by S1 |
| R4 | Files are not natively supported | Path-reference workaround; behaviour depends on S2 |
| R5 | Images are not persisted by Hermes | CC mirror stores them (disk growth: cap 2 GB, purge with chat) |
| R6 | Reasoning effect unproven | Show control only for models flagged `reasoning`; label as a hint |
| R7 | Mockup shows Edit, Regenerate, Fork-from-here; the API cannot do them cleanly (regenerate would re-append the prompt; fork ends the source chat) | REJECTED for v1; remove the three buttons from the mock. Future path: fork-based branching once Hermes supports truncating a session |
| R8 | Steer unverified | Hidden until S3 |
| R9 | CC restart kills an active stream | Recovery in A3; Hermes may finish the turn anyway, we re-read messages |
| R10 | Bundle growth | Lazy chunk; highlight.js core + ~8 languages; measure gzip before/after, budget +120 KB gz for the chat chunk |

## 10. Incident to disclose
During research the probe agent hard-deleted two sessions it did not intend to: `12b8c4ee-8e93-4f0a-b28f-7e082dc0d328` and `api-8fdebea1e0f97978` (titles started "Identify image colour", matched by title prefix; very likely its own earlier probe sessions, unconfirmed). Not recoverable through the API. Rule added for S5: delete only ids the probe recorded itself.

## 11. Rollout
1. tun approves the mock and §9 decisions.
2. M0 spikes, report back, adjust the plan (DECISIONS LOCKED section will be appended above §1 if anything changes).
3. M1 -> deploy -> tun tries it -> M2 -> M3.
4. Each deploy: tests + typecheck, db backup, rebuild, relogin, live-test on 192.168.31.206:3030, then commit/push only on explicit go with message and file list. No agent (`agent/`) changes are involved, so no ccagent release.
5. Update skill `control-center` (chat section: architecture, pitfalls, test instance with fake Hermes) and memory in the same step.
