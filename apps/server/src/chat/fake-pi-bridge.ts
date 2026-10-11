/**
 * In-process stand-in for the pi-bridge HTTP API (pi-bridge/src/bridge.ts), for tests.
 * Event names and payloads follow the bridge: the SSE event name is the Pi event type, and
 * agent_settled carries stopReason/errorMessage copied from the last assistant message
 * (pi-bridge/src/chat.ts). The run scenario is chosen from the prompt text:
 *   contains "SLOW"  streams a partial, waits for abort, settles stopReason "aborted"
 *   contains "ERR"   settles stopReason "error" with errorMessage "boom: provider down"
 *   contains "TODO"  runs one todo_write (2 items), then answers "Hello world"
 *   contains "TOOL"  runs one bash tool call (start, end), then answers "Hello world"
 *   contains "GATE"  runs one bash tool call that needs approval: emits extension_ui_request
 *                    confirm (id "ui-1") and waits for POST ui_response; confirmed -> tool ok,
 *                    declined -> tool_execution_end isError "Blocked by cc-gate: not approved"
 *   otherwise        streams "Hello" + " world", settles stopReason "stop"
 */
import type { Server } from "bun";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";

export type FakeModel = { provider: string; id: string; name?: string; reasoning?: boolean; input?: string[]; contextWindow?: number };
type Frame = { id: number; event: string; data: any };
type Sub = { send(f: Frame): void; close(): void };

type ChatRec = {
  id: string;
  sessionFile: string;
  /** Fixed at creation. null = the default workspace (reported as-is, not created on disk). */
  cwd: string | null;
  live: boolean;
  busy: boolean;
  aborted: boolean;
  abort: (() => void) | null;
  seq: number;
  ring: Frame[];
  subs: Set<Sub>;
  model: { provider: string; modelId: string } | null;
  prompts: string[];
  steers: string[];
  /** Resolves the pending confirm (GATE scenario). */
  answer: ((confirmed: boolean) => void) | null;
  compactions: number;
};

export type FakeRequest = { method: string; path: string; auth: string | null; body: any };

export type FakeAuthProvider = {
  id: string;
  name: string;
  authTypes: ("oauth" | "api_key")[];
  oauthLabel?: string;
  subscription?: boolean;
  configured?: boolean;
  source?: string;
};

/** One scripted sign-in: notify -> prompt -> (answer) -> done. */
type AuthRec = {
  id: string;
  provider: string;
  providerName: string;
  authType: "oauth" | "api_key";
  seq: number;
  ring: Frame[];
  subs: Set<Sub>;
  answer: ((value: string) => void) | null;
  done: boolean;
};

