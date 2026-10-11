import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../db";
import { handleChat, type ChatContext } from "./routes";
import { FakeHermes } from "./fake-hermes";
import { FakePiBridge } from "./fake-pi-bridge";
import { PiClient } from "./pi";
import * as S from "./store";

let ctx: ChatContext;
let fake: FakeHermes;
let bridge: FakePiBridge;
let pi: PiClient;
const seen: string[] = []; // every response body, for the token-leak check

beforeEach(() => {
  fake = new FakeHermes();
  bridge = FakePiBridge.start();
  pi = new PiClient({ baseUrl: bridge.url, token: bridge.token });
  ctx = {
    db: openDb(":memory:"), hermes: fake, pi,
    uploadRoot: resolve(mkdtempSync(join(tmpdir(), "chat-pi-routes-"))), now: () => 1_000_000,
  };
});
afterEach(async () => {
  await bridge.close();
});

const run = (r: Request) => handleChat(r, new URL(r.url), ctx);
const req = (method: string, p: string, body?: unknown) => {
  const h: Record<string, string> = {};
  if (method !== "GET") h["x-cc"] = "1";
  let b: BodyInit | undefined;
  if (body instanceof FormData) b = body;
  else if (body !== undefined) { b = JSON.stringify(body); h["content-type"] = "application/json"; }
  return new Request("http://cc.local" + p, { method, headers: h, body: b });
};
async function js(r: Response): Promise<{ status: number; body: any }> {
  const text = await r.text();
  seen.push(text);
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
const fd = (text: string) => { const f = new FormData(); f.set("text", text); return f; };
async function waitIdle(id: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (S.getSession(ctx.db, id)!.runState === "idle") return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`session ${id} never went idle`);
}

test("POST /sessions {backend:'pi'} creates a Pi chat and reports backend on the session", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  expect(r.status).toBe(201);
  expect(r.body.backend).toBe("pi");
  expect(bridge.chats.has(r.body.id)).toBe(true);
  expect(fake.locks).toEqual([]);
  expect(S.getBackend(ctx.db, r.body.id)).toEqual({ backend: "pi", ref: `${bridge.chats.get(r.body.id)!.sessionFile}` });
  const list = await js(await run(req("GET", "/api/chat/sessions")));
  expect(list.body.map((s: any) => [s.id, s.backend])).toEqual([[r.body.id, "pi"]]);
});

test("POST /sessions without a backend stays hermes", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect(r.status).toBe(201);
  expect(r.body.backend).toBe("hermes");
  expect(fake.locks.map((l) => l.id)).toEqual([r.body.id]);
  expect(bridge.chats.size).toBe(0);
});

test("POST /sessions rejects an unknown backend and a pi chat without a model", async () => {
  expect((await js(await run(req("POST", "/api/chat/sessions", { backend: "nope" })))).status).toBe(400);
  expect((await js(await run(req("POST", "/api/chat/sessions", { backend: "pi" })))).status).toBe(400);
  expect(bridge.chats.size).toBe(0);
});

test("POST /sessions {backend:'pi'} with a model Pi does not know fails 400 and leaves no chat behind", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "no-such-model" })));
  expect(r.status).toBe(400);
  expect(bridge.chats.size).toBe(0);
  expect(S.listSessions(ctx.db)).toEqual([]);
});

test("POST /sessions {backend:'pi'} is 503 when no Pi bridge is configured", async () => {
  ctx = { ...ctx, pi: undefined };
  expect((await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })))).status).toBe(503);
});

test("backend is immutable: PATCH cannot change it", async () => {
  const { body } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const r = await js(await run(req("PATCH", `/api/chat/sessions/${body.id}`, { backend: "hermes" })));
  expect(r).toEqual({ status: 400, body: { error: "backend cannot be changed" } });
  expect(S.getBackend(ctx.db, body.id)!.backend).toBe("pi");
});

