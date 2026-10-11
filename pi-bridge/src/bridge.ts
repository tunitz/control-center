import { join } from "node:path";
import { existsSync } from "node:fs";
import { applyConfigPatch, claudeCodeStatus, fingerprint, KNOWN_TOOLS, parseTools, readConfig } from "./pi-config";
import { tokenMatches, bearerFrom } from "./auth";
import { type BridgeConfig } from "./config";
import { Chat, HttpError, rpcError, type Frame } from "./chat";
import { listModelsOnce, listSessions } from "./sessions";
import { chosenCwd, listDirs, makeDir } from "./pi-dirs";
import { listSkills, parseDisabled, skillLaunch, skillsSignature, writeSkillsConfig } from "./skills";
import { resolveAgentBrowser, resolveChromium } from "./browser";
import { AuthManager, makeDeviceIdLoader, makeRuntimeLoader, type AuthType, type LoadRuntime } from "./login";

export interface BridgeDeps {
  /** Overrides the Pi SDK runtime loader (tests inject a fake). */
  loadAuthRuntime?: LoadRuntime;
}

export interface Bridge {
  fetch(req: Request): Promise<Response>;
  chats: { size(): number };
  shutdown(): Promise<void>;
}

const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_BODY = 8 * 1024 * 1024;
const GRAVE_MS = 5 * 60_000;
const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// Only these RPC commands may be passed through /command. bash and anything unknown are refused.
export const ALLOWED_COMMANDS = new Set([
  "get_state",
  "get_messages",
  "get_entries",
  "get_available_models",
  "get_available_thinking_levels",
  "set_model",
  "set_thinking_level",
  "get_commands",
  "get_fork_messages",
  "fork",
  "clone",
  "new_session",
  "switch_session",
  "set_session_name",
  "compact",
  "set_auto_compaction",
  "set_auto_retry",
  "set_steering_mode",
  "set_follow_up_mode",
]);

