/** SQLite access for chat tables. All values are bound parameters. */
import type { Database } from "bun:sqlite";
import type { TodoItem } from "./hermes";
import { readStoredSettings, type PiSettings } from "./pi-settings";

export const EFFORTS = ["off", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];
export type RunState = "idle" | "running" | "needs_approval";

export type ChatSession = {
  id: string;
  title: string;
  titleAuto: boolean;
  model: string;
  provider: string;
  /** Pi chats started in a chosen directory: that path. null for Hermes and for default-workspace Pi chats. */
  cwd: string | null;
  effort: Effort | null;
  pinned: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  runState: RunState;
  /** Background subagents dispatched in this session whose result has not arrived yet. */
  awaiting: number;
  runId: string | null;
  unread: boolean;
  preview: string;
  /** Auto-approve this chat's Pi gate requests (the `/yolo` command). Server-side, so it works while the app is closed. */
  yolo: boolean;
};

export type ToolRow = {
  id: string;
  name: string;
  args: Record<string, unknown> | null;
  preview: string | null;
  status: "running" | "ok" | "failed";
  durationMs: number | null;
};

export type ApprovalStatus = "pending" | "approved" | "denied" | "ended";
/** A Hermes approval has no id (read-only notice); a Pi approval has an id and can be answered. */
export type Approval = { command: string | null; note: string; id?: string; options?: string[]; status?: ApprovalStatus };
/** Ordered parts of an assistant turn, so text, tools and approvals stay in the order they happened. */
export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string }
  | { kind: "approval"; approval: Approval };

export type AttachmentView = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  w: number | null;
  h: number | null;
  url: string;
};

export type ChatMessage = {
  id: string;
  seq: number;
  role: "user" | "assistant";
  text: string;
  reasoning: string | null;
  tools: ToolRow[];
  /** Ordered body of the turn. Older rows (no blocks_json) read as []. */
  blocks: MessageBlock[];
  usage: { input: number; output: number } | null;
  /** Pi: last todo list the agent wrote during this turn. null when none. */
  todos: TodoItem[] | null;
  status: "complete" | "failed" | "interrupted" | "running";
  runId: string | null;
  model: string | null;
  attachments: AttachmentView[];
  createdAt: number;
  error: string | null;
};

export type NewAttachment = {
  id: string;
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  sha256: string;
  path: string;
  w: number | null;
  h: number | null;
};

const PREVIEW_SQL = "(SELECT substr(m.text, 1, 140) FROM chat_messages m WHERE m.session_id = s.id ORDER BY m.seq DESC LIMIT 1)";
const SESSION_COLS = `s.id, s.title, s.title_auto, s.model, s.provider, s.cwd, s.effort, s.pinned, s.archived,
  s.created_at, s.updated_at, s.run_state, s.run_id, s.unread, s.yolo, ${PREVIEW_SQL} AS preview,
  COALESCE((SELECT a.expected FROM chat_await a WHERE a.session_id = s.id), 0) AS awaiting`;

type SessionRow = {
  id: string; title: string; title_auto: number; model: string; provider: string; cwd: string | null; effort: string | null;
  pinned: number; archived: number; created_at: number; updated_at: number; run_state: string;
  run_id: string | null; unread: number; preview: string | null; awaiting: number; yolo: number;
};

function toSession(r: SessionRow): ChatSession {
  return {
    id: r.id,
    title: r.title,
    titleAuto: r.title_auto === 1,
    model: r.model,
    provider: r.provider,
    cwd: r.cwd ?? null,
    effort: (r.effort as Effort | null) ?? null,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    runState: r.run_state as RunState,
    runId: r.run_id,
    unread: r.unread === 1,
    preview: (r.preview ?? "").slice(0, 140),
    awaiting: r.awaiting,
    yolo: r.yolo === 1,
  };
}

export function getSession(db: Database, id: string): ChatSession | null {
  const r = db.query(`SELECT ${SESSION_COLS} FROM chat_sessions s WHERE s.id = ?`).get(id) as SessionRow | null;
  return r ? toSession(r) : null;
}

export function listSessions(db: Database, opts: { archived?: boolean } = {}): ChatSession[] {
  const rows = db.query(
    `SELECT ${SESSION_COLS} FROM chat_sessions s WHERE s.archived = ? ORDER BY s.pinned DESC, s.updated_at DESC`,
  ).all(opts.archived ? 1 : 0) as SessionRow[];
  return rows.map(toSession);
}