test("GET /models merges Pi models with a backend field on every entry; hermes entries say 'hermes'", async () => {
  const models = (await js(await run(req("GET", "/api/chat/models")))).body as { id: string; backend: string; online: boolean }[];
  expect(models.every((m) => m.backend === "hermes" || m.backend === "pi")).toBe(true);
  expect(models.filter((m) => m.backend === "pi").map((m) => m.id)).toEqual(["deepseek-flash", "deepseek-pro"]);
  expect(models.filter((m) => m.backend === "pi").every((m) => m.online === true)).toBe(true);
  expect(models.filter((m) => m.backend === "hermes").length).toBeGreaterThan(0);
  expect(models.filter((m) => m.backend === "hermes").every((m) => m.backend === "hermes")).toBe(true);
});

test("GET /models with the bridge down still returns Hermes models and omits Pi, with no error", async () => {
  const deadBridge = FakePiBridge.start({ token: "down-token-0123456789abcdef" });
  const deadUrl = deadBridge.url;
  await deadBridge.close();
  ctx = { ...ctx, pi: new PiClient({ baseUrl: deadUrl, token: "down-token-0123456789abcdef" }) };
  const r = await js(await run(req("GET", "/api/chat/models")));
  expect(r.status).toBe(200);
  expect(r.body.some((m: any) => m.backend === "pi")).toBe(false);
  expect(r.body.length).toBeGreaterThan(0);
  expect(r.body.every((m: any) => m.backend === "hermes")).toBe(true);
});

test("a Pi send runs to done through the bridge and never touches Hermes", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("hello"))));
  expect(sent.status).toBe(201);
  await waitIdle(s.id);
  expect(S.getMessage(ctx.db, sent.body.assistantMessage.id)).toMatchObject({ status: "complete", text: "Hello world" });
  expect(bridge.chats.get(s.id)!.prompts).toEqual(["hello"]);
  expect(fake.locks).toEqual([]);
});

test("stop on a Pi run ends it interrupted", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("SLOW please"))));
  for (let i = 0; i < 200 && !(S.getMessage(ctx.db, sent.body.assistantMessage.id)?.text); i++) await new Promise((r) => setTimeout(r, 5));
  expect((await js(await run(req("POST", `/api/chat/runs/${sent.body.runId}/stop`)))).status).toBe(200);
  await waitIdle(s.id);
  expect(S.getMessage(ctx.db, sent.body.assistantMessage.id)).toMatchObject({ status: "interrupted" });
});

test("a Pi run that errors ends failed with the Pi error text", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("ERR now"))));
  await waitIdle(s.id);
  expect(S.getMessage(ctx.db, sent.body.assistantMessage.id)).toMatchObject({ status: "failed", error: "boom: provider down" });
});

test("deleting a Pi session ends its bridge chat", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  expect(bridge.chats.has(s.id)).toBe(true);
  expect((await js(await run(req("DELETE", `/api/chat/sessions/${s.id}`)))).status).toBe(200);
  expect(bridge.chats.has(s.id)).toBe(false);
});

test("no response body ever contains the bridge token", () => {
  for (const text of seen) expect(text).not.toContain(bridge.token);
});

async function gateRun(): Promise<{ s: any; sent: any }> {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("GATE please"))));
  for (let i = 0; i < 400 && S.getSession(ctx.db, s.id)!.runState !== "needs_approval"; i++) await new Promise((r) => setTimeout(r, 5));
  return { s, sent: sent.body };
}

test("a Pi approval puts the session in needs_approval and the event carries id and options", async () => {
  const { s, sent } = await gateRun();
  expect(S.getSession(ctx.db, s.id)!.runState).toBe("needs_approval");
  const rd = (await run(req("GET", `/api/chat/runs/${sent.runId}/events`))).body!.getReader();
  let seen = "";
  for (let i = 0; i < 20 && !seen.includes("event: approval"); i++) seen += new TextDecoder().decode((await rd.read()).value);
  await rd.cancel();
  const data = seen.split("\n").find((l, i, a) => a[i - 1] === "event: approval" && l.startsWith("data:"))!;
  expect(JSON.parse(data.slice(5))).toMatchObject({ id: "ui-1", options: ["approve", "deny"], note: "Allow command?" });
  await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "ui-1", choice: "deny" })));
  await waitIdle(s.id);
});

