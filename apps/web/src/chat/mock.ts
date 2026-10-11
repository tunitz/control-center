// DEV ONLY. In-memory stand-in for /api/chat and the chat run SSE. Installed only when
// localStorage 'cc-chat-mock' === '1' or the URL has ?chatmock=1. Everything else passes through.
import type { Attachment, ChatMessage, ChatModel, ChatSession, Effort, RunEvent } from "./types";

export function mockEnabled(): boolean {
  try {
    if (localStorage.getItem("cc-chat-mock") === "1") return true;
  } catch {
    /* no storage */
  }
  return /[?&]chatmock=1\b/.test(location.search);
}

const NOW = Date.now();
const H = 3600_000;
const D = 24 * H;
let counter = 0;
const nid = (p: string) => `${p}${(++counter).toString(36)}`;

const MODELS: ChatModel[] = [
  { id: "claude-sonnet-5-5", provider: "Anthropic", label: "Claude Sonnet 5.5", reasoning: true, canDisableReasoning: true, vision: true, local: false, online: true },
  { id: "claude-opus-5", provider: "Anthropic", label: "Claude Opus 5", reasoning: true, canDisableReasoning: true, vision: true, local: false, online: true },
  { id: "gpt-5", provider: "OpenAI", label: "GPT-5.x", reasoning: true, canDisableReasoning: false, vision: true, local: false, online: true },
  { id: "deepseek-v4", provider: "DeepSeek", label: "DeepSeek V4", reasoning: true, canDisableReasoning: false, vision: false, local: false, online: true },
  { id: "qwen3.6-35b", provider: "tun-sfx", label: "Qwen3.6-35B-A3B", reasoning: true, canDisableReasoning: true, vision: false, local: true, online: false },
  { id: "qwen3.5-4b", provider: "tun-sfx", label: "Qwen3.5-4B", reasoning: false, canDisableReasoning: false, vision: false, local: true, online: false },
];
const CONTEXT: Record<string, number> = {
  "claude-sonnet-5-5": 200000,
  "claude-opus-5": 200000,
  "gpt-5": 400000,
  "deepseek-v4": 128000,
  "qwen3.6-35b": 32768,
  "qwen3.5-4b": 32768,
};

const SCRIPT_REASONING =
  "The backup log has a success line at 02:14. The worker restart at 03:12 came from a failed health probe. I should check the compose restart policy before answering.";
const SCRIPT_TEXT = [
  "The nightly backup ran at 02:00 and finished in 14 minutes with no restic errors. The worker restarted once at 03:12 after a failed health probe.\n\n",
  "Three things stand out:\n\n- Retention keeps **7 daily** and 4 weekly snapshots.\n- The repository grew by 2.3 GB since Monday.\n- `hermes-worker` uses `restart: unless-stopped`, so the restart was automatic.\n\n",
  "| Service | Status | Restarts | Uptime |\n|---|---|---|---|\n| backup | healthy | 0 | 6d 4h |\n| hermes-worker | healthy | 1 | 2h 11m |\n| caddy | healthy | 0 | 19d |\n\n",
  "The backup entry needs no change:\n\n```yaml\nservices:\n  backup:\n    image: restic/restic:0.17\n    command: [\"backup\", \"/data\"]\n    restart: unless-stopped\n```\n\n",
  "Read the link: [restic docs](https://restic.readthedocs.io/) and ignore this remote pixel ![t](https://tracker.example/p.png). <script>alert(1)</script> is shown as text.",
];

type RunRec = {
  sessionId: string;
  messageId: string;
  events: RunEvent[];
  done: boolean;
  timer: ReturnType<typeof setInterval> | null;
  listeners: Set<(ev: RunEvent) => void>;
  message: ChatMessage;
};

type Store = {
  sessions: ChatSession[];
  messages: Map<string, ChatMessage[]>;
  runs: Map<string, RunRec>;
  files: Map<string, Attachment>;
  globalListeners: Set<(d: unknown) => void>;
};

function sess(id: string, title: string, o: Partial<ChatSession> & { ago: number }): ChatSession {
  const { ago, ...rest } = o;
  return {
    id,
    title,
    titleAuto: false,
    model: "claude-sonnet-5-5",
    provider: "Anthropic",
    effort: "medium",
    pinned: false,
    archived: false,
    createdAt: NOW - ago,
    updatedAt: NOW - ago,
    runState: "idle",
    awaiting: 0,
    runId: null,
    unread: false,
    preview: "",
    cwd: null,
    ...rest,
  };
}