export function createSession(
  db: Database,
  s: { id: string; model: string; provider: string; effort: Effort | null; now: number; title?: string; lockedModel?: string | null; backend?: "hermes" | "pi"; backendRef?: string | null; cwd?: string | null },
): ChatSession {
  db.query(
    `INSERT INTO chat_sessions (id, title, title_auto, model, provider, model_locked, effort, pinned, archived,
       created_at, updated_at, run_state, run_id, unread, backend, backend_ref, cwd)
     VALUES (?, ?, 1, ?, ?, ?, ?, 0, 0, ?, ?, 'idle', NULL, 0, ?, ?, ?)`,
  ).run(s.id, s.title ?? "New chat", s.model, s.provider, s.lockedModel ?? null, s.effort, s.now, s.now,
    s.backend ?? "hermes", s.backendRef ?? null, s.cwd ?? null);
  return getSession(db, s.id)!;
}

/** The backend a session was created on and its backend-specific ref. Null when the session is unknown. */
export function getBackend(db: Database, id: string): { backend: "hermes" | "pi"; ref: string | null } | null {
  const r = db.query("SELECT backend, backend_ref FROM chat_sessions WHERE id = ?").get(id) as
    { backend: "hermes" | "pi"; backend_ref: string | null } | null;
  return r ? { backend: r.backend, ref: r.backend_ref } : null;
}

/** Distinct working folders used by Pi chats; the skill list scans project skills in each. */
export function listPiCwds(db: Database): string[] {
  return (db.query("SELECT DISTINCT cwd FROM chat_sessions WHERE backend = 'pi' AND cwd IS NOT NULL ORDER BY cwd").all() as
    { cwd: string }[]).map((r) => r.cwd);
}

/** Only the settings the user changed; {} when none. */
export function getPiSettings(db: Database, id: string): Partial<PiSettings> {
  const r = db.query("SELECT pi_settings_json FROM chat_sessions WHERE id = ?").get(id) as { pi_settings_json: string | null } | null;
  return readStoredSettings(r?.pi_settings_json ?? null);
}

export function setPiSettings(db: Database, id: string, settings: Partial<PiSettings>): void {
  db.query("UPDATE chat_sessions SET pi_settings_json = ? WHERE id = ?").run(JSON.stringify(settings), id);
}

export function setBackendRef(db: Database, id: string, ref: string | null): void {
  db.query("UPDATE chat_sessions SET backend_ref = ? WHERE id = ?").run(ref, id);
}


export function updateSession(
  db: Database,
  id: string,
  patch: {
    title?: string; pinned?: boolean; archived?: boolean; model?: string; provider?: string; effort?: Effort | null; yolo?: boolean;
  },
  now: number,
): ChatSession | null {
  if (!getSession(db, id)) return null;
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.title !== undefined) { sets.push("title = ?", "title_auto = 0"); params.push(patch.title); }
  if (patch.pinned !== undefined) { sets.push("pinned = ?"); params.push(patch.pinned ? 1 : 0); }
  if (patch.archived !== undefined) { sets.push("archived = ?"); params.push(patch.archived ? 1 : 0); }
  if (patch.model !== undefined) { sets.push("model = ?"); params.push(patch.model); }
  if (patch.provider !== undefined) { sets.push("provider = ?"); params.push(patch.provider); }
  if (patch.effort !== undefined) { sets.push("effort = ?"); params.push(patch.effort); }
  if (patch.yolo !== undefined) { sets.push("yolo = ?"); params.push(patch.yolo ? 1 : 0); }
  sets.push("updated_at = ?");
  params.push(now, id);
  db.query(`UPDATE chat_sessions SET ${sets.join(", ")} WHERE id = ?`).run(...params);
  return getSession(db, id);
}

/** Auto-approve this session's Pi gate requests (the `/yolo` command). */
export function getYolo(db: Database, id: string): boolean {
  const r = db.query("SELECT yolo FROM chat_sessions WHERE id = ?").get(id) as { yolo: number } | null;
  return r?.yolo === 1;
}