test("POST /runs/:id/approval approve: tool runs, state goes back to running, the run completes", async () => {
  const { s, sent } = await gateRun();
  const r = await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "ui-1", choice: "approve" })));
  expect(r).toEqual({ status: 200, body: { ok: true } });
  expect(bridge.uiResponses).toEqual([{ id: "ui-1", confirmed: true }]);
  await waitIdle(s.id);
  const m = S.getMessage(ctx.db, sent.assistantMessage.id)!;
  expect(m.status).toBe("complete");
  expect(m.tools[0]).toMatchObject({ name: "bash", status: "ok" });
});

test("POST /runs/:id/approval deny: the tool is recorded failed and the run still completes", async () => {
  const { s, sent } = await gateRun();
  await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "ui-1", choice: "deny" })));
  await waitIdle(s.id);
  const m = S.getMessage(ctx.db, sent.assistantMessage.id)!;
  expect(m.status).toBe("complete");
  expect(m.tools[0]).toMatchObject({ name: "bash", status: "failed" });
});

test("POST /runs/:id/approval rejects a bad choice, a wrong id and a finished run", async () => {
  const { s, sent } = await gateRun();
  expect((await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "ui-1", choice: "maybe" })))).status).toBe(400);
  expect((await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { choice: "approve" })))).status).toBe(400);
  expect((await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "other", choice: "approve" })))).status).toBe(409);
  expect(bridge.uiResponses).toEqual([]);
  await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "ui-1", choice: "approve" })));
  await waitIdle(s.id);
  expect((await js(await run(req("POST", `/api/chat/runs/${sent.runId}/approval`, { id: "ui-1", choice: "approve" })))).status).toBe(409);
});

test("approval on a Hermes run is refused (Hermes approvals stay read-only)", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", {})));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("hello"))));
  const r = await js(await run(req("POST", `/api/chat/runs/${sent.body.runId}/approval`, { id: "x", choice: "approve" })));
  expect(r.status).toBe(409);
  await waitIdle(s.id);
});

test("a Pi todo_write is streamed as a todo event and persisted on the assistant message", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("TODO please"))));
  await waitIdle(s.id);
  const want = [{ id: "1", content: "step one", status: "completed" as const }, { id: "2", content: "step two", status: "in_progress" as const }];
  expect(S.getMessage(ctx.db, sent.body.assistantMessage.id)!.todos).toEqual(want);
  const msgs = await js(await run(req("GET", `/api/chat/sessions/${s.id}/messages`)));
  expect(msgs.body.messages.find((m: any) => m.role === "assistant").todos).toEqual(want);
  const ev = ctx.db.query("SELECT data FROM chat_run_events WHERE run_id = ? AND type = 'todo'").all(sent.body.runId) as { data: string }[];
  expect(ev.map((e) => JSON.parse(e.data))).toEqual([{ todos: want }]);
});

test("a message without todos reports todos: null (also for old rows)", async () => {
  const { body: s } = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("hello"))));
  await waitIdle(s.id);
  expect(S.getMessage(ctx.db, sent.body.assistantMessage.id)!.todos).toBeNull();
});

const PI_URL = (id: string) => `/api/chat/sessions/${id}/pi-settings`;
async function piSession(): Promise<any> {
  return (await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })))).body;
}
const lastStart = () => bridge.requests.filter((r) => r.method === "POST" && r.path.endsWith("/start")).at(-1)!.body;

test("GET pi-settings returns defaults plus the model's thinking levels", async () => {
  const s = await piSession();
  const r = await js(await run(req("GET", PI_URL(s.id))));
  expect(r.status).toBe(200);
  expect(r.body).toEqual({
    settings: { tools: null, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompaction: true, autoRetry: true },
    thinkingLevels: ["off", "low", "high"],
  });
});

test("PATCH pi-settings merges partial updates, persists them and returns the full settings", async () => {
  const s = await piSession();
  await js(await run(req("PATCH", PI_URL(s.id), { steeringMode: "all" })));
  const r = await js(await run(req("PATCH", PI_URL(s.id), { autoRetry: false })));
  expect(r.status).toBe(200);
  expect(r.body.settings).toEqual({ tools: null, steeringMode: "all", followUpMode: "one-at-a-time", autoCompaction: true, autoRetry: false });
  expect(JSON.parse(S.getPiSettings(ctx.db, s.id) ? JSON.stringify(S.getPiSettings(ctx.db, s.id)) : "{}")).toEqual({ steeringMode: "all", autoRetry: false });
  expect((await js(await run(req("GET", PI_URL(s.id))))).body.settings.steeringMode).toBe("all");
});

