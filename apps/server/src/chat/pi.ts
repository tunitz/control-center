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
import type { ContentPart, HermesFrame, StartRunArgs, TodoItem } from "./hermes";
import { PI_SETTING_DEFAULTS } from "./pi-settings";
import { ChatError } from "./http";

export type PiConfig = {
  appendSystemPrompt: string;
  agentsMd: string;
  defaultTools: string[] | null;
  gate: { extraProtectedPaths: string[]; extraRisky: string[] };
  knownTools: string[];
  /** Run Claude models through Claude Code (the pi-claude-bridge extension) instead of Pi's Anthropic client. */
  claudeBridge: boolean;
  /** Whether the Claude Code CLI and the claude-bridge extension are present. */
  claudeCode: { found: boolean; path: string | null; extension: boolean };
  /** Register the cc-browser tools for Pi chats. */
  browser: boolean;
  /** Whether the browser extension, the agent-browser CLI and a Chromium are present. */
  browserStatus: { extension: boolean; agent: boolean; chromium: boolean };
};

/** A Pi skill (global or project) with its enable/disable state. Mirrors the bridge's skills.ts. */
export type PiSkill = {
  name: string;
  description: string;
  scope: "global" | "project";
  /** Absolute SKILL.md path; the stable id used to disable it. */
  path: string;
  /** Skill directory passed to Pi as `--skill`. */
  dir: string;
  /** Working folder a project skill was found for; null for global skills. */
  cwd: string | null;
  enabled: boolean;
};