/** Deletes mirror rows (messages, attachments and FTS cascade). Returns attachment file paths, or null if missing. */
export function deleteSession(db: Database, id: string): string[] | null {
  if (!getSession(db, id)) return null;
  const paths = (db.query("SELECT path FROM chat_attachments WHERE session_id = ?").all(id) as { path: string }[])
    .map(r => r.path);
  db.query("DELETE FROM chat_sessions WHERE id = ?").run(id);
  return paths;
}

/** Metadata for one message without loading its body (used to place deletes and retries). */
export function getMessageMeta(
  db: Database, id: string,
): { sessionId: string; seq: number; role: "user" | "assistant"; text: string } | null {
  const r = db.query("SELECT session_id, seq, role, text FROM chat_messages WHERE id = ?").get(id) as
    { session_id: string; seq: number; role: string; text: string } | null;
  return r ? { sessionId: r.session_id, seq: r.seq, role: r.role as "user" | "assistant", text: r.text } : null;
}

/** Deletes one message (attachments cascade). Returns the attachment file paths to remove from disk. */
export function deleteMessage(db: Database, id: string): string[] {
  const paths = (db.query("SELECT path FROM chat_attachments WHERE message_id = ?").all(id) as { path: string }[])
    .map(r => r.path);
  db.query("DELETE FROM chat_messages WHERE id = ?").run(id);
  return paths;
}

/** Drops every message with seq >= seqFrom (a retry's branch point). Returns attachment paths to remove. */
export function truncateFrom(db: Database, sessionId: string, seqFrom: number): string[] {
  const paths = (db.query(
    "SELECT path FROM chat_attachments WHERE message_id IN (SELECT id FROM chat_messages WHERE session_id = ? AND seq >= ?)",
  ).all(sessionId, seqFrom) as { path: string }[]).map(r => r.path);
  db.query("DELETE FROM chat_messages WHERE session_id = ? AND seq >= ?").run(sessionId, seqFrom);
  return paths;
}

/** A persistent local slash-command row in the thread. `afterSeq` anchors it after that message seq. */
export type CommandNote = { id: number; name: string; body: string; afterSeq: number; createdAt: number };

/** The highest message seq in a session (0 when empty); used to anchor a new command row. */
export function lastSeq(db: Database, sessionId: string): number {
  const r = db.query("SELECT COALESCE(MAX(seq), 0) AS n FROM chat_messages WHERE session_id = ?").get(sessionId) as { n: number };
  return r.n;
}