function msg(sid: string, seq: number, role: "user" | "assistant", text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: nid("m"),
    seq,
    role,
    text,
    reasoning: null,
    tools: [],
    usage: null,
    status: "complete",
    runId: null,
    model: role === "assistant" ? "claude-sonnet-5-5" : null,
    attachments: [],
    createdAt: NOW - (1000 - seq) * 60_000,
    error: null,
    ...extra,
  };
}

function att(store: Store, o: { kind: "image" | "file"; name: string; mime: string; size: number; w?: number; h?: number }): Attachment {
  const id = nid("f");
  const a: Attachment = { id, kind: o.kind, name: o.name, mime: o.mime, size: o.size, w: o.w ?? null, h: o.h ?? null, url: `/api/chat/files/${id}` };
  store.files.set(id, a);
  return a;
}

function seed(store: Store) {
  const add = (s: ChatSession) => {
    store.sessions.push(s);
    store.messages.set(s.id, []);
    return s;
  };
  const push = (sid: string, m: ChatMessage) => store.messages.get(sid)!.push(m);

  add(sess("s-dns", "Homelab DNS audit", { pinned: true, ago: 3 * D, preview: "Checked the zone file" }));
  push("s-dns", msg("s-dns", 1, "user", "Audit the DNS records for the homelab zone."));
  push("s-dns", msg("s-dns", 2, "assistant", "Checked the zone file. Two records point to a retired host (`10.0.0.9`)."));

  add(sess("s-backup", "Nightly backup check", { ago: 2 * H, preview: "The nightly backup ran at 02:00", model: "claude-sonnet-5-5" }));
  const img = att(store, { kind: "image", name: "screenshot-2026-10-10.png", mime: "image/png", size: 182_000, w: 1280, h: 800 });
  const log = att(store, { kind: "file", name: "backup-job.log", mime: "text/plain", size: 12_288 });
  push("s-backup", msg("s-backup", 1, "user", "Did the nightly backup run? Compare the log with the compose file.", { attachments: [img, log] }));
  push(
    "s-backup",
    msg("s-backup", 2, "assistant", SCRIPT_TEXT.join(""), {
      reasoning: SCRIPT_REASONING,
      tools: [
        { id: "t1", name: "terminal", args: { command: "docker ps" }, preview: "backup Up 6 days (healthy)", status: "ok", durationMs: 800 },
        { id: "t2", name: "read_file", args: { path: "docker-compose.yml" }, preview: "services:\n  backup:", status: "ok", durationMs: 100 },
      ],
      usage: { input: 14200, output: 1100 },
    }),
  );

  add(sess("s-disk", "Disk usage on tun-sfx", { ago: 5 * 60_000, runState: "running", model: "qwen3.6-35b", provider: "tun-sfx", effort: "low", preview: "Listing the largest directories" }));
  push("s-disk", msg("s-disk", 1, "user", "Which directories use the most space on the model disk?"));
  const liveMsg = msg("s-disk", 2, "assistant", "", { status: "running", runId: "run-live", model: "qwen3.6-35b" });
  push("s-disk", liveMsg);
  startLive(store, "run-live", "s-disk", liveMsg);

  add(sess("s-caddy", "Explain caddy 502 logs", { ago: 4 * H, unread: true, preview: "Interrupted", model: "deepseek-v4", provider: "DeepSeek" }));
  push("s-caddy", msg("s-caddy", 1, "user", "Why do the caddy logs show 502 for /api/chat?"));
  push(
    "s-caddy",
    msg("s-caddy", 2, "assistant", "The upstream closed the connection before", {
      status: "interrupted",
      error: "Run interrupted: CC restarted",
      model: "deepseek-v4",
    }),
  );

  add(sess("s-jf", "Jellyfin transcode settings", { ago: 3 * D, preview: "Failed", model: "gpt-5", provider: "OpenAI" }));
  push("s-jf", msg("s-jf", 1, "user", "Set the transcode bitrate to 8 Mbps."));
  push("s-jf", msg("s-jf", 2, "assistant", "", { status: "failed", error: "Model returned an error: rate limit", model: "gpt-5" }));

  add(sess("s-long", "Restic retention notes", { ago: 6 * D, preview: "Message 90" }));
  for (let i = 1; i <= 90; i++) push("s-long", msg("s-long", i, i % 2 ? "user" : "assistant", `${i % 2 ? "Question" : "Answer"} ${i} about restic retention.`));

  add(sess("s-old", "Old Sonarr experiment", { archived: true, ago: 12 * D, preview: "Archived" }));
}