export function createBridge(cfg: BridgeConfig, deps: BridgeDeps = {}): Bridge {
  const live = new Map<string, Chat>();
  const auth = new AuthManager({
    loadRuntime: deps.loadAuthRuntime ?? makeRuntimeLoader(cfg),
    getDeviceId: makeDeviceIdLoader(cfg.agentDir),
    onLogin: () => {
      // A stored credential only reaches a running Pi process when it is recycled: drop idle chats
      // so the next message starts a fresh process (the session file keeps the history).
      for (const chat of [...live.values()]) {
        if (!chat.busy && !chat.exited) void drop(chat);
      }
    },
  });
  // Exited chats stay readable for a while so a client that connects after process_exit can
  // still replay the tail. They are never accepted for commands.
  const grave = new Map<string, { chat: Chat; timer: ReturnType<typeof setTimeout> }>();

  const onGone = (chat: Chat) => {
    if (live.get(chat.id) === chat) live.delete(chat.id);
    const old = grave.get(chat.id);
    if (old) clearTimeout(old.timer);
    const timer = setTimeout(() => {
      if (grave.get(chat.id)?.chat === chat) grave.delete(chat.id);
    }, GRAVE_MS);
    timer.unref?.();
    grave.set(chat.id, { chat, timer });
  };

  async function drop(chat: Chat): Promise<void> {
    // Remove from the live table first so the slot frees immediately.
    if (live.get(chat.id) === chat) live.delete(chat.id);
    await chat.kill();
  }

  const reaper = setInterval(() => {
    const now = Date.now();
    for (const chat of [...live.values()]) {
      if (!chat.busy && now - chat.lastActivity > cfg.idleMs) void drop(chat);
    }
    auth.prune();
  }, cfg.reapIntervalMs);
  reaper.unref?.();

  const json = (status: number, body: unknown) => Response.json(body, { status });

  /** The global config plus the Claude Code bridge status, so the UI can warn when a prerequisite is missing. */
  const configBody = () => ({
    ...readConfig(cfg.agentDir),
    knownTools: KNOWN_TOOLS,
    claudeCode: claudeCodeStatus(cfg.claudeBridgeExtension),
    browserStatus: {
      extension: existsSync(cfg.browserExtension),
      agent: resolveAgentBrowser(process.env, cfg.homeDir) !== null,
      chromium: resolveChromium(process.env, cfg.homeDir) !== null,
    },
  });

  function requireChatId(id: string): string {
    if (!CHAT_ID.test(id)) throw new HttpError(400, "invalid chat id");
    return id;
  }

  function requireLive(id: string): Chat {
    const chat = live.get(id);
    if (!chat || chat.exited) throw new HttpError(404, "no live chat with that id");
    return chat;
  }

  async function readBody(req: Request): Promise<Record<string, any>> {
    const text = await req.text();
    if (text.length > MAX_BODY) throw new HttpError(413, "body too large");
    if (text.trim() === "") return {};
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new HttpError(400, "invalid JSON");
    }
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "body must be a JSON object");
    return v as Record<string, any>;
  }

  function checkSessionPath(p: unknown): string {
    if (typeof p !== "string" || p.length === 0) throw new HttpError(400, "sessionPath must be a string");
    const prefix = cfg.sessionDir.endsWith("/") ? cfg.sessionDir : cfg.sessionDir + "/";
    if (!p.startsWith(prefix) || !p.endsWith(".jsonl") || p.includes("..")) {
      throw new HttpError(400, "sessionPath must be a .jsonl file inside the session dir");
    }
    return p;
  }

  function parseModel(m: unknown): { provider: string; modelId: string } | undefined {
    if (m === undefined) return undefined;
    if (!m || typeof m !== "object") throw new HttpError(400, "model must be {provider, modelId}");
    const { provider, modelId } = m as Record<string, unknown>;
    if (typeof provider !== "string" || typeof modelId !== "string") {
      throw new HttpError(400, "model must be {provider, modelId}");
    }
    return { provider, modelId };
  }

  function parseThinking(t: unknown): string | undefined {
    if (t === undefined) return undefined;
    if (typeof t !== "string" || !THINKING.includes(t)) throw new HttpError(400, "invalid thinking level");
    return t;
  }

  /** Live Pi settings a chat may carry (docs/pi-plan.md T6). Anything else is rejected, not ignored. */
  interface LiveSettings {
    /** Per-chat tool selection; applied at launch (--tools), so a change restarts the process. */
    tools?: string[] | null;
    steeringMode?: string;
    followUpMode?: string;
    autoCompaction?: boolean;
    autoRetry?: boolean;
  }
  const QUEUE_MODES = ["all", "one-at-a-time"];

  function parseSettings(v: unknown): LiveSettings | undefined {
    if (v === undefined) return undefined;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "settings must be an object");
    const out: LiveSettings = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === "steeringMode" || k === "followUpMode") {
        if (typeof val !== "string" || !QUEUE_MODES.includes(val)) throw new HttpError(400, `${k} must be all or one-at-a-time`);
        out[k] = val;
      } else if (k === "tools") {
        out.tools = val === null ? null : parseTools(val, "tools");
      } else if (k === "autoCompaction" || k === "autoRetry") {
        if (typeof val !== "boolean") throw new HttpError(400, `${k} must be a boolean`);
        out[k] = val;
      } else {
        throw new HttpError(400, `unknown setting: ${k}`);
      }
    }
    return out;
  }

  async function applySettings(chat: Chat, model?: { provider: string; modelId: string }, thinking?: string, settings?: LiveSettings) {
    if (model) await chat.expectOk({ type: "set_model", provider: model.provider, modelId: model.modelId });
    if (thinking) await chat.expectOk({ type: "set_thinking_level", level: thinking });
    if (settings?.steeringMode !== undefined) await chat.expectOk({ type: "set_steering_mode", mode: settings.steeringMode });
    if (settings?.followUpMode !== undefined) await chat.expectOk({ type: "set_follow_up_mode", mode: settings.followUpMode });
    if (settings?.autoCompaction !== undefined) await chat.expectOk({ type: "set_auto_compaction", enabled: settings.autoCompaction });
    if (settings?.autoRetry !== undefined) await chat.expectOk({ type: "set_auto_retry", enabled: settings.autoRetry });
  }

  async function start(id: string, body: Record<string, any>) {
    const model = parseModel(body.model);
    const thinking = parseThinking(body.thinking);
    const settings = parseSettings(body.settings);
    const sessionPath = body.sessionPath === undefined ? undefined : checkSessionPath(body.sessionPath);
    // A chat's cwd is fixed when it is created. Absent keeps what the live chat has (or the workspace).
    const requested = body.cwd === undefined || body.cwd === null ? undefined : chosenCwd(cfg, body.cwd);
    const running = live.get(id);
    const liveChat = running && !running.exited ? running : undefined;
    if (liveChat && requested !== undefined && requested !== liveChat.chosenCwd) {
      throw new HttpError(409, "cwd is fixed when the chat is created");
    }
    const cwd = liveChat ? liveChat.chosenCwd : requested ?? null;

    // What Pi reads only at startup: the tool list and the config files. A start that names `tools`
    // sets them (null = the global default). A start that does not, keeps what the running process
    // has, so a model change or a settings read never resets a chat's tools. If the tools or the
    // config files changed since launch, the process is restarted (idle only).
    const namesTools = settings !== undefined && "tools" in settings;
    const existing = liveChat;
    const tools = namesTools ? settings!.tools ?? readConfig(cfg.agentDir).defaultTools
      : running && liveChat ? liveChat.launchTools : readConfig(cfg.agentDir).defaultTools;
    // Skills are read at startup too, so the disabled set is part of the launch key: a toggle restarts.
    const skillsCwd = cwd ?? join(cfg.workspaceRoot, id);
    const skills = skillLaunch(cfg, skillsCwd);
    // Claude Code bridge: load the extension and keep ANTHROPIC_* out of Pi's env. Only when the
    // extension is actually present, so a half-configured toggle never strands a chat without auth.
    const cc = readConfig(cfg.agentDir);
    const useClaudeBridge = cc.claudeBridge && existsSync(cfg.claudeBridgeExtension);
    const useBrowser = cc.browser && existsSync(cfg.browserExtension);
    const extensions: string[] = [];
    if (useClaudeBridge) extensions.push(cfg.claudeBridgeExtension);
    if (useBrowser) extensions.push(cfg.browserExtension);
    const key = JSON.stringify([tools, fingerprint(cfg.agentDir), skills, skillsSignature(cfg, skillsCwd), useClaudeBridge, useBrowser, cc.compaction]);

    let resumeFrom = sessionPath;
    if (existing) {
      await existing.ready;
      if (existing.launchKey === key) {
        await applySettings(existing, model, thinking, settings);
        return json(200, { sessionFile: existing.sessionFile, state: await existing.state(), cwd: existing.chosenCwd });
      }
      if (existing.busy) throw new HttpError(409, "run active");
      resumeFrom = existing.sessionFile ?? sessionPath;
      await drop(existing);
    }
    if (live.size >= cfg.maxLive) {
      // Make room by closing the least recently used chat that is not mid-run. Its session file
      // stays on disk, so the next message resumes it. Only when every chat is busy is it a 429.
      const idle = [...live.values()].filter((c) => !c.busy && !c.exited).sort((a, b) => a.lastActivity - b.lastActivity)[0];
      if (!idle) throw new HttpError(429, `at most ${cfg.maxLive} live Pi processes, all busy`);
      await drop(idle);
    }

    const existingGrave = grave.get(id);
    if (existingGrave) {
      clearTimeout(existingGrave.timer);
      grave.delete(id);
    }
    const chat = new Chat(cfg, id, onGone);
    chat.chosenCwd = cwd;
    live.set(id, chat); // reserve the slot before any await
    try {
      chat.launch(resumeFrom, tools, key, skills, { hideAnthropic: useClaudeBridge, extensions });
      await chat.ready;
      await applySettings(chat, model, thinking, settings);
    } catch (e) {
      await drop(chat);
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `pi failed to start: ${(e as Error).message}`);
    }
    return json(200, { sessionFile: chat.sessionFile, state: await chat.state(), cwd: chat.chosenCwd });
  }

  async function prompt(id: string, kind: "prompt" | "steer" | "follow_up", body: Record<string, any>) {
    const chat = requireLive(id);
    if (typeof body.message !== "string" || body.message.trim() === "") {
      throw new HttpError(400, "message must be a non-empty string");
    }
    let images: unknown;
    if (body.images !== undefined) {
      if (!Array.isArray(body.images)) throw new HttpError(400, "images must be an array");
      for (const im of body.images) {
        if (!im || im.type !== "image" || typeof im.data !== "string" || typeof im.mimeType !== "string") {
          throw new HttpError(400, "each image needs {type:'image', data, mimeType}");
        }
      }
      images = body.images;
    }
    chat.touch();
    const cmd: Record<string, unknown> = { type: kind, message: body.message };
    if (images !== undefined) cmd.images = images;
    const before = chat.settledCount;
    const resp = await chat.send(cmd);
    if (!resp.success) throw rpcError(resp);
    const disposition = resp.data?.disposition ?? null;
    if (kind === "prompt" && disposition === "started" && chat.settledCount === before) chat.busy = true;
    chat.touch();
    return json(200, { disposition });
  }

  async function command(id: string, body: Record<string, any>) {
    if (typeof body.name !== "string" || !ALLOWED_COMMANDS.has(body.name)) {
      throw new HttpError(400, `command not allowed: ${String(body.name)}`);
    }
    const args = body.args ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new HttpError(400, "args must be an object");
    if (body.name === "switch_session") checkSessionPath(args.sessionPath);
    const chat = requireLive(id);
    chat.touch();
    const resp = await chat.send({ ...args, type: body.name });
    if (!resp.success) throw rpcError(resp);
    chat.touch();
    return json(200, { success: true, data: resp.data ?? null });
  }

  function events(id: string, url: URL): Response {
    const raw = url.searchParams.get("after") ?? "0";
    if (!/^\d+$/.test(raw)) throw new HttpError(400, "after must be a non-negative integer");
    const after = Number(raw);
    const chat = live.get(id) ?? grave.get(id)?.chat;
    if (!chat) throw new HttpError(404, "no chat with that id");
    return sseResponse(chat, after);
  }

  function sseResponse(chat: Chat, after: number): Response {
    const enc = new TextEncoder();
    let closed = false;
    let sub: ((f: Frame) => void) | undefined;
    let ka: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Bytes must flow now: with nothing queued the response headers wait for the first event or
        // the 15 s keepalive, and a client that waits for the stream before it prompts stalls that long.
        controller.enqueue(enc.encode(": open\n\n"));
        const send = (f: Frame) => {
          if (closed) return;
          const head = f.id !== undefined ? `id: ${f.id}\n` : "";
          controller.enqueue(enc.encode(`${head}event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`));
        };
        const finish = () => {
          if (closed) return;
          closed = true;
          if (sub) chat.subs.delete(sub);
          if (ka) clearInterval(ka);
          try {
            controller.close();
          } catch {}
        };
        if (chat.ring.length > 0) {
          const oldest = chat.ring[0].id!;
          if (after + 1 < oldest) send({ event: "gap", data: { requested: after, oldest, latest: chat.seq } });
          for (const f of chat.ring) if (f.id! > after) send(f);
        }
        if (chat.exited) {
          finish();
          return;
        }
        sub = (f: Frame) => {
          send(f);
          if (f.event === "process_exit") finish();
        };
        chat.subs.add(sub);
        ka = setInterval(() => {
          if (!closed) controller.enqueue(enc.encode(": ping\n\n"));
        }, 15_000);
      },
      cancel() {
        closed = true;
        if (sub) chat.subs.delete(sub);
        if (ka) clearInterval(ka);
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  async function route(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    let m: RegExpExecArray | null;
    if (path === "/config" && method === "GET") {
      return json(200, configBody());
    }
    if (path === "/config" && method === "PUT") {
      let body: unknown;
      try { body = await req.json(); } catch { throw new HttpError(400, "body must be JSON"); }
      applyConfigPatch(cfg.agentDir, body);
      return json(200, configBody());
    }
    if (path === "/skills" && method === "GET") {
      return json(200, { skills: listSkills(cfg, url.searchParams.getAll("cwd")) });
    }
    if (path === "/skills" && method === "PUT") {
      const body = await readBody(req);
      writeSkillsConfig(cfg.agentDir, parseDisabled(body.disabled));
      // Apply now: recycle idle chats so their next message launches with the new skill set.
      // A busy chat is restarted by its next /start, once the run has settled.
      for (const chat of [...live.values()]) if (!chat.busy && !chat.exited) void drop(chat);
      return json(200, { skills: listSkills(cfg, url.searchParams.getAll("cwd")) });
    }
    if (method === "GET" && path === "/dirs") {
      return json(200, listDirs(cfg, url.searchParams.get("path") ?? undefined));
    }
    if (method === "POST" && path === "/dirs") {
      const body = await readBody(req);
      return json(201, makeDir(cfg, body.parent, body.name));
    }
    if (method === "GET" && path === "/auth/providers") {
      return json(200, { providers: await auth.providers() });
    }
    if (method === "POST" && path === "/auth/login") {
      const body = await readBody(req);
      if (typeof body.provider !== "string" || body.provider === "") throw new HttpError(400, "provider is required");
      if (body.authType !== "oauth" && body.authType !== "api_key") throw new HttpError(400, "authType must be oauth or api_key");
      const session = await auth.start(body.provider, body.authType as AuthType);
      return json(201, { id: session.id, provider: session.provider, providerName: session.providerName, authType: session.authType });
    }
    if (method === "GET" && (m = /^\/auth\/login\/([^/]+)\/events$/.exec(path))) {
      const raw = url.searchParams.get("after") ?? "0";
      if (!/^\d+$/.test(raw)) throw new HttpError(400, "after must be a non-negative integer");
      return auth.events(requireChatId(m[1]), Number(raw));
    }
    if (method === "POST" && (m = /^\/auth\/login\/([^/]+)\/(response|cancel)$/.exec(path))) {
      const id = requireChatId(m[1]);
      const body = await readBody(req);
      if (m[2] === "cancel") {
        auth.cancel(id);
        return json(200, { ok: true });
      }
      if (typeof body.value !== "string") throw new HttpError(400, "value must be a string");
      if (body.promptId !== undefined && typeof body.promptId !== "string") throw new HttpError(400, "promptId must be a string");
      auth.respond(id, body.value, body.promptId);
      return json(200, { ok: true });
    }
    if (method === "GET" && path === "/sessions") {
      return json(200, { sessions: await listSessions(cfg) });
    }
    if (method === "GET" && path === "/models") {
      // Always a fresh short-lived process: a live chat started before a `/login` would report that
      // provider as unavailable. The server caches the result, so the spawn cost is paid rarely.
      const models = await listModelsOnce(cfg);
      return json(200, { models });
    }
    if (method === "DELETE" && (m = /^\/chats\/([^/]+)$/.exec(path))) {
      const id = requireChatId(m[1]);
      const chat = live.get(id);
      if (!chat) throw new HttpError(404, "no live chat with that id");
      await drop(chat);
      return json(200, { ok: true });
    }
    if (method === "GET" && (m = /^\/chats\/([^/]+)\/events$/.exec(path))) {
      return events(requireChatId(m[1]), url);
    }
    if (method === "GET" && (m = /^\/chats\/([^/]+)\/commands$/.exec(path))) {
      const chat = requireLive(requireChatId(m[1]));
      const resp = await chat.send({ type: "get_commands" });
      if (!resp.success) throw rpcError(resp);
      return json(200, { commands: resp.data?.commands ?? [] });
    }
    if (method === "POST" && (m = /^\/chats\/([^/]+)\/(start|prompt|steer|follow_up|abort|ui_response|command)$/.exec(path))) {
      const id = requireChatId(m[1]);
      const action = m[2];
      const body = await readBody(req);
      switch (action) {
        case "start":
          return start(id, body);
        case "prompt":
        case "steer":
        case "follow_up":
          return prompt(id, action === "follow_up" ? "follow_up" : action, body);
        case "abort": {
          const chat = requireLive(id);
          chat.touch();
          // Pi cannot finish an abort while a tool is blocked on a question. Decline every open
          // question first (the command does not run), then abort.
          for (const qid of [...chat.pendingUi]) {
            chat.pendingUi.delete(qid);
            chat.write({ type: "extension_ui_response", id: qid, cancelled: true });
          }
          await chat.expectOk({ type: "abort" });
          chat.touch();
          return json(200, { ok: true });
        }
        case "ui_response": {
          const chat = requireLive(id);
          if (typeof body.id !== "string" || body.id === "") throw new HttpError(400, "id is required");
          chat.pendingUi.delete(body.id);
          let cmd: Record<string, unknown>;
          if (typeof body.confirmed === "boolean") cmd = { type: "extension_ui_response", id: body.id, confirmed: body.confirmed };
          else if (typeof body.value === "string") cmd = { type: "extension_ui_response", id: body.id, value: body.value };
          else if (body.cancelled === true) cmd = { type: "extension_ui_response", id: body.id, cancelled: true };
          else throw new HttpError(400, "send confirmed (boolean), value (string) or cancelled: true");
          chat.touch();
          chat.write(cmd);
          return json(200, { ok: true });
        }
        case "command":
          return command(id, body);
      }
    }
    throw new HttpError(404, "not found");
  }

  return {
    chats: { size: () => live.size },
    async fetch(req: Request): Promise<Response> {
      const provided = bearerFrom(req);
      if (provided === null || !tokenMatches(provided, cfg.token)) return json(401, { error: "unauthorized" });
      try {
        return await route(req);
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: e.message });
        console.error("pi-bridge: unhandled error:", (e as Error).message);
        return json(500, { error: "internal error" });
      }
    },
    async shutdown() {
      clearInterval(reaper);
      for (const chat of [...live.values()]) await drop(chat);
      for (const g of grave.values()) clearTimeout(g.timer);
      grave.clear();
    },
  };
}
