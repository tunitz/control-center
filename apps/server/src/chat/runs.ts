/**
 * Run manager. Owns every Hermes stream from start to its `done` frame, independent of
 * browser connections. Frames are mapped to contract events, appended to a per-run ring
 * buffer and to `chat_run_events`, and folded into the assistant message as they arrive.
 * Browsers attach through `eventsResponse` (SSE with Last-Event-ID replay).
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type { HermesClient, HermesFrame, ContentPart } from "./hermes";
import { ChatError } from "./http";
import * as S from "./store";
import type { NewAttachment, ToolRow, Effort, ChatMessage } from "./store";
import { autoTitle } from "./title";

export const MAX_ACTIVE_RUNS = 3;
/** How long a session waits for a background subagent before the indicator is dropped. */
export const AWAIT_TIMEOUT_MS = 30 * 60_000;
const RING_SIZE = 500;
const KEEPALIVE_MS = 15_000;
const KEEP_FINISHED = 50;

export type RunInput = {
  text: string;
  message: string | ContentPart[];
  attachments: NewAttachment[];
  model: string;
  effort: Effort | null;
  /** Server-initiated turn (reporting a finished subagent): no user message is stored in the chat. */
  internal?: boolean;
};

export type RunEvent = { n: number; type: string; data: string };

type RunRec = {
  runId: string;
  sessionId: string;
  assistantId: string;
  model: string;
  userText: string;
  startedAt: number;
  firstTurn: boolean;
  text: string;
  reasoning: string | null;
  tools: ToolRow[];
  usage: { input: number; output: number } | null;
  hermesRunId: string | null;
  stopRequested: boolean;
  finished: boolean;
  needsApproval: boolean;
  seq: number;
  events: RunEvent[];
  listeners: Set<(e: RunEvent) => void>;
  started: Promise<void>;
  resolveStarted: () => void;
  done: Promise<void>;
  resolveDone: () => void;
};

export type RunManagerOptions = {
  db: Database;
  hermes: HermesClient;
  now: () => number;
  emit?: (event: string, data: unknown) => void;
  ringSize?: number;
  keepaliveMs?: number;
};

const errMsg = (e: unknown): string => (e instanceof ChatError ? e.message : "hermes connection lost");

export class RunManager {
  private readonly db: Database;
  private readonly hermes: HermesClient;
  private readonly now: () => number;
  private readonly emit: (event: string, data: unknown) => void;
  private readonly ringSize: number;
  private readonly keepaliveMs: number;
  private readonly runs = new Map<string, RunRec>();
  private readonly reserved = new Set<string>();

  constructor(opts: RunManagerOptions) {
    this.db = opts.db;
    this.hermes = opts.hermes;
    this.now = opts.now;
    this.emit = opts.emit ?? (() => {});
    this.ringSize = opts.ringSize ?? RING_SIZE;
    this.keepaliveMs = opts.keepaliveMs ?? KEEPALIVE_MS;
  }

  /** Claims the session's single run slot. 409 when the session is busy, 429 at the global cap. */
  reserve(sessionId: string): void {
    if (this.reserved.has(sessionId)) throw new ChatError(409, "run active");
    if (this.reserved.size >= MAX_ACTIVE_RUNS) throw new ChatError(429, "too many active runs");
    this.reserved.add(sessionId);
  }

  release(sessionId: string): void {
    this.reserved.delete(sessionId);
  }

  activeCount(): number {
    return this.reserved.size;
  }

  /** Locks the model in Hermes only when it differs from the stored locked model. */
  async ensureModel(sessionId: string, model: string, provider: string): Promise<void> {
    if (S.getLockedModel(this.db, sessionId) === model) return;
    await this.hermes.lockModel(sessionId, model, provider);
    S.setLockedModel(this.db, sessionId, model);
  }