function emit(store: Store, runId: string, ev: RunEvent) {
  const r = store.runs.get(runId);
  if (!r || r.done) return;
  r.events.push(ev);
  const list = store.messages.get(r.sessionId)!;
  const i = list.findIndex(m => m.id === r.messageId);
  applyToMessage(r.message, ev);
  if (i >= 0) list[i] = { ...r.message };
  for (const l of r.listeners) l(ev);
  if (ev.type === "done") {
    r.done = true;
    if (r.timer) clearInterval(r.timer);
    const s = store.sessions.find(x => x.id === r.sessionId);
    if (s) {
      s.runState = "idle";
      s.runId = null;
      s.updatedAt = Date.now();
      s.preview = r.message.text.slice(0, 80) || r.message.error || "";
    }
    for (const l of store.globalListeners) l({ sessionId: r.sessionId, runId, state: "idle" });
  }
}

function applyToMessage(m: ChatMessage, ev: RunEvent) {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "delta":
      m.text += String(d.text ?? "");
      break;
    case "reasoning":
      m.reasoning = (m.reasoning ?? "") + String(d.text ?? "");
      break;
    case "tool.started":
      m.tools = [...m.tools, { id: String(d.id), name: String(d.name), args: (d.args as Record<string, unknown>) ?? null, preview: null, status: "running", durationMs: null }];
      break;
    case "tool.completed":
      m.tools = m.tools.map(t => (t.id === String(d.id) ? { ...t, status: d.ok ? "ok" : "failed", durationMs: (d.durationMs as number) ?? null, preview: (d.preview as string) ?? t.preview } : t));
      break;
    case "usage":
      m.usage = { input: Number(d.input) || 0, output: Number(d.output) || 0 };
      break;
    case "done":
      m.status = (d.status as ChatMessage["status"]) ?? "complete";
      m.error = (d.error as string) ?? null;
      break;
  }
}

/** A run that streams forever until stopped (the "running session" fixture). */
function startLive(store: Store, runId: string, sessionId: string, base: ChatMessage) {
  const rec: RunRec = { sessionId, messageId: base.id, events: [], done: false, timer: null, listeners: new Set(), message: base };
  store.runs.set(runId, rec);
  const s = store.sessions.find(x => x.id === sessionId);
  if (s) {
    s.runState = "running";
    s.runId = runId;
  }
  const seq = ["Listing the largest directories", " under /models. ", "The GGUF cache is ", "the largest at 41 GB.", " ", "Next, the ", "cache index. "];
  let k = 0;
  rec.timer = setInterval(() => {
    if (k === 0) emit(store, runId, { id: 0, type: "reasoning", data: { text: "Checking du output. " } });
    if (k < seq.length) emit(store, runId, { id: 0, type: "delta", data: { text: seq[k] } });
    k++;
  }, 900);
}

/** A run that replays a scripted answer (the reply fixture for /send). */
function startScripted(store: Store, runId: string, sessionId: string, base: ChatMessage) {
  const rec: RunRec = { sessionId, messageId: base.id, events: [], done: false, timer: null, listeners: new Set(), message: base };
  store.runs.set(runId, rec);
  const s = store.sessions.find(x => x.id === sessionId);
  if (s) {
    s.runState = "running";
    s.runId = runId;
  }
  for (const l of store.globalListeners) l({ sessionId, runId, state: "running" });
  const steps: { after: number; type: RunEvent["type"]; data: unknown }[] = [];
  let t = 120;
  const add = (type: RunEvent["type"], data: unknown, ms: number) => {
    t += ms;
    steps.push({ after: t, type, data });
  };
  add("reasoning", { text: SCRIPT_REASONING }, 0);
  add("tool.started", { id: "t1", name: "terminal", args: { command: "docker ps" } }, 150);
  add("tool.completed", { id: "t1", ok: true, durationMs: 800, preview: "backup Up 6 days (healthy)" }, 800);
  for (const chunk of SCRIPT_TEXT)
    for (let i = 0; i < chunk.length; i += 24) add("delta", { text: chunk.slice(i, i + 24) }, 60);
  add("usage", { input: 14900, output: 640 }, 80);
  add("done", { status: "complete", error: null }, 40);
  for (const st of steps) {
    setTimeout(() => emit(store, runId, { id: 0, type: st.type, data: st.data as Record<string, unknown> }), st.after);
  }
}