test("PATCH pi-settings rejects unknown keys, bad values and empty bodies; nothing is stored", async () => {
  const s = await piSession();
  for (const body of [{ bash: true }, { steeringMode: "sometimes" }, { autoRetry: "no" }, { followUpMode: 3 }, {}]) {
    expect((await js(await run(req("PATCH", PI_URL(s.id), body)))).status).toBe(400);
  }
  expect(S.getPiSettings(ctx.db, s.id)).toEqual({});
});

test("pi-settings on a Hermes chat is 400", async () => {
  const { body: h } = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect((await js(await run(req("GET", PI_URL(h.id))))).status).toBe(400);
  expect((await js(await run(req("PATCH", PI_URL(h.id), { autoRetry: false })))).status).toBe(400);
});

test("pi-settings on an unknown chat is 404", async () => {
  expect((await js(await run(req("GET", PI_URL("nope"))))).status).toBe(404);
});

test("PATCH pi-settings during a run is 409 and changes nothing", async () => {
  const s = await piSession();
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("SLOW please"))));
  const r = await js(await run(req("PATCH", PI_URL(s.id), { autoRetry: false })));
  expect(r).toEqual({ status: 409, body: { error: "run active" } });
  expect(S.getPiSettings(ctx.db, s.id)).toEqual({});
  await js(await run(req("POST", `/api/chat/runs/${sent.body.runId}/stop`)));
  await waitIdle(s.id);
});

test("the next send carries the stored settings and the chat's effort to the bridge", async () => {
  const s = await piSession();
  await js(await run(req("PATCH", PI_URL(s.id), { steeringMode: "all", autoCompaction: false })));
  await js(await run(req("PATCH", `/api/chat/sessions/${s.id}`, { effort: "high" })));
  await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("hello"))));
  await waitIdle(s.id);
  expect(lastStart()).toMatchObject({ thinking: "high", settings: { steeringMode: "all", autoCompaction: false } });
});

test("POST pi-compact compacts and returns the numbers; 409 mid-run; 400 on Hermes", async () => {
  const s = await piSession();
  const r = await js(await run(req("POST", `/api/chat/sessions/${s.id}/pi-compact`, {})));
  expect(r).toEqual({ status: 200, body: { tokensBefore: 1000, tokensAfter: 200 } });
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("SLOW please"))));
  expect((await js(await run(req("POST", `/api/chat/sessions/${s.id}/pi-compact`, {})))).status).toBe(409);
  await js(await run(req("POST", `/api/chat/runs/${sent.body.runId}/stop`)));
  await waitIdle(s.id);
  const { body: h } = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect((await js(await run(req("POST", `/api/chat/sessions/${h.id}/pi-compact`, {})))).status).toBe(400);
});

test("no pi-settings response ever contains the bridge token", async () => {
  const s = await piSession();
  await js(await run(req("PATCH", PI_URL(s.id), { autoRetry: false })));
  await js(await run(req("GET", PI_URL(s.id))));
  expect(seen.some((t) => t.includes(bridge.token))).toBe(false);
});

test("GET/PUT /pi-config go to the bridge and come back; the token never shows", async () => {
  const g = await js(await run(req("GET", "/api/chat/pi-config")));
  expect(g.status).toBe(200);
  expect(g.body).toMatchObject({ appendSystemPrompt: "", agentsMd: "", defaultTools: null, gate: { extraProtectedPaths: [], extraRisky: [] } });
  const p = await js(await run(req("PUT", "/api/chat/pi-config", { appendSystemPrompt: "Be brief.", defaultTools: ["read"] })));
  expect(p.status).toBe(200);
  expect(p.body).toMatchObject({ appendSystemPrompt: "Be brief.", defaultTools: ["read"] });
  expect((await js(await run(req("GET", "/api/chat/pi-config")))).body.appendSystemPrompt).toBe("Be brief.");
  expect(JSON.stringify([g, p])).not.toContain(bridge.token);
});

