/**
 * Hermes client. `HermesClient` is the transport-agnostic interface used by routes and
 * the run manager. `HttpHermes` is the real implementation (Bearer key, server side only).
 * `parseFrame` maps raw Hermes SSE events to typed frames; it is pure and unit-tested.
 */
import { ChatError } from "./http";
import type { ChatBackend } from "./backend";

export type ModelOptions = {
  unavailable_models: string[];
  providers: { id: string; authenticated: boolean }[];
};

/** Typed frames a run produces (see contract "run events"). */
export type HermesFrame =
  | { type: "run.started"; runId: string; sessionId: string; assistantMessageId: string; model: string }
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool.started"; id: string; name: string; args: Record<string, unknown> | null; preview: string | null }
  | { type: "tool.completed"; id: string; ok: boolean; durationMs: number | null; preview: string | null }
  | { type: "approval"; command: string | null; note: string }
  | { type: "usage"; input: number; output: number }
  | { type: "done"; status: "complete" | "failed" | "interrupted"; error: string | null; model: string | null };

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type StartRunArgs = {
  sessionId: string;
  message: string | ContentPart[];
  model: string;
  effort?: "off" | "low" | "medium" | "high" | null;
  /** Pi only: the model's provider and the session's backend ref. Hermes never receives these. */
  provider?: string;
  ref?: string | null;
};

/** A finished background subagent batch: Hermes writes it into the session transcript (no push). */
export type Completion = { id: number; ts: number; delegationId: string | null };
/** A background batch Hermes accepted. One batch = one delegation id = one completion row, however many tasks it holds. */
export type Dispatch = { delegationId: string; ts: number };
export type Delegations = { done: Completion[]; dispatched: Dispatch[] };

export interface HermesClient extends ChatBackend {
  modelOptions(): Promise<ModelOptions>;
}

/** Used when no transport is configured. Every call fails with 503. */
export class UnconfiguredHermes implements HermesClient {
  private fail(): never {
    throw new ChatError(503, "hermes is not configured");
  }
  async createSession(): Promise<string> { return this.fail(); }
  async deleteSession(): Promise<void> { return this.fail(); }
  async lockModel(): Promise<void> { return this.fail(); }
  async modelOptions(): Promise<ModelOptions> { return this.fail(); }
  async startRun(): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }> { return this.fail(); }
  async stopRun(): Promise<void> { return this.fail(); }
  async steerRun(): Promise<void> { return this.fail(); }
}

/* ---------- SSE -> frame mapping (pure) ---------- */

export type ParseState = {
  interrupted: boolean;
  failed: boolean;
  error: string | null;
  model: string | null;
  open: { id: string; name: string; startedAt: number | null }[];
  toolSeq: number;
};

