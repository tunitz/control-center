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
let home: string;

beforeEach(() => {
  fake = new FakeHermes();
  bridge = FakePiBridge.start();
  home = bridge.home;
  const pi = new PiClient({ baseUrl: bridge.url, token: bridge.token });
  ctx = {
    db: openDb(":memory:"), hermes: fake, pi,
    uploadRoot: resolve(mkdtempSync(join(tmpdir(), "chat-pi-dirs-"))), now: () => 1_000_000,
  };
});
afterEach(async () => {
  await bridge.close();
});

const run = (r: Request) => handleChat(r, new URL(r.url), ctx);
const req = (method: string, p: string, body?: unknown, xcc = true) => {
  const h: Record<string, string> = {};
  if (method !== "GET" && xcc) h["x-cc"] = "1";
  let b: BodyInit | undefined;
  if (body !== undefined) { b = JSON.stringify(body); h["content-type"] = "application/json"; }
  return new Request("http://cc.local" + p, { method, headers: h, body: b });
};
async function js(r: Response): Promise<{ status: number; body: any }> {
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}
async function dirs(path?: string) {
  const q = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return js(await run(req("GET", `/api/chat/pi/dirs${q}`)));
}
async function mkdir(parent: string, name: string) {
  return js(await run(req("POST", "/api/chat/pi/dirs", { parent, name })));
}
const names = (b: { entries: { name: string }[] }) => b.entries.map((e) => e.name);

test("GET /api/chat/pi/dirs lists the bridge's HOME subdirectories", async () => {
  const r = await dirs();
  expect(r.status).toBe(200);
  expect(r.body.path).toBe(home);
  expect(r.body.parent).toBeNull();
  expect(names(r.body)).toEqual(["Beta", "gamma", "projects"]);
});

test("GET /api/chat/pi/dirs?path= lists a child with its parent", async () => {
  const r = await dirs(join(home, "projects"));
  expect(r.status).toBe(200);
  expect(r.body.parent).toBe(home);
  expect(names(r.body)).toEqual(["alpha", "control-center"]);
});

test("GET /api/chat/pi/dirs passes the bridge's 400 message through (not 502)", async () => {
  const r = await dirs("/etc");
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/outside HOME/);
});

test("POST /api/chat/pi/dirs creates a folder; 409 and 400 keep their status and message", async () => {
  const made = await mkdir(home, "fresh");
  expect(made.status).toBe(201);
  expect(made.body).toEqual({ path: join(home, "fresh"), name: "fresh" });
  const dup = await mkdir(home, "fresh");
  expect(dup.status).toBe(409);
  expect(dup.body.error).toMatch(/already exists/);
  const bad = await mkdir(home, "a/b");
  expect(bad.status).toBe(400);
  expect(bad.body.error).toMatch(/\//);
});

test("POST /api/chat/pi/dirs needs the x-cc header, like the other chat writes", async () => {
  const r = await js(await run(req("POST", "/api/chat/pi/dirs", { parent: home, name: "nope" }, false)));
  expect(r.status).toBe(403);
});

test("the dirs routes answer 503 when Pi is not configured", async () => {
  const noPi: ChatContext = { ...ctx, pi: undefined };
  const url = "http://cc.local/api/chat/pi/dirs";
  const g = await js(await handleChat(req("GET", "/api/chat/pi/dirs"), new URL(url), noPi));
  expect(g.status).toBe(503);
  const p = await js(await handleChat(req("POST", "/api/chat/pi/dirs", { parent: home, name: "x" }), new URL(url), noPi));
  expect(p.status).toBe(503);
});

test("POST /sessions {backend:'pi', cwd} starts the chat in that directory and stores it", async () => {
  const dir = join(home, "projects", "alpha");
  const r = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro", cwd: dir })));
  expect(r.status).toBe(201);
  expect(r.body.cwd).toBe(dir);
  expect(bridge.chats.get(r.body.id)!.cwd).toBe(dir);
  expect(S.getSession(ctx.db, r.body.id)!.cwd).toBe(dir);
  const listed = await js(await run(req("GET", "/api/chat/sessions")));
  expect(listed.body.find((s: any) => s.id === r.body.id).cwd).toBe(dir);
});

test("a pi chat without cwd and a hermes chat report cwd null", async () => {
  const pi = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  expect(pi.body.cwd).toBeNull();
  expect(bridge.chats.get(pi.body.id)!.cwd).toBeNull();
  const h = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect(h.body.cwd).toBeNull();
});

test("cwd on a hermes session is 400", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", { cwd: home })));
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/pi/);
});

test("cwd must be a string", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro", cwd: 7 })));
  expect(r.status).toBe(400);
  expect(bridge.chats.size).toBe(0);
});

test("an invalid cwd is the bridge's 400 and nothing is stored", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro", cwd: "/etc" })));
  expect(r.status).toBe(400);
  expect(r.body.error).toMatch(/outside HOME/);
  expect(bridge.chats.size).toBe(0);
  expect(S.listSessions(ctx.db)).toEqual([]);
});

test("a reaped chat resumes in its chosen cwd: every bridge start carries cwd", async () => {
  const dir = join(home, "Beta");
  const s = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro", cwd: dir })));
  bridge.chats.delete(s.body.id); // the bridge reaps the idle process
  const sendForm = (text: string) => { const f = new FormData(); f.set("text", text); return f; };
  const sent = await js(await run(new Request(`http://cc.local/api/chat/sessions/${s.body.id}/send`, { method: "POST", headers: { "x-cc": "1" }, body: sendForm("hello") })));
  expect(sent.status).toBe(201);
  const starts = bridge.requests.filter((r) => r.path === `/chats/${s.body.id}/start`);
  expect(starts.length).toBeGreaterThan(1);
  for (const st of starts) expect(st.body.cwd).toBe(dir);
  // The session's cwd stays on the stored row even after the bridge let the process go.
  expect(S.getSession(ctx.db, s.body.id)!.cwd).toBe(dir);
});

test("a default-workspace pi chat never sends cwd to the bridge", async () => {
  const s = await js(await run(req("POST", "/api/chat/sessions", { backend: "pi", model: "deepseek-pro" })));
  await js(await run(new Request(`http://cc.local/api/chat/sessions/${s.body.id}/send`, { method: "POST", headers: { "x-cc": "1" }, body: (() => { const f = new FormData(); f.set("text", "hello"); return f; })() })));
  const starts = bridge.requests.filter((r) => r.path === `/chats/${s.body.id}/start`);
  expect(starts.length).toBeGreaterThan(0);
  for (const st of starts) expect(st.body.cwd).toBeUndefined();
});