  /** Persists the user turn and the running assistant placeholder, then starts the Hermes stream. Caller holds the reservation. */
  begin(sessionId: string, input: RunInput): { runId: string; userMessage: ChatMessage | null; assistantMessage: ChatMessage } {
    const now = this.now();
    const runId = randomUUID();
    const userId = randomUUID();
    const assistantId = randomUUID();
    const firstTurn = (this.db.query("SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ? AND role = 'user'")
      .get(sessionId) as { c: number }).c === 0;
    const seq = S.nextSeq(this.db, sessionId);
    if (!input.internal) {
      S.insertMessage(this.db, {
        id: userId, sessionId, seq, role: "user", text: input.text, status: "complete",
        createdAt: now, attachments: input.attachments,
      });
    }
    S.insertMessage(this.db, {
      id: assistantId, sessionId, seq: input.internal ? seq : seq + 1, role: "assistant", text: "", status: "running",
      runId, model: input.model, createdAt: now, attachments: [],
    });
    S.setRunState(this.db, sessionId, "running", runId, now);

    let resolveStarted!: () => void;
    let resolveDone!: () => void;
    const rec: RunRec = {
      runId, sessionId, assistantId, model: input.model, userText: input.text, startedAt: now, firstTurn,
      text: "", reasoning: null, tools: [], usage: null, hermesRunId: null, stopRequested: false,
      finished: false, needsApproval: false, seq: 0, events: [], listeners: new Set(),
      started: new Promise<void>(r => (resolveStarted = r)), resolveStarted,
      done: new Promise<void>(r => (resolveDone = r)), resolveDone,
    };
    this.runs.set(runId, rec);

    const userMessage = input.internal ? null : S.getMessage(this.db, userId)!;
    const assistantMessage = S.getMessage(this.db, assistantId)!;
    this.addEvent(rec, "run.started", { runId, sessionId, assistantMessageId: assistantId, model: input.model });
    this.emitRun(sessionId, runId, "running");

    void this.pump(rec, input);
    return { runId, userMessage, assistantMessage };
  }

  /** Ends when the run has persisted its done frame (or immediately for unknown or finished runs). */
  waitDone(runId: string): Promise<void> {
    return this.runs.get(runId)?.done ?? Promise.resolve();
  }

  /**
   * Subscribes to a live run. `backlog` holds events with n > lastId from the ring buffer,
   * or from the DB when the ring no longer covers them. Live events go to `onEvent`.
   */
  subscribe(runId: string, lastId: number, onEvent: (e: RunEvent) => void): { backlog: RunEvent[]; unsubscribe: () => void } {
    const rec = this.runs.get(runId);
    const backlog = this.backlogFor(runId, lastId);
    if (!rec || rec.finished) return { backlog, unsubscribe: () => {} };
    rec.listeners.add(onEvent);
    return { backlog, unsubscribe: () => { rec.listeners.delete(onEvent); } };
  }

  /** SSE response: replays the backlog, streams live events, ends after `done`, keepalive comments every 15s. */
  eventsResponse(runId: string, lastRaw: string | null | undefined): Response {
    const rec = this.runs.get(runId);
    if (!rec && !this.runExists(runId)) throw new ChatError(404, "run not found");
    const lastId = parseLastId(lastRaw);
    const enc = new TextEncoder();
    let timer: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let onLive: ((e: RunEvent) => void) | null = null;
    let controller!: ReadableStreamDefaultController<Uint8Array>;

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (rec && onLive) rec.listeners.delete(onLive);
    };
    const close = () => {
      if (closed) return;
      cleanup();
      try { controller.close(); } catch { /* already closed by cancel */ }
    };
    const send = (text: string) => {
      if (closed) return;
      try { controller.enqueue(enc.encode(text)); } catch { cleanup(); }
    };

