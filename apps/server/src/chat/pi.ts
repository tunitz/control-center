/**
 * Pi backend client (pi-bridge over HTTP, bearer token). Implements ChatBackend.
 *
 * Shape of a run: `startRun` makes the chat live (idempotent), opens the event stream
 * live-only (`after=MAX_SAFE_INTEGER`, so no ring replay of earlier runs), posts the prompt,
 * then maps the stream. Frame mapping here is the minimal T3 subset: text_delta -> delta,
 * agent_settled -> done (aborted -> interrupted, error -> failed), process_exit -> failed.
 *
 * The token is only ever sent as a header. Errors carry the bridge's own message, never the token.
 */
import { randomUUID } from "node:crypto";
import type { ChatBackend } from "./backend";
import type { ChatModelDef } from "./models";
import type { ContentPart, HermesFrame, StartRunArgs } from "./hermes";
import { ChatError } from "./http";

export const PI_BRIDGE_DEFAULT_URL = "http://127.0.0.1:3050";
const MODEL_CACHE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

export type PiClientOptions = { baseUrl: string; token: string; now?: () => number; requestTimeoutMs?: number };

type BridgeModel = { id?: unknown; provider?: unknown; name?: unknown; reasoning?: unknown; input?: unknown };

export class PiClient implements ChatBackend {
  private readonly base: string;
  private readonly token: string;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly refs = new Map<string, string>();
  private cache: { at: number; models: ChatModelDef[] } | null = null;

  constructor(opts: PiClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  /** The bridge's session file for a chat created by this process. Routes persist it; this map is a cache. */
  sessionRef(id: string): string | null {
    return this.refs.get(id) ?? null;
  }

  async createSession(): Promise<string> {
    const id = randomUUID();
    const r = await this.call("POST", `/chats/${id}/start`, {});
    if (typeof r.sessionFile !== "string" || r.sessionFile === "") throw new ChatError(502, "pi bridge returned no session file");
    this.refs.set(id, r.sessionFile);
    return id;
  }

  async deleteSession(id: string, _ref?: string | null): Promise<void> {
    const res = await this.raw("DELETE", `/chats/${id}`);
    if (res.status === 404) return;
    if (!res.ok) throw await this.failure("delete session", res);
  }

  /** Selects the model on the chat. `start` is idempotent: it applies the model to a live chat and resumes a reaped one. */
  async lockModel(id: string, model: string, provider: string, ref?: string | null): Promise<void> {
    await this.call("POST", `/chats/${id}/start`, {
      ...(ref ? { sessionPath: ref } : {}),
      model: { provider, modelId: model },
    });
  }

  async listModels(): Promise<ChatModelDef[]> {
    const t = this.now();
    if (this.cache && t - this.cache.at < MODEL_CACHE_MS) return this.cache.models;
    const r = await this.call("GET", "/models");
    const list: BridgeModel[] = Array.isArray(r.models) ? r.models : [];
    const models = list.filter((m) => typeof m.id === "string" && typeof m.provider === "string").map(toModelDef);
    this.cache = { at: t, models };
    return models;
  }

  async startRun(args: StartRunArgs): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }> {
    const chat = args.sessionId;
    const model = args.model;
    const provider = args.provider;
    await this.call("POST", `/chats/${chat}/start`, {
      ...(args.ref ? { sessionPath: args.ref } : {}),
      ...(provider ? { model: { provider, modelId: model } } : {}),
    });

    // Live-only subscription: no ring replay of earlier runs. Open it before the prompt so nothing is missed.
    const ctl = new AbortController();
    const stream = await this.open(`/chats/${chat}/events?after=${Number.MAX_SAFE_INTEGER}`, ctl.signal);
    try {
      const { text, images } = splitContent(args.message);
      await this.call("POST", `/chats/${chat}/prompt`, { message: text, ...(images.length ? { images } : {}) });
    } catch (e) {
      ctl.abort();
      await stream.cancel().catch(() => {});
      throw e;
    }
    return { runId: chat, frames: this.frames(chat, args.sessionId, model, stream, ctl) };
  }

  async stopRun(runId: string): Promise<void> {
    await this.call("POST", `/chats/${runId}/abort`, {});
  }

  async steerRun(runId: string, message: string): Promise<void> {
    await this.call("POST", `/chats/${runId}/steer`, { message });
  }

  /** The run id is the chat id. The extension's confirm resolves with this answer. */
  async respondApproval(runId: string, approvalId: string, approve: boolean): Promise<void> {
    await this.call("POST", `/chats/${runId}/ui_response`, { id: approvalId, confirmed: approve });
  }

  /* ---------- internals ---------- */

  private async *frames(
    runId: string, sessionId: string, model: string, body: ReadableStream<Uint8Array>, ctl: AbortController,
  ): AsyncGenerator<HermesFrame> {
    yield { type: "run.started", runId, sessionId, assistantMessageId: "", model };
    const st = newPiMapState();
    try {
      for await (const ev of sseEvents(body)) {
        for (const f of mapPiEvent(ev.event, ev.data, model, st)) {
          yield f;
          if (f.type === "done") return;
        }
      }
      yield { type: "done", status: "failed", error: "pi stream ended unexpectedly", model };
    } finally {
      ctl.abort();
    }
  }