/** Provider sign-in (the chat's `/login`). Mirrors the bridge's login.ts types. */
export type PiAuthType = "oauth" | "api_key";
export type PiAuthProvider = {
  id: string;
  name: string;
  authTypes: PiAuthType[];
  oauthLabel?: string;
  subscription: boolean;
  configured: boolean;
  source?: string;
};
export type PiAuthPromptOption = { id: string; label: string; description?: string };
export type PiAuthPrompt = {
  id: string;
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: PiAuthPromptOption[];
};
export type PiAuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

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

  /** Starts a chat. `cwd` (optional) is the directory chosen at creation; the bridge rejects it if invalid. */
  async createSession(cwd?: string | null): Promise<string> {
    const id = randomUUID();
    const r = await this.call("POST", `/chats/${id}/start`, cwd ? { cwd } : {});
    if (typeof r.sessionFile !== "string" || r.sessionFile === "") throw new ChatError(502, "pi bridge returned no session file");
    this.refs.set(id, r.sessionFile);
    return id;
  }

  /** Pi working-directory picker: the bridge's directory list. */
  async listDirs(path?: string): Promise<{ path: string; parent: string | null; entries: { name: string; path: string }[] }> {
    const q = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
    return (await this.call("GET", `/dirs${q}`)) as any;
  }

  /** Pi working-directory picker: create one folder under a parent. The bridge returns 409 when it exists. */
  async makeDir(parent: unknown, name: unknown): Promise<{ path: string; name: string }> {
    return (await this.call("POST", "/dirs", { parent, name })) as any;
  }

  async deleteSession(id: string, _ref?: string | null): Promise<void> {
    const res = await this.raw("DELETE", `/chats/${id}`);
    if (res.status === 404) return;
    if (!res.ok) throw await this.failure("delete session", res);
  }

  /** Selects the model on the chat. `start` is idempotent: it applies the model to a live chat and resumes a reaped one. */
  async lockModel(id: string, model: string, provider: string, ref?: string | null, cwd?: string | null): Promise<void> {
    await this.call("POST", `/chats/${id}/start`, {
      ...(ref ? { sessionPath: ref } : {}),
      ...(cwd ? { cwd } : {}),
      model: { provider, modelId: model },
    });
  }

  async listModels(): Promise<ChatModelDef[]> {
    const t = this.now();
    if (this.cache && t - this.cache.at < MODEL_CACHE_MS) return this.cache.models;
    const r = await this.call("GET", "/models");
    const list: BridgeModel[] = Array.isArray(r.models) ? r.models : [];
    const models = list.filter((m) => typeof m.id === "string" && typeof m.provider === "string").filter(curated).map(toModelDef);
    this.cache = { at: t, models };
    return models;
  }

  async startRun(args: StartRunArgs): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }> {
    const chat = args.sessionId;
    const model = args.model;
    const provider = args.provider;
    // Always name the tools: null means "the global default", which also clears an override that was removed.
    // Pi stores live settings in its global settings.json, so a value set for one chat would leak into
    // every other chat. Sending all of them each run keeps each chat on its own values.
    const settings = { ...PI_SETTING_DEFAULTS, ...(args.piSettings ?? {}) };
    await this.call("POST", `/chats/${chat}/start`, {
      ...(args.ref ? { sessionPath: args.ref } : {}),
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(provider ? { model: { provider, modelId: model } } : {}),
      ...(args.effort ? { thinking: args.effort } : {}),
      ...(settings ? { settings } : {}),
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

  /** The bridge's global Pi configuration (system prompt, notes, default tools, extra gate rules). */
  async getConfig(): Promise<PiConfig> {
    return (await this.call("GET", "/config")) as PiConfig;
  }

  async putConfig(patch: Record<string, unknown>): Promise<PiConfig> {
    return (await this.call("PUT", "/config", patch)) as PiConfig;
  }

  /** Skills the bridge can see for these working folders, with the disabled set applied. */
  async getSkills(cwds: string[]): Promise<PiSkill[]> {
    const q = cwds.map((c) => `cwd=${encodeURIComponent(c)}`).join("&");
    const r = await this.call("GET", `/skills${q === "" ? "" : `?${q}`}`);
    return Array.isArray(r.skills) ? (r.skills as PiSkill[]) : [];
  }

  /** Replaces the disabled set and returns the recomputed skills. */
  async putSkills(disabled: string[], cwds: string[]): Promise<PiSkill[]> {
    const q = cwds.map((c) => `cwd=${encodeURIComponent(c)}`).join("&");
    const r = await this.call("PUT", `/skills${q === "" ? "" : `?${q}`}`, { disabled });
    return Array.isArray(r.skills) ? (r.skills as PiSkill[]) : [];
  }

  /** Thinking levels the model supports (starts or resumes the chat on that model first). Empty when unknown. */
  async thinkingLevels(id: string, ref: string | null, model: string, provider: string, cwd?: string | null): Promise<string[]> {
    await this.call("POST", `/chats/${id}/start`, { ...(ref ? { sessionPath: ref } : {}), ...(cwd ? { cwd } : {}), model: { provider, modelId: model } });
    const r = await this.call("POST", `/chats/${id}/command`, { name: "get_available_thinking_levels", args: {} });
    const levels = r.data?.levels;
    return Array.isArray(levels) ? levels.filter((l: unknown): l is string => typeof l === "string") : [];
  }

  /** Manual compaction. Returns Pi's before/after token estimates. */
  async compact(id: string, ref: string | null, instructions?: string, cwd?: string | null): Promise<{ tokensBefore: number; tokensAfter: number }> {
    await this.call("POST", `/chats/${id}/start`, { ...(ref ? { sessionPath: ref } : {}), ...(cwd ? { cwd } : {}) });
    const r = await this.call("POST", `/chats/${id}/command`, {
      name: "compact",
      args: instructions ? { customInstructions: instructions } : {},
    });
    return { tokensBefore: Number(r.data?.tokensBefore) || 0, tokensAfter: Number(r.data?.estimatedTokensAfter) || 0 };
  }

  /**
   * Rewinds Pi's active branch to the last user message whose text matches, so a retry re-runs from
   * there instead of stacking on the old reply. Returns null when there is no match (caller falls back).
   */
  async forkUserMessage(id: string, ref: string | null, cwd: string | null, text: string): Promise<{ text: string } | null> {
    await this.call("POST", `/chats/${id}/start`, { ...(ref ? { sessionPath: ref } : {}), ...(cwd ? { cwd } : {}) });
    const list = await this.call("POST", `/chats/${id}/command`, { name: "get_fork_messages", args: {} });
    const messages: unknown[] = Array.isArray(list?.data?.messages) ? (list.data.messages as unknown[]) : [];
    let entryId: string | null = null;
    for (const m of messages) {
      const mm = m as { entryId?: unknown; text?: unknown };
      if (typeof mm.entryId === "string" && mm.text === text) entryId = mm.entryId; // last match wins
    }
    if (entryId === null) return null;
    const r = await this.call("POST", `/chats/${id}/command`, { name: "fork", args: { entryId } });
    if (r?.data?.cancelled === true) return null;
    return { text: typeof r?.data?.text === "string" ? r.data.text : text };
  }

  /** Providers Pi can sign in to, with their auth methods and current status. */
  async authProviders(): Promise<PiAuthProvider[]> {
    const r = await this.call("GET", "/auth/providers");
    const list: unknown[] = Array.isArray(r.providers) ? r.providers : [];
    return list.filter(isAuthProvider);
  }

  /** Starts a sign-in; the bridge streams its questions on the returned id's event stream. */
  async authStart(provider: string, authType: PiAuthType): Promise<{ id: string; provider: string; providerName: string; authType: PiAuthType }> {
    const r = await this.call("POST", "/auth/login", { provider, authType });
    if (typeof r.id !== "string" || r.id === "") throw new ChatError(502, "pi bridge returned no sign-in id");
    return { id: r.id, provider: String(r.provider ?? provider), providerName: String(r.providerName ?? provider), authType };
  }

  async authRespond(id: string, value: string, promptId?: string): Promise<void> {
    await this.call("POST", `/auth/login/${encodeURIComponent(id)}/response`, promptId ? { value, promptId } : { value });
  }

  async authCancel(id: string): Promise<void> {
    const res = await this.raw("POST", `/auth/login/${encodeURIComponent(id)}/cancel`, {});
    if (res.status === 404) return;
    if (!res.ok) throw await this.failure("cancel sign-in", res);
  }

  /**
   * Streams a sign-in's questions/notices. A successful `done` also drops the cached model list,
   * so a freshly signed-in provider's models appear on the next picker load instead of up to 60 s later.
   */
  async authEvents(id: string, after: number, signal: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const body = await this.open(`/auth/login/${encodeURIComponent(id)}/events?after=${after}`, signal);
    const dec = new TextDecoder();
    const scan = new TransformStream<Uint8Array, Uint8Array>({
      transform: (chunk, controller) => {
        controller.enqueue(chunk);
        const text = dec.decode(chunk, { stream: true });
        if (/event: done\n[^]*?"ok":true/.test(text)) this.cache = null;
      },
    });
    return body.pipeThrough(scan);
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
    // The bridge validates input; its 400/409 are the caller's problem, not a gateway fault.
    if ((res.status === 400 || res.status === 409) && msg) return new ChatError(res.status, msg.slice(0, 200));
    return new ChatError(502, `pi bridge ${what} failed (${res.status})${detail}`);
  }
}

/**
 * The bridge lists every model of every provider Pi has credentials for. Only Anthropic is noisy
 * (18 models), so the picker trims it to the Opus/Sonnet/Haiku 5.5 set; every other provider Pi
 * has a key for (including one just added with `/login`) is shown as-is.
 */
const PI_ANTHROPIC_SHOWN = new Set(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
function curated(m: BridgeModel): boolean {
  if (m.provider === "anthropic") return PI_ANTHROPIC_SHOWN.has(m.id as string);
  return true;
}

function isAuthProvider(v: unknown): v is PiAuthProvider {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.id === "string" && typeof p.name === "string" && Array.isArray(p.authTypes);
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

/**
 * Provider failures arrive as `400 {"type":"error","error":{"message":"..."},...}`. Unwrap that to the
 * provider's own sentence, and give the Anthropic subscription restriction a next step instead of JSON.
 */
export function friendlyPiError(raw: string): string {
  const text = raw.trim();
  const m = /^(?:\d{3}\s*)?(\{[\s\S]*\})$/.exec(text);
  if (!m) return text;
  let body: any;
  try { body = JSON.parse(m[1]); } catch { return text; }
  const detail = typeof body?.error?.message === "string" ? body.error.message
    : typeof body?.message === "string" ? body.message
    : null;
  if (!detail) return text;
  if (/extra usage/i.test(detail) && /third-party|plan limits/i.test(detail)) {
    return "Anthropic subscription tokens cannot run third-party apps. Add extra usage at claude.ai/settings/usage, or run /login and pick Anthropic then Sign in with an API key.";
  }
  return detail;
}

const TODO_STATUS = new Set(["pending", "in_progress", "completed"]);

/** Valid items only; null when the value is not a list at all. */
function parseTodos(v: unknown): TodoItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: TodoItem[] = [];
  for (const t of v) {
    if (typeof t?.id === "string" && typeof t?.content === "string" && TODO_STATUS.has(t?.status)) {
      out.push({ id: t.id, content: t.content, status: t.status });
    }
  }
  return out;
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
    case "tool_execution_end": {
      const done: HermesFrame = {
        type: "tool.completed",
        id: String(data?.toolCallId ?? ""),
        ok: data?.isError !== true,
        durationMs: typeof data?.durationMs === "number" ? data.durationMs : null,
        preview: resultPreview(data?.result),
      };
      // The todo list comes from the tool result's details (full replace), never from the widget.
      const todos = data?.toolName === "todo_write" && data?.isError !== true ? parseTodos(data?.result?.details?.todos) : null;
      return todos ? [done, { type: "todo", todos }] : [done];
    }
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
        return [{ type: "done", status: "failed", error: friendlyPiError(err), model }];
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