test("PUT /pi-config: a bridge validation error comes back as 400 with its message, not 502", async () => {
  const r = await js(await run(req("PUT", "/api/chat/pi-config", { defaultTools: ["rm"] })));
  expect(r.status).toBe(400);
  expect(r.body.error).toContain("unknown tool");
});

test("pi-config is 503 when no bridge is configured", async () => {
  ctx = { ...ctx, pi: undefined };
  expect((await js(await run(req("GET", "/api/chat/pi-config")))).status).toBe(503);
});

test("per-chat tools: PATCH stores them, null clears them, and every send carries them to the bridge", async () => {
  const s = await piSession();
  const r = await js(await run(req("PATCH", PI_URL(s.id), { tools: ["read", "grep"] })));
  expect(r.body.settings.tools).toEqual(["read", "grep"]);
  await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("hello"))));
  await waitIdle(s.id);
  expect(lastStart()).toMatchObject({ settings: { tools: ["read", "grep"] } });
  const cleared = await js(await run(req("PATCH", PI_URL(s.id), { tools: null })));
  expect(cleared.body.settings.tools).toBeNull();
  expect(S.getPiSettings(ctx.db, s.id)).toEqual({});
});

test("per-chat tools: unknown, duplicate and empty lists are 400", async () => {
  const s = await piSession();
  for (const tools of [["nope"], ["read", "read"], [], "read"]) {
    expect((await js(await run(req("PATCH", PI_URL(s.id), { tools })))).status).toBe(400);
  }
});

test("send on a Pi chat accepts a model id that only Pi knows (the web always sends the model)", async () => {
  const s = await piSession();
  const f = fd("hello"); f.set("model", "deepseek-flash");
  const sent = await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, f)));
  expect(sent.status).toBe(201);
  await waitIdle(s.id);
  expect(S.getSession(ctx.db, s.id)!.model).toBe("deepseek-flash"); // a model sent with the message becomes the chat's model
});

test("PATCH model on a Pi chat resolves against Pi's models; a Hermes-only model is 400", async () => {
  const s = await piSession();
  const ok = await js(await run(req("PATCH", `/api/chat/sessions/${s.id}`, { model: "deepseek-flash" })));
  expect(ok.status).toBe(200);
  expect(ok.body).toMatchObject({ model: "deepseek-flash", provider: "deepseek", backend: "pi" });
  const bad = await js(await run(req("PATCH", `/api/chat/sessions/${s.id}`, { model: "claude-sonnet-5-5" })));
  expect(bad.status).toBe(400);
});

test("PATCH model on a Hermes chat with a Pi-only model is 400", async () => {
  const { body: h } = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect((await js(await run(req("PATCH", `/api/chat/sessions/${h.id}`, { model: "deepseek-flash-pi-only" })))).status).toBe(400);
});

test("clearing a chat's tools override is sent to the bridge as tools:null on the next run", async () => {
  const s = await piSession();
  await js(await run(req("PATCH", PI_URL(s.id), { tools: ["read"] })));
  await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("one"))));
  await waitIdle(s.id);
  expect(lastStart().settings.tools).toEqual(["read"]);
  await js(await run(req("PATCH", PI_URL(s.id), { tools: null })));
  await js(await run(req("POST", `/api/chat/sessions/${s.id}/send`, fd("two"))));
  await waitIdle(s.id);
  expect(lastStart().settings.tools).toBeNull();
});

test("one chat's settings never leak into another chat: each run sends that chat's full settings", async () => {
  const a = await piSession(), b = await piSession();
  await js(await run(req("PATCH", PI_URL(a.id), { steeringMode: "all", autoRetry: false })));
  await js(await run(req("POST", `/api/chat/sessions/${a.id}/send`, fd("one"))));
  await waitIdle(a.id);
  await js(await run(req("POST", `/api/chat/sessions/${b.id}/send`, fd("two"))));
  await waitIdle(b.id);
  expect(lastStart().settings).toEqual({ tools: null, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompaction: true, autoRetry: true });
});