    const backlog = this.backlogFor(runId, lastId);
    const finished = rec ? rec.finished : true;
    const stream = new ReadableStream<Uint8Array>({
      start: c => {
        controller = c;
        for (const e of backlog) send(frame(e));
        if (finished) { close(); return; }
        onLive = (e: RunEvent) => {
          send(frame(e));
          if (e.type === "done") close();
        };
        rec!.listeners.add(onLive);
        timer = setInterval(() => send(": keepalive\n\n"), this.keepaliveMs);
      },
      cancel: () => cleanup(),
    });
    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  /** Forwards a stop to Hermes. A stop before Hermes reports its run id is forwarded when it does. */
  async stop(runId: string): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) {
      if (this.runExists(runId)) return;
      throw new ChatError(404, "run not found");
    }
    if (rec.finished) return;
    rec.stopRequested = true;
    if (rec.hermesRunId) await this.hermes.stopRun(rec.hermesRunId);
  }

  /** Forwards a steer to Hermes. 409 'run finished' once the run is over. */
  async steer(runId: string, message: string): Promise<void> {
    const rec = this.runs.get(runId);
    if (!rec) {
      if (this.runExists(runId)) throw new ChatError(409, "run finished");
      throw new ChatError(404, "run not found");
    }
    if (rec.finished) throw new ChatError(409, "run finished");
    await rec.started;
    if (rec.finished || !rec.hermesRunId) throw new ChatError(409, "run finished");
    await this.hermes.steerRun(rec.hermesRunId, message);
  }

  /* ---------- internals ---------- */

  private async pump(rec: RunRec, input: RunInput): Promise<void> {
    let handle: { runId: string; frames: AsyncIterable<HermesFrame> };
    try {
      handle = await this.hermes.startRun({
        sessionId: rec.sessionId, message: input.message, model: input.model, effort: input.effort,
      });
    } catch (e) {
      rec.resolveStarted();
      this.finish(rec, "failed", e instanceof ChatError ? e.message : "hermes unreachable", null);
      return;
    }
    rec.hermesRunId = handle.runId;
    rec.resolveStarted();
    if (rec.stopRequested) this.hermes.stopRun(handle.runId).catch(() => {});
    try {
      for await (const f of handle.frames) {
        this.apply(rec, f);
        if (rec.finished) return;
      }
      this.finish(rec, "failed", "stream ended unexpectedly", null);
    } catch (e) {
      this.finish(rec, "failed", errMsg(e), null);
    }
  }

  private apply(rec: RunRec, f: HermesFrame): void {
    if (f.type !== "approval" && rec.needsApproval) {
      rec.needsApproval = false;
      S.setRunState(this.db, rec.sessionId, "running", rec.runId, this.now());
      this.emitRun(rec.sessionId, rec.runId, "running");
    }
    switch (f.type) {
      case "run.started":
        return;
      case "delta":
        rec.text += f.text;
        this.persist(rec);
        this.addEvent(rec, "delta", { text: f.text });
        return;
      case "reasoning":
        rec.reasoning = (rec.reasoning ?? "") + f.text;
        this.persist(rec);
        this.addEvent(rec, "reasoning", { text: f.text });
        return;
      case "tool.started":
        rec.tools.push({ id: f.id, name: f.name, args: f.args, preview: f.preview, status: "running", durationMs: null });
        this.persist(rec);
        this.addEvent(rec, "tool.started", { id: f.id, name: f.name, args: f.args, preview: f.preview });
        return;
      case "tool.completed": {
        const t = rec.tools.find(x => x.id === f.id);
        if (t) {
          t.status = f.ok ? "ok" : "failed";
          t.durationMs = f.durationMs;
          t.preview = f.preview ?? t.preview;
        }
        this.persist(rec);
        this.addEvent(rec, "tool.completed", { id: f.id, ok: f.ok, durationMs: f.durationMs, preview: f.preview });
        return;
      }
      case "approval":
        rec.needsApproval = true;
        S.setRunState(this.db, rec.sessionId, "needs_approval", rec.runId, this.now());
        this.addEvent(rec, "approval", { command: f.command, note: f.note });
        this.emitRun(rec.sessionId, rec.runId, "needs_approval");
        return;
      case "usage":
        rec.usage = { input: f.input, output: f.output };
        this.persist(rec);
        this.addEvent(rec, "usage", { input: f.input, output: f.output });
        return;
      case "done":
        this.finish(rec, f.status, f.error, f.model);
        return;
    }
  }

  private finish(rec: RunRec, status: "complete" | "failed" | "interrupted", error: string | null, model: string | null): void {
    if (rec.finished) return;
    let final = status;
    if (final === "complete" && rec.stopRequested) final = "interrupted";
    if (final !== "complete") {
      for (const t of rec.tools) if (t.status === "running") t.status = "failed";
    }
    const err = final === "failed" ? (error ?? "run failed") : null;
    const finalModel = model ?? rec.model;
    S.patchMessage(this.db, rec.assistantId, {
      text: rec.text, reasoning: rec.reasoning, tools: rec.tools, usage: rec.usage,
      status: final, error: err, model: finalModel,
    });
    rec.finished = true;
    if (rec.firstTurn && S.getSession(this.db, rec.sessionId)?.titleAuto) {
      S.setAutoTitle(this.db, rec.sessionId, autoTitle(rec.userText));
    }
    // Background subagents run on after the turn ends; remember them so the watcher can report back.
    // A real dispatch only: delegate_task is also used to steer or list running subagents.
    const dispatched = rec.tools.filter(t => t.name === "delegate_task" && t.status === "ok" && (t.args?.action === undefined || t.args?.action === "spawn")).length;
    if (dispatched > 0) S.addAwaiting(this.db, rec.sessionId, dispatched, rec.startedAt, this.now() + AWAIT_TIMEOUT_MS);
    S.setRunState(this.db, rec.sessionId, "idle", null, this.now());
    this.release(rec.sessionId);
    this.addEvent(rec, "done", { status: final, error: err, model: finalModel });
    this.emitRun(rec.sessionId, rec.runId, "idle");
    rec.resolveDone();
    this.prune();
  }

  /** Global chat.run feed. `awaiting` = background subagents still to report in this session. */
  emitRun(sessionId: string, runId: string | null, state: "running" | "idle" | "needs_approval"): void {
    const awaiting = S.getSession(this.db, sessionId)?.awaiting ?? 0;
    this.emit("chat.run", { sessionId, runId, state, awaiting });
  }

  private persist(rec: RunRec): void {
    S.patchMessage(this.db, rec.assistantId, {
      text: rec.text, reasoning: rec.reasoning, tools: rec.tools, usage: rec.usage,
    });
  }

  private addEvent(rec: RunRec, type: string, data: unknown): void {
    const n = ++rec.seq;
    const json = JSON.stringify(data);
    this.db.query("INSERT INTO chat_run_events (run_id, n, type, data) VALUES (?, ?, ?, ?)").run(rec.runId, n, type, json);
    const ev: RunEvent = { n, type, data: json };
    rec.events.push(ev);
    if (rec.events.length > this.ringSize) rec.events.shift();
    for (const l of [...rec.listeners]) l(ev);
  }

  private backlogFor(runId: string, lastId: number): RunEvent[] {
    const rec = this.runs.get(runId);
    if (rec && rec.events.length > 0 && rec.events[0].n <= lastId + 1) {
      return rec.events.filter(e => e.n > lastId);
    }
    return this.db.query("SELECT n, type, data FROM chat_run_events WHERE run_id = ? AND n > ? ORDER BY n")
      .all(runId, lastId) as RunEvent[];
  }

  private runExists(runId: string): boolean {
    return this.db.query("SELECT 1 FROM chat_run_events WHERE run_id = ? LIMIT 1").get(runId) !== null;
  }

  /** Forgets the oldest finished runs beyond KEEP_FINISHED; their events stay in the DB. */
  private prune(): void {
    let finished = 0;
    for (const r of this.runs.values()) if (r.finished) finished++;
    for (const [id, r] of this.runs) {
      if (finished <= KEEP_FINISHED) break;
      if (r.finished) { this.runs.delete(id); finished--; }
    }
  }
}