  private async raw(method: string, path: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      return await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new ChatError(502, "pi bridge unreachable");
    }
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
    const res = await this.raw(method, path, body);
    if (!res.ok) throw await this.failure(path.split("/").pop() || "request", res);
    const text = await res.text().catch(() => "");
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new ChatError(502, "pi bridge returned invalid JSON");
    }
  }

  private async open(path: string, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    let res: Response;
    try {
      res = await fetch(this.base + path, { headers: { authorization: `Bearer ${this.token}` }, signal });
    } catch {
      throw new ChatError(502, "pi bridge unreachable");
    }
    if (!res.ok || !res.body) throw await this.failure("events", res);
    return res.body;
  }

  private async failure(what: string, res: Response): Promise<ChatError> {
    const text = await res.text().catch(() => "");
    let msg = "";
    try { msg = typeof JSON.parse(text)?.error === "string" ? JSON.parse(text).error : ""; } catch { msg = ""; }
    const detail = msg ? `: ${msg.slice(0, 200)}` : "";
    return new ChatError(502, `pi bridge ${what} failed (${res.status})${detail}`);
  }
}

function toModelDef(m: BridgeModel): ChatModelDef {
  const reasoning = m.reasoning === true;
  return {
    id: m.id as string,
    provider: m.provider as string,
    label: typeof m.name === "string" && m.name !== "" ? m.name : (m.id as string),
    reasoning,
    canDisableReasoning: reasoning,
    vision: Array.isArray(m.input) && m.input.includes("image"),
    local: false,
  };
}

/** Pi wants the prompt text and images separately. Text parts are joined; data-URL images are split out. */
function splitContent(message: string | ContentPart[]): { text: string; images: { type: "image"; data: string; mimeType: string }[] } {
  if (typeof message === "string") return { text: message, images: [] };
  const texts: string[] = [];
  const images: { type: "image"; data: string; mimeType: string }[] = [];
  for (const p of message) {
    if (p.type === "text") texts.push(p.text);
    else {
      const m = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
      if (m) images.push({ type: "image", data: m[2], mimeType: m[1] });
    }
  }
  return { text: texts.join("\n"), images };
}

/** Per-run mapping state: Pi reports usage per turn, the UI wants one running total. */
export type PiMapState = { input: number; output: number };
export const newPiMapState = (): PiMapState => ({ input: 0, output: 0 });

const PREVIEW_MAX = 300;
const cut = (t: string): string => (t.length > PREVIEW_MAX ? t.slice(0, PREVIEW_MAX - 1) + "\u2026" : t);

/** What the UI shows next to a tool call: the command for bash, the path for file tools. */
function argPreview(name: string, args: unknown): string | null {
  const a = (typeof args === "object" && args !== null ? args : {}) as Record<string, unknown>;
  if (name === "bash") return typeof a.command === "string" ? cut(a.command) : null;
  const p = a.path ?? a.file_path;
  return typeof p === "string" && p !== "" ? cut(p) : null;
}

function resultPreview(result: any): string | null {
  const parts: unknown[] = Array.isArray(result?.content) ? result.content : [];
  const text = parts.map((c) => (c as any)?.type === "text" && typeof (c as any).text === "string" ? (c as any).text : "").join("").trim();
  return text === "" ? null : cut(text);
}

/**
 * Maps one bridge SSE event to zero or more frames (event name = Pi event type, data = the raw event).
 * Stop result comes from the last assistant message's stopReason, carried on agent_settled by the bridge.
 */
export function mapPiEvent(event: string, data: any, model: string, st: PiMapState = newPiMapState()): HermesFrame[] {
  switch (event) {
    case "message_update": {
      const ae = data?.assistantMessageEvent;
      if (typeof ae?.delta !== "string" || ae.delta === "") return [];
      if (ae.type === "text_delta") return [{ type: "delta", text: ae.delta }];
      if (ae.type === "thinking_delta") return [{ type: "reasoning", text: ae.delta }];
      return [];
    }
    case "tool_execution_start": {
      const name = typeof data?.toolName === "string" ? data.toolName : "tool";
      const args = typeof data?.args === "object" && data.args !== null ? (data.args as Record<string, unknown>) : null;
      return [{ type: "tool.started", id: String(data?.toolCallId ?? ""), name, args, preview: argPreview(name, args) }];
    }
    case "tool_execution_end":
      return [{
        type: "tool.completed",
        id: String(data?.toolCallId ?? ""),
        ok: data?.isError !== true,
        durationMs: typeof data?.durationMs === "number" ? data.durationMs : null,
        preview: resultPreview(data?.result),
      }];
    case "message_end": {
      const m = data?.message;
      if (m?.role !== "assistant" || typeof m?.usage !== "object" || m.usage === null) return [];
      st.input += Number(m.usage.input) || 0;
      st.output += Number(m.usage.output) || 0;
      return [{ type: "usage", input: st.input, output: st.output }];
    }
    case "extension_ui_request": {
      if (data?.method !== "confirm" || typeof data?.id !== "string") return [];
      return [{
        type: "approval",
        id: data.id,
        command: typeof data.message === "string" ? data.message : null,
        note: typeof data.title === "string" && data.title !== "" ? data.title : "Needs approval",
        options: ["approve", "deny"],
      }];
    }
    case "agent_settled": {
      const stop = data?.stopReason;
      if (stop === "aborted") return [{ type: "done", status: "interrupted", error: null, model }];
      if (stop === "error") {
        const err = typeof data?.errorMessage === "string" && data.errorMessage !== "" ? data.errorMessage : "pi run failed";
        return [{ type: "done", status: "failed", error: err, model }];
      }
      return [{ type: "done", status: "complete", error: null, model }];
    }
    case "process_exit":
      return [{ type: "done", status: "failed", error: "pi process exited", model }];
    default:
      return [];
  }
}

/** Parses the bridge's SSE stream into {event, data}. Frames with no parseable data are skipped. */
export async function* sseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: any }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length === 0) continue;
      let parsed: unknown = null;
      try { parsed = JSON.parse(data.join("\n")); } catch { continue; }
      yield { event, data: parsed };
    }
  }
}