export function insertCommand(db: Database, c: { sessionId: string; name: string; body: string; afterSeq: number; createdAt: number }): CommandNote {
  const r = db.query("INSERT INTO chat_commands (session_id, seq, name, body, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(c.sessionId, c.afterSeq, c.name, c.body, c.createdAt);
  return { id: Number(r.lastInsertRowid), name: c.name, body: c.body, afterSeq: c.afterSeq, createdAt: c.createdAt };
}

/** Every command row in the session, oldest first. */
export function listCommands(db: Database, sessionId: string): CommandNote[] {
  const rows = db.query("SELECT id, seq, name, body, created_at FROM chat_commands WHERE session_id = ? ORDER BY seq ASC, id ASC")
    .all(sessionId) as { id: number; seq: number; name: string; body: string; created_at: number }[];
  return rows.map(r => ({ id: r.id, name: r.name, body: r.body, afterSeq: r.seq, createdAt: r.created_at }));
}

/** Drops command rows anchored at or after a deleted or rebranched message. */
export function deleteCommandsFrom(db: Database, sessionId: string, seqFrom: number): void {
  db.query("DELETE FROM chat_commands WHERE session_id = ? AND seq >= ?").run(sessionId, seqFrom);
}

export function nextSeq(db: Database, sessionId: string): number {
  const r = db.query("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM chat_messages WHERE session_id = ?").get(sessionId) as { n: number };
  return r.n;
}

export function insertMessage(
  db: Database,
  m: {
    id: string; sessionId: string; seq: number; role: "user" | "assistant"; text: string;
    reasoning?: string | null; tools?: ToolRow[]; blocks?: MessageBlock[]; usage?: { input: number; output: number } | null;
    status: ChatMessage["status"]; runId?: string | null; model?: string | null; error?: string | null;
    createdAt: number; attachments: NewAttachment[];
  },
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO chat_messages (id, session_id, seq, role, text, reasoning, tools_json, usage_json, blocks_json, status, run_id, model, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      m.id, m.sessionId, m.seq, m.role, m.text, m.reasoning ?? null,
      m.tools ? JSON.stringify(m.tools) : null,
      m.usage ? JSON.stringify(m.usage) : null,
      m.blocks && m.blocks.length ? JSON.stringify(m.blocks) : null,
      m.status, m.runId ?? null, m.model ?? null, m.error ?? null, m.createdAt,
    );
    for (const a of m.attachments) {
      db.query(
        `INSERT INTO chat_attachments (id, message_id, session_id, kind, name, mime, size, sha256, path, w, h)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(a.id, m.id, m.sessionId, a.kind, a.name, a.mime, a.size, a.sha256, a.path, a.w, a.h);
    }
    db.query("UPDATE chat_sessions SET updated_at = MAX(updated_at, ?) WHERE id = ?").run(m.createdAt, m.sessionId);
  })();
}

type MessageRow = {
  id: string; seq: number; role: string; text: string; reasoning: string | null; tools_json: string | null;
  usage_json: string | null; todos_json: string | null; blocks_json: string | null; status: string; run_id: string | null; model: string | null; error: string | null; created_at: number;
};

function attachmentsFor(db: Database, messageId: string): AttachmentView[] {
  const rows = db.query(
    "SELECT id, kind, name, mime, size, w, h FROM chat_attachments WHERE message_id = ? ORDER BY rowid",
  ).all(messageId) as { id: string; kind: "image" | "file"; name: string; mime: string; size: number; w: number | null; h: number | null }[];
  return rows.map(r => ({ id: r.id, kind: r.kind, name: r.name, mime: r.mime, size: r.size, w: r.w, h: r.h, url: `/api/chat/files/${r.id}` }));
}

function toMessage(db: Database, r: MessageRow): ChatMessage {
  return {
    id: r.id,
    seq: r.seq,
    role: r.role as "user" | "assistant",
    text: r.text,
    reasoning: r.reasoning,
    tools: r.tools_json ? (JSON.parse(r.tools_json) as ChatMessage["tools"]) : [],
    blocks: r.blocks_json ? (JSON.parse(r.blocks_json) as ChatMessage["blocks"]) : [],
    usage: r.usage_json ? (JSON.parse(r.usage_json) as ChatMessage["usage"]) : null,
    todos: r.todos_json ? (JSON.parse(r.todos_json) as ChatMessage["todos"]) : null,
    status: r.status as ChatMessage["status"],
    runId: r.run_id,
    model: r.model,
    attachments: attachmentsFor(db, r.id),
    createdAt: r.created_at,
    error: r.error,
  };
}

/** Newest page when `before` is absent; otherwise messages with seq < before. Result is ascending. */
export function listMessages(
  db: Database, sessionId: string, opts: { before?: number; limit?: number } = {},
): { messages: ChatMessage[]; hasMore: boolean } {
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 100);
  const cols = "id, seq, role, text, reasoning, tools_json, usage_json, todos_json, blocks_json, status, run_id, model, error, created_at";
  const rows = opts.before === undefined
    ? db.query(`SELECT ${cols} FROM chat_messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`).all(sessionId, limit + 1)
    : db.query(`SELECT ${cols} FROM chat_messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
        .all(sessionId, opts.before, limit + 1);
  const list = rows as MessageRow[];
  const hasMore = list.length > limit;
  const page = list.slice(0, limit).reverse();
  return { messages: page.map(r => toMessage(db, r)), hasMore };
}

/** Every message in ascending order (used by export). */
export function listAllMessages(db: Database, sessionId: string): ChatMessage[] {
  const rows = db.query(
    `SELECT id, seq, role, text, reasoning, tools_json, usage_json, todos_json, blocks_json, status, run_id, model, error, created_at
     FROM chat_messages WHERE session_id = ? ORDER BY seq ASC`,
  ).all(sessionId) as MessageRow[];
  return rows.map(r => toMessage(db, r));
}

/** Attachment row with its disk path (server side only; never sent to the browser). */
export function getAttachment(
  db: Database, id: string,
): { id: string; kind: "image" | "file"; name: string; mime: string; path: string } | null {
  return (db.query("SELECT id, kind, name, mime, path FROM chat_attachments WHERE id = ?").get(id) as
    { id: string; kind: "image" | "file"; name: string; mime: string; path: string } | null) ?? null;
}

/** Escapes LIKE wildcards so user input is matched literally. */
function escLike(s: string): string {
  return s.replace(/[\\%_]/g, c => "\\" + c);
}

/** Converts free text into a safe FTS5 query: each word becomes a quoted term; a trailing * means prefix. */
export function ftsQuery(q: string): string | null {
  const parts: string[] = [];
  for (const raw of q.split(/\s+/)) {
    const prefix = raw.endsWith("*");
    const base = raw.replace(/\*+$/, "").replace(/[^\p{L}\p{N}_]/gu, "");
    if (!base) continue;
    parts.push(`"${base}"${prefix ? "*" : ""}`);
  }
  return parts.length ? parts.join(" ") : null;
}

function snippetAround(text: string, q: string): string {
  const idx = text.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return text.slice(0, 120);
  const start = Math.max(0, idx - 40);
  return (start > 0 ? "…" : "") + text.slice(start, idx + q.length + 60);
}

/** Title and message search. Returns sessions with a snippet, pinned first then updatedAt desc. */
export function searchSessions(
  db: Database, opts: { q: string; archived?: boolean },
): (ChatSession & { snippet: string })[] {
  const archived = opts.archived ? 1 : 0;
  const q = opts.q.trim();
  if (q === "") return listSessions(db, { archived: archived === 1 }).map(s => ({ ...s, snippet: s.preview }));

  const like = `%${escLike(q)}%`;
  const fts = ftsQuery(q);
  const ftsClause = fts
    ? " OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.id IN (SELECT message_id FROM chat_messages_fts WHERE chat_messages_fts MATCH ?))"
    : "";
  const params: (string | number)[] = [archived, like, like];
  if (fts) params.push(fts);
  const ids = db.query(
    `SELECT s.id FROM chat_sessions s
     WHERE s.archived = ? AND (s.title LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM chat_messages m WHERE m.session_id = s.id AND m.text LIKE ? ESCAPE '\\')${ftsClause})
     ORDER BY s.pinned DESC, s.updated_at DESC`,
  ).all(...params) as { id: string }[];

  const out: (ChatSession & { snippet: string })[] = [];
  for (const { id } of ids) {
    const s = getSession(db, id)!;
    const hit = db.query(
      "SELECT text FROM chat_messages WHERE session_id = ? AND text LIKE ? ESCAPE '\\' ORDER BY seq DESC LIMIT 1",
    ).get(id, like) as { text: string } | null;
    let snippet: string;
    if (hit) snippet = snippetAround(hit.text, q);
    else if (s.title.toLowerCase().includes(q.toLowerCase())) snippet = s.title;
    else {
      const f = fts ? (db.query(
        "SELECT text FROM chat_messages m WHERE m.session_id = ? AND m.id IN (SELECT message_id FROM chat_messages_fts WHERE chat_messages_fts MATCH ?) ORDER BY seq DESC LIMIT 1",
      ).get(id, fts) as { text: string } | null) : null;
      snippet = f ? f.text.slice(0, 120) : s.preview;
    }
    out.push({ ...s, snippet });
  }
  return out;
}

/** One message by id, with attachments (used by the run manager and tests). */
export function getMessage(db: Database, id: string): ChatMessage | null {
  const r = db.query(
    "SELECT id, seq, role, text, reasoning, tools_json, usage_json, todos_json, blocks_json, status, run_id, model, error, created_at FROM chat_messages WHERE id = ?",
  ).get(id) as MessageRow | null;
  return r ? toMessage(db, r) : null;
}

/** Model last locked in Hermes for this session, or null if never locked. */
export function getLockedModel(db: Database, id: string): string | null {
  const r = db.query("SELECT model_locked FROM chat_sessions WHERE id = ?").get(id) as { model_locked: string | null } | null;
  return r?.model_locked ?? null;
}

/** Partial update of an assistant message while a run progresses or ends. */
export function patchMessage(
  db: Database,
  id: string,
  p: {
    text?: string; reasoning?: string | null; tools?: ToolRow[]; blocks?: MessageBlock[]; usage?: { input: number; output: number } | null;
    todos?: TodoItem[] | null;
    status?: ChatMessage["status"]; error?: string | null; model?: string | null;
  },
): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (p.text !== undefined) { sets.push("text = ?"); params.push(p.text); }
  if (p.reasoning !== undefined) { sets.push("reasoning = ?"); params.push(p.reasoning); }
  if (p.tools !== undefined) { sets.push("tools_json = ?"); params.push(JSON.stringify(p.tools)); }
  if (p.blocks !== undefined) { sets.push("blocks_json = ?"); params.push(p.blocks.length ? JSON.stringify(p.blocks) : null); }
  if (p.usage !== undefined) { sets.push("usage_json = ?"); params.push(p.usage ? JSON.stringify(p.usage) : null); }
  if (p.todos !== undefined) { sets.push("todos_json = ?"); params.push(p.todos ? JSON.stringify(p.todos) : null); }
  if (p.status !== undefined) { sets.push("status = ?"); params.push(p.status); }
  if (p.error !== undefined) { sets.push("error = ?"); params.push(p.error); }
  if (p.model !== undefined) { sets.push("model = ?"); params.push(p.model); }
  if (sets.length === 0) return;
  db.query(`UPDATE chat_messages SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
}

/** Sets the session's run state. `updated_at` never moves backwards. */
export function setRunState(db: Database, id: string, state: RunState, runId: string | null, now: number): void {
  db.query("UPDATE chat_sessions SET run_state = ?, run_id = ?, updated_at = MAX(updated_at, ?) WHERE id = ?")
    .run(state, runId, now, id);
}

/** Auto-title: sets the title but keeps it marked automatic. */
export function setAutoTitle(db: Database, id: string, title: string): void {
  db.query("UPDATE chat_sessions SET title = ?, title_auto = 1 WHERE id = ?").run(title, id);
}

/** Records the model Hermes has locked for this session. */
export function setLockedModel(db: Database, id: string, model: string): void {
  db.query("UPDATE chat_sessions SET model_locked = ? WHERE id = ?").run(model, id);
}

/* ---------- background subagents (awaiting results) ---------- */

export type AwaitRow = { sessionId: string; expected: number; sinceMs: number; deadlineMs: number };

/** Adds `n` dispatched subagents to the session's awaiting count. since_ms keeps the earliest start. */
export function addAwaiting(db: Database, sessionId: string, n: number, sinceMs: number, deadlineMs: number): void {
  db.query(
    `INSERT INTO chat_await (session_id, expected, since_ms, deadline_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET expected = expected + excluded.expected,
       since_ms = MIN(since_ms, excluded.since_ms), deadline_ms = excluded.deadline_ms`,
  ).run(sessionId, n, sinceMs, deadlineMs);
}

export function listAwaiting(db: Database): AwaitRow[] {
  return (db.query("SELECT session_id, expected, since_ms, deadline_ms FROM chat_await").all() as
    { session_id: string; expected: number; since_ms: number; deadline_ms: number }[])
    .map(r => ({ sessionId: r.session_id, expected: r.expected, sinceMs: r.since_ms, deadlineMs: r.deadline_ms }));
}

export function clearAwaiting(db: Database, sessionId: string): void {
  db.query("DELETE FROM chat_await WHERE session_id = ?").run(sessionId);
}

export function seenIds(db: Database, sessionId: string): Set<number> {
  return new Set((db.query("SELECT hermes_msg_id AS id FROM chat_seen WHERE session_id = ?").all(sessionId) as { id: number }[]).map(r => r.id));
}

/** Marks `ids` as reported and sets the still-pending count; the row is removed at zero. */
export function consumeAwaiting(db: Database, sessionId: string, ids: number[], pending: number): void {
  db.transaction(() => {
    for (const id of ids) db.query("INSERT OR IGNORE INTO chat_seen (session_id, hermes_msg_id) VALUES (?, ?)").run(sessionId, id);
    setAwaiting(db, sessionId, pending);
  })();
}

/** Sets the pending count; at zero or below the wait is over. */
export function setAwaiting(db: Database, sessionId: string, pending: number): void {
  if (pending <= 0) db.query("DELETE FROM chat_await WHERE session_id = ?").run(sessionId);
  else db.query("UPDATE chat_await SET expected = ? WHERE session_id = ?").run(pending, sessionId);
}