function frame(e: RunEvent): string {
  return `id: ${e.n}\nevent: ${e.type}\ndata: ${e.data}\n\n`;
}

function parseLastId(raw: string | null | undefined): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/**
 * Startup recovery: a run left `running` by a previous process can never finish. Its assistant
 * message becomes `interrupted`, its session goes idle, and a closing `done` event is recorded.
 */
export function recoverRuns(db: Database, now: number): void {
  db.transaction(() => {
    const ids = new Set<string>();
    for (const r of db.query("SELECT DISTINCT run_id FROM chat_messages WHERE status = 'running' AND run_id IS NOT NULL").all() as { run_id: string }[]) ids.add(r.run_id);
    for (const r of db.query("SELECT run_id FROM chat_sessions WHERE run_state != 'idle' AND run_id IS NOT NULL").all() as { run_id: string }[]) ids.add(r.run_id);
    db.query("UPDATE chat_messages SET status = 'interrupted' WHERE status = 'running'").run();
    db.query("UPDATE chat_sessions SET run_state = 'idle', run_id = NULL, updated_at = MAX(updated_at, ?) WHERE run_state != 'idle'").run(now);
    for (const runId of ids) {
      const has = db.query("SELECT 1 FROM chat_run_events WHERE run_id = ? AND type = 'done' LIMIT 1").get(runId);
      if (has) continue;
      const n = (db.query("SELECT COALESCE(MAX(n), 0) + 1 AS n FROM chat_run_events WHERE run_id = ?").get(runId) as { n: number }).n;
      db.query("INSERT INTO chat_run_events (run_id, n, type, data) VALUES (?, ?, 'done', ?)")
        .run(runId, n, JSON.stringify({ status: "interrupted", error: null, model: null }));
    }
  })();
}