export const FAKE_MODELS: FakeModel[] = [
  { provider: "deepseek", id: "deepseek-flash", name: "DeepSeek V4.1 Flash", reasoning: true, contextWindow: 1_000_000 },
  { provider: "deepseek", id: "deepseek-pro", name: "DeepSeek V4.1 Pro", reasoning: true },
  // The real bridge lists every model Pi knows. The server shows only a curated few.
  { provider: "anthropic", id: "claude-opus-5-5", name: "Claude Opus 5.5", reasoning: true },
  { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", reasoning: true },
  { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true },
  { provider: "anthropic", id: "claude-opus-4-5", name: "Claude Opus 4.5 (latest)", reasoning: true },
  { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", reasoning: true },
  { provider: "openai-codex", id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true },
];

const json = (status: number, body: unknown) => Response.json(body, { status });

export class FakePiBridge {
  readonly token: string;
  readonly models: FakeModel[];
  readonly chats = new Map<string, ChatRec>();
  readonly requests: FakeRequest[] = [];
  readonly uiResponses: any[] = [];
  readonly authProviders: FakeAuthProvider[] = [
    { id: "anthropic", name: "Anthropic", authTypes: ["oauth", "api_key"], oauthLabel: "Sign in with Claude", subscription: true, configured: false },
    { id: "deepseek", name: "DeepSeek", authTypes: ["api_key"], configured: true, source: "DEEPSEEK_API_KEY" },
  ];
  readonly authLogins = new Map<string, AuthRec>();
  readonly authAnswers: { id: string; value: string; promptId?: string }[] = [];
  authStarts = 0;
  config: Record<string, any> = { appendSystemPrompt: "", agentsMd: "", defaultTools: null, gate: { extraProtectedPaths: [], extraRisky: [] }, claudeBridge: false, browser: false, compaction: { enabled: true, compactAtTokens: 200000, keepRecentTokens: 20000 } };
  modelsCalls = 0;
  /** The next N GET /models calls fail with 500 (for the no-cache-on-failure test). */
  failModels = 0;
  readonly url: string;
  /** A fake HOME on disk, with the same protected rules as the real bridge (pi-bridge/src/pi-dirs.ts). */
  readonly home: string;
  /** Skills the bridge would list, global + project, with their enable/disable state. */
  readonly skills: any[] = [];
  private readonly server: Server<undefined>;

  private constructor(server: Server<undefined>, token: string, models: FakeModel[]) {
    this.server = server;
    this.token = token;
    this.models = models;
    this.url = `http://127.0.0.1:${server.port}`;
    this.home = mkdtempSync(join(tmpdir(), "fake-pi-home-"));
    for (const d of ["projects/alpha", "projects/control-center/data", "Beta", "gamma", ".hidden", ".hermes", ".ssh", ".local/share/cc-pi/agent"]) {
      mkdirSync(join(this.home, d), { recursive: true });
    }
    writeFileSync(join(this.home, "notes.txt"), "x");
    symlinkSync("/etc", join(this.home, "escape-link"));
    this.home = realpathSync(this.home);
    const globalDir = join(this.home, ".local/share/cc-pi/agent/skills/pdf-tools");
    const projectCwd = join(this.home, "projects/alpha");
    const projectDir = join(projectCwd, ".pi/skills/release-notes");
    this.skills.push(
      { name: "pdf-tools", description: "Extract text and tables from PDF files. Use when reading or converting PDFs.", scope: "global", path: join(globalDir, "SKILL.md"), dir: globalDir, cwd: null, enabled: true },
      { name: "release-notes", description: "Draft release notes from the git history.", scope: "project", path: join(projectDir, "SKILL.md"), dir: projectDir, cwd: projectCwd, enabled: true },
    );
  }

  static start(opts: { token?: string; models?: FakeModel[] } = {}): FakePiBridge {
    const token = opts.token ?? "fake-bridge-token-0123456789";
    const models = opts.models ?? FAKE_MODELS;
    let self: FakePiBridge | undefined;
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (req) => self!.handle(req) });
    self = new FakePiBridge(server, token, models);
    return self;
  }

  async close(): Promise<void> {
    for (const rec of this.chats.values()) for (const s of [...rec.subs]) s.close();
    this.server.stop(true);
  }

  /** Test hook: the Pi process behind a chat exits; the bridge reports process_exit and closes streams. */
  crash(id: string): void {
    const rec = this.chats.get(id);
    if (!rec) return;
    rec.live = false;
    rec.busy = false;
    this.emit(rec, "process_exit", { type: "process_exit", code: 1 });
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const auth = req.headers.get("authorization");
    const text = await req.text();
    let body: any = {};
    try { body = text.trim() ? JSON.parse(text) : {}; } catch { body = {}; }
    this.requests.push({ method: req.method, path: url.pathname, auth, body });
    if (auth !== `Bearer ${this.token}`) return json(401, { error: "unauthorized" });
    return this.route(req.method, url, body);
  }

  private route(method: string, url: URL, body: any): Response {
    const p = url.pathname;
    if (method === "GET" && p === "/models") {
      this.modelsCalls++;
      if (this.failModels > 0) { this.failModels--; return json(500, { error: "internal error" }); }
      return json(200, { models: this.models });
    }
    if (p === "/config" && method === "GET") return json(200, { ...this.config, knownTools: ["read", "bash", "edit", "write", "grep", "find", "ls", "todo_write"], claudeCode: { found: false, path: null, extension: true }, browserStatus: { extension: true, agent: false, chromium: false } });
    if (p === "/skills" && method === "GET") return json(200, { skills: this.skills });
    if (p === "/skills" && method === "PUT") {
      const disabled = Array.isArray(body?.disabled) ? body.disabled : null;
      if (!disabled || disabled.some((x: unknown) => typeof x !== "string")) return json(400, { error: "disabled must be a list of skill paths" });
      for (const s of this.skills) s.enabled = !disabled.includes(s.path);
      return json(200, { skills: this.skills });
    }
    if (method === "GET" && p === "/auth/providers") return json(200, { providers: this.authProviders });
    if (method === "POST" && p === "/auth/login") return this.startAuth(body);
    const am = /^\/auth\/login\/([^/]+)\/(events|response|cancel)$/.exec(p);
    if (am) {
      if (method === "GET" && am[2] === "events") return this.authEvents(am[1], url);
      if (method === "POST" && am[2] !== "events") return this.authAction(am[1], am[2], body);
    }
    if (method === "GET" && p === "/dirs") return this.listDirs(url.searchParams.get("path"));
    if (method === "POST" && p === "/dirs") return this.makeDir(body);
    if (p === "/config" && method === "PUT") {
      const tools = body?.defaultTools;
      if (Array.isArray(tools) && tools.some((t: string) => !["read", "bash", "edit", "write", "grep", "find", "ls", "todo_write"].includes(t))) {
        return json(400, { error: "defaultTools: unknown tool rm" });
      }
      const ca = body?.compaction?.compactAtTokens;
      if (ca !== undefined && !(Number.isInteger(ca) && ca >= 50000 && ca <= 900000)) {
        return json(400, { error: "compaction.compactAtTokens must be an integer from 50000 to 900000" });
      }
      this.config = { ...this.config, ...body, compaction: { ...this.config.compaction, ...(body?.compaction ?? {}) } };
      return json(200, { ...this.config, knownTools: [], claudeCode: { found: false, path: null, extension: true }, browserStatus: { extension: true, agent: false, chromium: false } });
    }
    let m = /^\/chats\/([^/]+)\/(start|prompt|steer|abort|command|ui_response)$/.exec(p);
    if (method === "POST" && m) return this.post(m[1], m[2], body);
    m = /^\/chats\/([^/]+)$/.exec(p);
    if (method === "DELETE" && m) {
      const rec = this.chats.get(m[1]);
      if (!rec || !rec.live) return json(404, { error: "no live chat with that id" });
      rec.live = false;
      this.chats.delete(m[1]);
      for (const s of [...rec.subs]) s.close();
      return json(200, { ok: true });
    }
    m = /^\/chats\/([^/]+)\/events$/.exec(p);
    if (method === "GET" && m) return this.events(m[1], url);
    return json(404, { error: "not found" });
  }

  /** Listing rule (as the bridge): a path inside HOME that is not itself protected. */
  private listableDir(raw: unknown): { path: string; error?: undefined } | { error: string; path?: undefined } {
    if (typeof raw !== "string" || !isAbsolute(raw)) return { error: "path must be an absolute path" };
    let real: string;
    try { real = realpathSync(raw); } catch { return { error: "path does not exist" }; }
    if (!statSync(real).isDirectory()) return { error: "path is not a directory" };
    if (!(real === this.home || real.startsWith(this.home + sep))) return { error: "path is outside HOME" };
    if (this.protectedRoots().some((r) => real === r || real.startsWith(r + sep))) return { error: "path is a protected directory" };
    return { path: real };
  }

  private protectedRoots(): string[] {
    return [".hermes", ".ssh", ".local/share/cc-pi", "projects/control-center/data"].map((r) => join(this.home, r));
  }

  /** Chosen-cwd rule (as the bridge): listable, and must not contain a protected folder (HOME itself is allowed). */
  private validateCwd(raw: unknown): { path: string; error?: undefined } | { error: string; path?: undefined } {
    const v = this.listableDir(raw);
    if (v.path === undefined) return v;
    if (v.path !== this.home && this.protectedRoots().some((r) => r.startsWith(v.path + sep))) {
      return { error: "cwd cannot contain a protected directory" };
    }
    return { path: v.path };
  }

  private listDirs(raw: string | null): Response {
    const dir = raw === null ? this.home : this.listableDir(raw).path;
    if (dir === undefined) return json(400, { error: this.listableDir(raw)!.error });
    const entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, path: join(dir, d.name) }))
      .filter((e) => { try { return statSync(e.path).isDirectory() && this.listableDir(e.path).path !== undefined; } catch { return false; } })
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return json(200, { path: dir, parent: dir === this.home ? null : dirname(dir), entries });
  }

  private makeDir(body: any): Response {
    const parent = this.validateCwd(body.parent);
    if (parent.path === undefined) return json(400, { error: parent.error });
    const name = body.name;
    if (typeof name !== "string" || name.length < 1 || name.length > 64) return json(400, { error: "name must be 1-64 characters" });
    if (name.includes("/") || name.includes("\0")) return json(400, { error: "name cannot contain / or NUL" });
    if (name.startsWith(".")) return json(400, { error: "name cannot start with ." });
    const path = join(parent.path, name);
    try { mkdirSync(path); } catch { return json(409, { error: `${name} already exists` }); }
    return json(201, { path, name });
  }

  private post(id: string, action: string, body: any): Response {
    if (action === "start") {
      let rec = this.chats.get(id);
      let cwd: string | null = null;
      if (body.cwd !== undefined && body.cwd !== null) {
        const v = this.validateCwd(body.cwd);
        if (v.path === undefined) return json(400, { error: v.error });
        cwd = v.path;
      }
      if (rec && rec.live && cwd !== null && cwd !== rec.cwd) return json(409, { error: "cwd is fixed when the chat is created" });
      if (!rec || !rec.live) {
        const sessionFile = typeof body.sessionPath === "string" ? body.sessionPath : `/fake/sessions/${id}.jsonl`;
        rec = {
          id, sessionFile, live: true, busy: false, aborted: false, abort: null, seq: 0, ring: [],
          subs: new Set(), model: null, prompts: [], steers: [], answer: null, compactions: 0,
          cwd: cwd ?? (rec?.cwd ?? null),
        };
        this.chats.set(id, rec);
      }
      if (body.model && typeof body.model === "object") {
        const found = this.models.find((x) => x.provider === body.model.provider && x.id === body.model.modelId);
        if (!found) return json(502, { error: `Model not found: ${body.model.provider}/${body.model.modelId}` });
        rec.model = { provider: found.provider, modelId: found.id };
      }
      return json(200, { sessionFile: rec.sessionFile, cwd: rec.cwd, state: { sessionFile: rec.sessionFile, isStreaming: rec.busy, cwd: rec.cwd } });
    }
    const rec = this.chats.get(id);
    if (!rec || !rec.live) return json(404, { error: "no live chat with that id" });

    if (action === "prompt") {
      if (typeof body.message !== "string" || body.message.trim() === "") return json(400, { error: "message must be a non-empty string" });
      if (rec.busy) return json(409, { error: "already processing" });
      rec.prompts.push(body.message);
      this.run(rec, body.message);
      return json(200, { disposition: "started" });
    }
    if (action === "steer") {
      if (!rec.busy) return json(502, { error: "no run in progress" });
      rec.steers.push(body.message);
      return json(200, { disposition: "steered" });
    }
    if (action === "ui_response") {
      this.uiResponses.push(body);
      if (!rec.answer) return json(409, { error: "no pending request" });
      const a = rec.answer;
      rec.answer = null;
      a(body.confirmed === true);
      return json(200, { ok: true });
    }
    if (action === "abort") {
      rec.aborted = true;
      rec.abort?.();
      return json(200, { ok: true });
    }
    if (action === "command") {
      if (body.name === "compact") {
        if (rec.busy) return json(502, { error: "agent is busy" });
        rec.compactions++;
        return json(200, { success: true, data: { summary: "s", firstKeptEntryId: "e1", tokensBefore: 1000, estimatedTokensAfter: 200 } });
      }
      if (body.name === "get_available_thinking_levels") {
        return json(200, { success: true, data: { levels: ["off", "low", "high"] } });
      }
      if (body.name === "get_fork_messages") {
        return json(200, { success: true, data: { messages: rec.prompts.map((t, i) => ({ entryId: `e${i + 1}`, text: t })) } });
      }
      if (body.name === "fork") {
        const idx = rec.prompts.findIndex((_, i) => `e${i + 1}` === body.args?.entryId);
        if (idx < 0) return json(200, { success: true, data: { cancelled: true } });
        const text = rec.prompts[idx];
        rec.prompts = rec.prompts.slice(0, idx);
        return json(200, { success: true, data: { text, cancelled: false } });
      }
      if (body.name !== "set_model") return json(400, { error: `command not allowed: ${String(body.name)}` });
      const args = body.args ?? {};
      const found = this.models.find((x) => x.provider === args.provider && x.id === args.modelId);
      if (!found) return json(502, { error: `Model not found: ${args.provider}/${args.modelId}` });
      rec.model = { provider: found.provider, modelId: found.id };
      return json(200, { success: true, data: { provider: found.provider, id: found.id } });
    }
    return json(404, { error: "not found" });
  }

  private events(id: string, url: URL): Response {
    const rec = this.chats.get(id);
    if (!rec) return json(404, { error: "no chat with that id" });
    const after = Number(url.searchParams.get("after") ?? "0");
    const enc = new TextEncoder();
    let sub: Sub | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        // An SSE comment flushes the headers at once; without a first chunk Bun holds the response open.
        controller.enqueue(enc.encode(": open\n\n"));
        const write = (f: Frame) => controller.enqueue(enc.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
        for (const f of rec.ring) if (f.id > after) write(f);
        sub = {
          send: (f) => { if (!closed) write(f); },
          close: () => { if (closed) return; closed = true; rec.subs.delete(sub!); try { controller.close(); } catch {} },
        };
        if (!rec.live) { sub.close(); return; }
        rec.subs.add(sub);
      },
      cancel: () => {
        closed = true;
        if (sub) rec.subs.delete(sub);
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }

  private startAuth(body: any): Response {
    const provider = this.authProviders.find((p) => p.id === body.provider);
    if (!provider) return json(400, { error: `unknown provider: ${String(body.provider)}` });
    if (!provider.authTypes.includes(body.authType)) return json(400, { error: `${provider.name} does not support ${String(body.authType)}` });
    const id = `login-${++this.authStarts}`;
    const rec: AuthRec = { id, provider: provider.id, providerName: provider.name, authType: body.authType, seq: 0, ring: [], subs: new Set(), answer: null, done: false };
    this.authLogins.set(id, rec);
    this.authEmit(rec, "auth", { type: "auth_url", url: "https://example.com/sign-in", instructions: "Open the page" });
    this.authEmit(rec, "prompt", { id: "p1", type: "manual_code", message: "Paste the code", placeholder: "code" });
    rec.answer = () => {
      this.authEmit(rec, "auth", { type: "progress", message: "Saved" });
      this.authEmit(rec, "done", { ok: true, error: null, provider: rec.provider, authType: rec.authType });
    };
    return json(201, { id, provider: provider.id, providerName: provider.name, authType: body.authType });
  }

  private authAction(id: string, action: string, body: any): Response {
    const rec = this.authLogins.get(id);
    if (!rec) return json(404, { error: "no sign-in with that id" });
    if (action === "cancel") {
      rec.done = true;
      this.authEmit(rec, "done", { ok: false, error: "cancelled", provider: rec.provider, authType: rec.authType });
      return json(200, { ok: true });
    }
    if (rec.done || !rec.answer) return json(409, { error: "this question is no longer waiting" });
    this.authAnswers.push({ id, value: body.value, promptId: body.promptId });
    const answer = rec.answer;
    rec.answer = null;
    answer(body.value);
    return json(200, { ok: true });
  }

  private authEvents(id: string, url: URL): Response {
    const rec = this.authLogins.get(id);
    if (!rec) return json(404, { error: "no sign-in with that id" });
    const after = Number(url.searchParams.get("after") ?? "0");
    const enc = new TextEncoder();
    let sub: Sub | undefined;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(enc.encode(": open\n\n"));
        const write = (f: Frame) => controller.enqueue(enc.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
        for (const f of rec.ring) if (f.id > after) write(f);
        if (rec.done) { controller.close(); return; }
        sub = {
          send: (f) => { if (!closed) write(f); },
          close: () => { if (closed) return; closed = true; rec.subs.delete(sub!); try { controller.close(); } catch {} },
        };
        rec.subs.add(sub);
      },
      cancel: () => { closed = true; if (sub) rec.subs.delete(sub); },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8" } });
  }

  private authEmit(rec: AuthRec, event: string, data: any): void {
    const f: Frame = { id: ++rec.seq, event, data };
    rec.ring.push(f);
    for (const s of [...rec.subs]) s.send(f);
    if (event === "done") { rec.done = true; for (const s of [...rec.subs]) s.close(); }
  }

  private emit(rec: ChatRec, event: string, data: any): void {
    const f: Frame = { id: ++rec.seq, event, data };
    rec.ring.push(f);
    for (const s of [...rec.subs]) s.send(f);
    if (event === "process_exit") for (const s of [...rec.subs]) s.close();
  }

  private assistant(text: string, stopReason: string, errorMessage?: string) {
    return {
      role: "assistant",
      content: text ? [{ type: "text", text }] : [],
      api: "fake",
      provider: "deepseek",
      model: "deepseek-flash",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: { total: 0 } },
      stopReason,
      ...(errorMessage ? { errorMessage } : {}),
      timestamp: Date.now(),
    };
  }

  private settle(rec: ChatRec, msgs: any[], last: any): void {
    this.emit(rec, "turn_end", { type: "turn_end", message: last, toolResults: [] });
    this.emit(rec, "agent_end", { type: "agent_end", messages: msgs });
    // Same enrichment as pi-bridge/src/chat.ts: terminal info comes from the last assistant message.
    this.emit(rec, "agent_settled", {
      type: "agent_settled",
      aborted: last.stopReason === "aborted",
      stopReason: last.stopReason ?? null,
      errorMessage: last.errorMessage ?? null,
    });
    rec.busy = false;
    rec.aborted = false;
    rec.abort = null;
  }

  private run(rec: ChatRec, message: string): void {
    rec.busy = true;
    rec.aborted = false;
    const scenario = message.includes("SLOW") ? "slow" : message.includes("ERR") ? "err" : message.includes("GATE") ? "gate" : message.includes("TODO") ? "todo" : message.includes("TOOL") ? "tool" : "ok";
    const user = { role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() };
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));
    const update = (ae: any) => this.emit(rec, "message_update", { type: "message_update", usage: {}, assistantMessageEvent: ae });
    void (async () => {
      this.emit(rec, "agent_start", { type: "agent_start" });
      this.emit(rec, "turn_start", { type: "turn_start" });
      this.emit(rec, "message_start", { type: "message_start", message: user });
      this.emit(rec, "message_end", { type: "message_end", message: user });
      this.emit(rec, "message_start", { type: "message_start", message: { role: "assistant", content: [] } });
      await tick();
      if (scenario === "err") {
        const msg = this.assistant("", "error", "boom: provider down");
        this.emit(rec, "message_end", { type: "message_end", message: msg });
        this.settle(rec, [user, msg], msg);
        return;
      }
      if (scenario === "slow") {
        update({ type: "text_start", contentIndex: 0 });
        update({ type: "text_delta", contentIndex: 0, delta: "partial" });
        if (!rec.aborted) await new Promise<void>((r) => (rec.abort = r));
        const msg = this.assistant("partial", "aborted", "Request was aborted");
        this.emit(rec, "message_end", { type: "message_end", message: msg });
        this.settle(rec, [user, msg], msg);
        return;
      }
      if (scenario === "todo") {
        const todos = [{ id: "1", content: "step one", status: "completed" }, { id: "2", content: "step two", status: "in_progress" }];
        this.emit(rec, "tool_execution_start", { type: "tool_execution_start", toolCallId: "todo-1", toolName: "todo_write", args: { todos } });
        this.emit(rec, "tool_execution_end", {
          type: "tool_execution_end", toolCallId: "todo-1", toolName: "todo_write", isError: false,
          result: { content: [{ type: "text", text: "Todo list updated (2 items)" }], details: { todos } },
        });
      }
      if (scenario === "tool" || scenario === "gate") {
        const args = { command: "echo hi > /tmp/x", timeout: null };
        const call = this.assistant("", "toolUse");
        this.emit(rec, "message_end", { type: "message_end", message: call });
        this.emit(rec, "tool_execution_start", { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args });
        let ok = true;
        if (scenario === "gate") {
          ok = await new Promise<boolean>((r) => {
            rec.answer = r;
            this.emit(rec, "extension_ui_request", { type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow command?", message: `Run: ${args.command}` });
          });
        }
        this.emit(rec, "tool_execution_end", {
          type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: !ok,
          result: { content: [{ type: "text", text: ok ? "(no output)" : "Blocked by cc-gate: not approved" }] },
          ...(ok ? { durationMs: 7 } : {}),
        });
      }
      update({ type: "text_start", contentIndex: 0 });
      update({ type: "text_delta", contentIndex: 0, delta: "Hello" });
      update({ type: "text_delta", contentIndex: 0, delta: " world" });
      update({ type: "text_end", contentIndex: 0 });
      const msg = this.assistant("Hello world", "stop");
      this.emit(rec, "message_end", { type: "message_end", message: msg });
      this.settle(rec, [user, msg], msg);
    })();
  }
}