/** Replays events after `after` to a listener; keeps streaming until done. */
function subscribe(store: Store, runId: string, after: number, deliver: (e: RunEvent, id: number) => void, end: () => void): (() => void) | null {
  const r = store.runs.get(runId);
  if (!r) {
    end();
    return null;
  }
  r.events.forEach((e, i) => {
    if (i + 1 > after) deliver(e, i + 1);
  });
  if (r.done) {
    end();
    return null;
  }
  let id = r.events.length;
  const listener = (e: RunEvent) => {
    id++;
    deliver(e, id);
    if (e.type === "done") end();
  };
  r.listeners.add(listener);
  return () => r.listeners.delete(listener);
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function installChatMock(): void {
  if (!mockEnabled() || (globalThis as Record<string, unknown>).__ccChatMock) return;
  (globalThis as Record<string, unknown>).__ccChatMock = true;
  const store: Store = { sessions: [], messages: new Map(), runs: new Map(), files: new Map(), globalListeners: new Set() };
  seed(store);
  const realFetch = window.fetch.bind(window);
  const sessionOf = (id: string) => store.sessions.find(s => s.id === id);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
    if (!url.pathname.startsWith("/api/chat")) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const p = url.pathname.slice("/api/chat".length);
    const body = init?.body;
    await new Promise(r => setTimeout(r, 60));

    if (p === "/models" && method === "GET") return json(MODELS);
    if (p === "/config" && method === "GET") return json({ defaultModel: "claude-sonnet-5-5", defaultEffort: "medium", maxUploadMb: 25, contextWindow: CONTEXT });

    if (p === "/sessions" && method === "GET") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      const archived = url.searchParams.get("archived") === "1";
      let list = store.sessions.filter(s => s.archived === archived);
      if (q) {
        list = list.filter(s => s.title.toLowerCase().includes(q) || (store.messages.get(s.id) ?? []).some(m => m.text.toLowerCase().includes(q)));
        return json(list.map(s => ({ ...s, snippet: s.title })));
      }
      return json(list);
    }
    if (p === "/sessions" && method === "POST") {
      const b = typeof body === "string" ? JSON.parse(body) : {};
      const s = sess(nid("s-"), "New chat", { ago: 0, model: b.model ?? "claude-sonnet-5-5", effort: b.effort ?? "medium", titleAuto: true });
      store.sessions.push(s);
      store.messages.set(s.id, []);
      return json(s, 201);
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/sessions\/([^/]+)$/.exec(p))) {
      const s = sessionOf(decodeURIComponent(m[1]));
      if (!s) return json({ error: "not found" }, 404);
      if (method === "PATCH") {
        const b = JSON.parse(String(body));
        if (typeof b.title === "string") {
          s.title = b.title;
          s.titleAuto = false;
        }
        for (const k of ["pinned", "archived", "model", "effort"] as const) if (k in b) (s as unknown as Record<string, unknown>)[k] = b[k];
        return json(s);
      }
      if (method === "DELETE") {
        if (s.runState === "running") return json({ error: "run active" }, 409);
        store.sessions = store.sessions.filter(x => x !== s);
        store.messages.delete(s.id);
        return json({ ok: true });
      }
    }
    if ((m = /^\/sessions\/([^/]+)\/messages$/.exec(p)) && method === "GET") {
      const sid = decodeURIComponent(m[1]);
      const all = store.messages.get(sid) ?? [];
      const before = url.searchParams.get("before");
      const limit = Number(url.searchParams.get("limit") ?? 40);
      const eligible = before ? all.filter(x => x.seq < Number(before)) : all;
      const page = eligible.slice(-limit);
      return json({ messages: page, hasMore: eligible.length > page.length });
    }
    if ((m = /^\/sessions\/([^/]+)\/send$/.exec(p)) && method === "POST") {
      const sid = decodeURIComponent(m[1]);
      const s = sessionOf(sid);
      if (!s) return json({ error: "not found" }, 404);
      if (s.runState === "running") return json({ error: "run active" }, 409);
      const fd = body as FormData;
      const text = String(fd.get("text") ?? "");
      const files = fd.getAll("files").filter((f): f is File => f instanceof File);
      const list = store.messages.get(sid)!;
      const seq = (list[list.length - 1]?.seq ?? 0) + 1;
      const atts = files.map(f => att(store, { kind: f.type.startsWith("image/") ? "image" : "file", name: f.name, mime: f.type || "application/octet-stream", size: f.size, w: 800, h: 600 }));
      const userMessage = msg(sid, seq, "user", text, { attachments: atts });
      list.push(userMessage);
      const runId = nid("run-");
      const assistantMessage = msg(sid, seq + 1, "assistant", "", { status: "running", runId, model: s.model });
      list.push(assistantMessage);
      if (s.titleAuto && s.title === "New chat" && text) s.title = text.split(/\s+/).slice(0, 8).join(" ");
      s.updatedAt = Date.now();
      s.model = String(fd.get("model") ?? s.model);
      if (fd.get("effort")) s.effort = fd.get("effort") as Effort;
      startScripted(store, runId, sid, assistantMessage);
      return json({ runId, userMessage, assistantMessage }, 201);
    }
    if ((m = /^\/runs\/([^/]+)\/stop$/.exec(p)) && method === "POST") {
      const runId = decodeURIComponent(m[1]);
      if (store.runs.get(runId) && !store.runs.get(runId)!.done) emit(store, runId, { id: 0, type: "done", data: { status: "interrupted", error: "Stopped by user" } });
      return json({ ok: true });
    }
    if ((m = /^\/runs\/([^/]+)\/steer$/.exec(p)) && method === "POST") {
      const r = store.runs.get(decodeURIComponent(m[1]));
      if (!r || r.done) return json({ error: "run finished" }, 409);
      return json({ ok: true });
    }
    if ((m = /^\/sessions\/([^/]+)\/export$/.exec(p))) {
      return new Response(`# ${sessionOf(decodeURIComponent(m[1]))?.title ?? "Chat"}\n\n(mock export)\n`, { headers: { "content-type": "text/markdown" } });
    }
    if ((m = /^\/files\/([^/]+)$/.exec(p))) {
      const a = store.files.get(m[1]);
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect width="640" height="400" fill="#4f5bf0" opacity=".25"/><rect x="40" y="60" width="360" height="24" rx="12" fill="#4f5bf0" opacity=".6"/><rect x="40" y="110" width="520" height="16" rx="8" fill="#888" opacity=".4"/><circle cx="520" cy="300" r="40" fill="#4f5bf0" opacity=".7"/></svg>`;
      return new Response(a?.kind === "image" ? svg : "mock file", { headers: { "content-type": a?.kind === "image" ? "image/svg+xml" : "application/octet-stream" } });
    }
    return json({ error: "mock: no route " + method + " " + p }, 404);
  };

  // EventSource stand-in for run streams and the global chat.run feed.
  class MockES {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 1;
    onerror: ((e: Event) => void) | null = null;
    private handlers = new Map<string, Set<(e: Event) => void>>();
    private unsub: (() => void) | null = null;
    constructor(url: string) {
      const u = new URL(url, location.href);
      if (u.pathname === "/api/events") {
        const l = (d: unknown) => this.fire("chat.run", d);
        store.globalListeners.add(l);
        this.unsub = () => store.globalListeners.delete(l);
        return;
      }
      const mm = /^\/api\/chat\/runs\/([^/]+)\/events$/.exec(u.pathname);
      if (!mm) throw new Error("mock: unexpected EventSource " + url);
      const runId = decodeURIComponent(mm[1]);
      const after = Number(u.searchParams.get("last") ?? 0) || 0;
      setTimeout(() => {
        if (!store.runs.has(runId)) {
          this.readyState = 2;
          this.onerror?.(new Event("error"));
          return;
        }
        this.unsub = subscribe(
          store,
          runId,
          after,
          (e, id) => this.fire(e.type, e.data, id),
          () => {
            this.readyState = 2;
          },
        );
      }, 30);
    }
    private fire(type: string, data: unknown, id = 0) {
      const e = new MessageEvent(type, { data: JSON.stringify(data), lastEventId: String(id) });
      for (const h of this.handlers.get(type) ?? []) h(e);
    }
    addEventListener(type: string, h: (e: Event) => void) {
      if (!this.handlers.has(type)) this.handlers.set(type, new Set());
      this.handlers.get(type)!.add(h);
    }
    removeEventListener(type: string, h: (e: Event) => void) {
      this.handlers.get(type)?.delete(h);
    }
    close() {
      this.readyState = 2;
      this.unsub?.();
      this.unsub = null;
    }
  }
  (window as unknown as Record<string, unknown>).EventSource = MockES;
  console.info("[cc] chat mock active (in-memory, dev only)");
}