export function newParseState(): ParseState {
  return { interrupted: false, failed: false, error: null, model: null, open: [], toolSeq: 0 };
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Maps one Hermes SSE event (name from the `event:` line, parsed `data`) to a frame, or null
 * for events the UI does not need. Mutates `st` to track interrupted/failed state, open tool
 * calls (Hermes gives no call id on tool.completed, so completions match by name, FIFO) and
 * the runtime model confirmed by assistant.completed.
 */
export function parseFrame(event: string, data: unknown, st: ParseState): HermesFrame | null {
  const d = (typeof data === "object" && data !== null ? data : {}) as Obj;
  switch (event) {
    case "run.started": {
      const runtime = (d.runtime ?? {}) as Obj;
      const requested = (runtime.requested ?? {}) as Obj;
      return {
        type: "run.started",
        runId: str(d.run_id) ?? "",
        sessionId: str(d.session_id) ?? "",
        assistantMessageId: "",
        model: str(requested.model) ?? "",
      };
    }
    case "assistant.delta": {
      const text = str(d.delta);
      return text ? { type: "delta", text } : null;
    }
    case "tool.progress": {
      if (d.tool_name !== "_thinking") return null;
      const text = str(d.delta);
      return text ? { type: "reasoning", text } : null;
    }
    case "tool.started": {
      const id = `t${++st.toolSeq}`;
      const name = str(d.tool_name) ?? "tool";
      st.open.push({ id, name, startedAt: num(d.ts) });
      const args = typeof d.args === "object" && d.args !== null && !Array.isArray(d.args) ? (d.args as Obj) : null;
      return { type: "tool.started", id, name, args, preview: str(d.preview) };
    }
    case "tool.completed":
    case "tool.failed": {
      const name = str(d.tool_name) ?? "tool";
      const i = st.open.findIndex(t => t.name === name);
      const open = i >= 0 ? st.open.splice(i, 1)[0] : { id: `t${++st.toolSeq}`, name, startedAt: null };
      const ts = num(d.ts);
      const durationMs = open.startedAt !== null && ts !== null ? Math.max(0, Math.round((ts - open.startedAt) * 1000)) : null;
      return {
        type: "tool.completed", id: open.id, ok: event === "tool.completed", durationMs, preview: str(d.preview),
      };
    }
    case "approval.request": {
      return { type: "approval", command: str(d.command), note: "needs approval in Hermes" };
    }
    case "assistant.completed": {
      if (d.interrupted === true) st.interrupted = true;
      const runtime = (d.runtime ?? {}) as Obj;
      st.model = str(runtime.model) ?? st.model;
      return null;
    }
    case "run.cancelled": {
      st.interrupted = true;
      return null;
    }
    case "run.completed": {
      const usage = (d.usage ?? {}) as Obj;
      const input = num(usage.input_tokens);
      const output = num(usage.output_tokens);
      return input === null || output === null ? null : { type: "usage", input, output };
    }
    case "error":
    case "run.failed": {
      st.failed = true;
      st.error = str(d.message) ?? str(d.error) ?? "run failed";
      return null;
    }
    case "done": {
      const status = st.failed ? "failed" : st.interrupted ? "interrupted" : "complete";
      return { type: "done", status, error: status === "failed" ? st.error : null, model: st.model };
    }
    default:
      return null;
  }
}

/** Parses an SSE byte stream into {event, data} blocks. Comment lines (keepalive) are ignored. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: unknown }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let carry = ""; // trailing "\r" held back: its "\n" may arrive in the next chunk
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = carry + decoder.decode(value, { stream: true });
      carry = text.endsWith("\r") ? "\r" : "";
      buf += text.slice(0, text.length - carry.length).replace(/\r\n/g, "\n");
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":") || line === "") continue;
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        if (!event || dataLines.length === 0) continue;
        let data: unknown;
        try { data = JSON.parse(dataLines.join("\n")); } catch { continue; }
        yield { event, data };
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const DELEG_ID = /\bdeleg_[A-Za-z0-9]+/;

/** Picks async_delegation_complete rows out of a Hermes message list. */
export function parseCompletions(rows: unknown[]): Completion[] {
  const out: Completion[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Obj;
    if (o.display_kind !== "async_delegation_complete") continue;
    const id = Number(o.id);
    const ts = num(o.timestamp) ?? Number(o.timestamp);
    if (!Number.isFinite(id) || !Number.isFinite(ts)) continue;
    const m = typeof o.content === "string" ? DELEG_ID.exec(o.content) : null;
    out.push({ id, ts, delegationId: m ? m[0] : null });
  }
  return out;
}

/** Dispatch results of delegate_task (steer/list calls and transcript copies are ignored). One entry per batch id. */
export function parseDispatches(rows: unknown[]): Dispatch[] {
  const seen = new Set<string>();
  const out: Dispatch[] = [];
  for (const r of rows) {
    const o = (r ?? {}) as Obj;
    if (o.role !== "tool" || o.tool_name !== "delegate_task" || typeof o.content !== "string") continue;
    let c: Obj;
    try { c = JSON.parse(o.content) as Obj; } catch { continue; }
    if (c.status !== "dispatched" || typeof c.delegation_id !== "string" || seen.has(c.delegation_id)) continue;
    const ts = num(o.timestamp) ?? Number(o.timestamp);
    if (!Number.isFinite(ts)) continue;
    seen.add(c.delegation_id);
    out.push({ delegationId: c.delegation_id, ts });
  }
  return out;
}

/* ---------- Real client ---------- */

export type HttpHermesOptions = { baseUrl: string; apiKey: string; timeoutMs?: number };

export class HttpHermes implements HermesClient {
  private readonly base: string;
  private readonly key: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpHermesOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.key = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** timeoutMs <= 0 means no client-side timeout (used for the run stream, whose lifetime the run manager owns). */
  private async call(method: string, path: string, body?: unknown, timeoutMs = this.timeoutMs): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.key}`, accept: "application/json" };
    let payload: string | undefined;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    try {
      const signal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      return await fetch(this.base + path, { method, headers, body: payload, signal });
    } catch {
      throw new ChatError(502, "hermes unreachable");
    }
  }

  private async json(res: Response): Promise<Obj> {
    try {
      const v = await res.json();
      return typeof v === "object" && v !== null ? (v as Obj) : {};
    } catch {
      return {};
    }
  }

  async createSession(): Promise<string> {
    const res = await this.call("POST", "/api/sessions", { source: "api_server" });
    if (res.status !== 201 && res.status !== 200) throw new ChatError(502, `hermes create session failed (${res.status})`);
    const id = str(((await this.json(res)).session as Obj | undefined)?.id);
    if (!id) throw new ChatError(502, "hermes create session: no id");
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    const res = await this.call("DELETE", `/api/sessions/${encodeURIComponent(id)}`);
    if (res.status === 404) return;
    if (!res.ok) throw new ChatError(502, `hermes delete session failed (${res.status})`);
  }

  async lockModel(id: string, model: string, provider: string): Promise<void> {
    const res = await this.call("POST", `/api/sessions/${encodeURIComponent(id)}/model`, { model, provider });
    if (!res.ok) throw new ChatError(502, `hermes model lock failed (${res.status})`);
  }

  async modelOptions(): Promise<ModelOptions> {
    const res = await this.call("GET", "/api/model/options");
    if (!res.ok) throw new ChatError(502, `hermes model options failed (${res.status})`);
    const j = await this.json(res);
    const unavailable = Array.isArray(j.unavailable_models)
      ? j.unavailable_models.filter((x): x is string => typeof x === "string") : [];
    const providers = Array.isArray(j.providers)
      ? j.providers.flatMap((p): { id: string; authenticated: boolean }[] => {
          const o = (p ?? {}) as Obj;
          const id = str(o.id);
          return id ? [{ id, authenticated: o.authenticated !== false }] : [];
        })
      : [];
    return { unavailable_models: unavailable, providers };
  }

  async startRun(args: StartRunArgs): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }> {
    const body: Obj = { message: args.message };
    if (args.effort) {
      body.model_options = { reasoning: { enabled: args.effort !== "off", effort: args.effort === "off" ? "none" : args.effort } };
    }
    // No timeout on the stream itself; the run manager owns its lifetime.
    const res = await this.call("POST", `/api/sessions/${encodeURIComponent(args.sessionId)}/chat/stream`, body, 0);
    if (!res.ok || !res.body) throw new ChatError(502, `hermes stream failed (${res.status})`);

    const events = sseEvents(res.body)[Symbol.asyncIterator]();
    const st = newParseState();
    const pending: HermesFrame[] = [];
    let runId = "";
    let sessionId = args.sessionId;
    // Read until run.started so the caller gets the run id before frames flow.
    while (!runId) {
      const n = await events.next();
      if (n.done) throw new ChatError(502, "hermes stream ended before run.started");
      const f = parseFrame(n.value.event, n.value.data, st);
      if (f && f.type === "run.started") {
        runId = f.runId;
        sessionId = f.sessionId || sessionId;
        pending.push({ ...f, sessionId });
      }
    }
    const frames = (async function* (): AsyncGenerator<HermesFrame> {
      for (const f of pending) yield f;
      let finished = false;
      while (true) {
        const n = await events.next();
        if (n.done) break;
        const f = parseFrame(n.value.event, n.value.data, st);
        if (!f) continue;
        yield f;
        if (f.type === "done") { finished = true; break; }
      }
      if (!finished) {
        yield { type: "done", status: "failed", error: "stream ended unexpectedly", model: st.model };
      }
    })();
    return { runId, frames };
  }

  async stopRun(runId: string): Promise<void> {
    const res = await this.call("POST", `/v1/runs/${encodeURIComponent(runId)}/stop`);
    if (res.status === 404) throw new ChatError(404, "run not found");
    if (!res.ok) throw new ChatError(502, `hermes stop failed (${res.status})`);
  }

  async delegations(sessionId: string): Promise<Delegations> {
    const res = await this.call("GET", `/api/sessions/${encodeURIComponent(sessionId)}/messages?order=latest&limit=500&include_compacted=true`);
    if (!res.ok) throw new ChatError(502, `hermes messages failed (${res.status})`);
    const data = (await this.json(res)).data;
    const rows = Array.isArray(data) ? data : [];
    return { done: parseCompletions(rows), dispatched: parseDispatches(rows) };
  }

  async steerRun(runId: string, message: string): Promise<void> {
    const res = await this.call("POST", `/v1/runs/${encodeURIComponent(runId)}/steer`, { message });
    if (res.status === 409) throw new ChatError(409, "run finished");
    if (res.status === 404) throw new ChatError(404, "run not found");
    if (!res.ok) throw new ChatError(502, `hermes steer failed (${res.status})`);
  }
}
