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
