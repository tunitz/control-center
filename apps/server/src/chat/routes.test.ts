import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDb } from "../db";
import { handleChat, createChatContext, type ChatContext } from "./routes";
import { FakeHermes } from "./fake-hermes";
import * as S from "./store";

let ctx: ChatContext;
let fake: FakeHermes;
let root: string;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 128, 0, 0, 0, 64, 8, 6, 0, 0, 0]);
const SMALL_PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 10, 0, 0, 0, 10, 8, 6, 0, 0, 0]);

beforeEach(() => {
  fake = new FakeHermes();
  root = resolve(mkdtempSync(join(tmpdir(), "chat-routes-")));
  ctx = { db: openDb(":memory:"), hermes: fake, uploadRoot: root, now: () => 1_000_000 };
});

const url = (p: string) => new URL("http://cc.local" + p);
const req = (method: string, p: string, opts: { body?: unknown; cc?: boolean; headers?: Record<string, string> } = {}) => {
  const h: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cc !== false && method !== "GET") h["x-cc"] = "1";
  let body: BodyInit | undefined;
  if (opts.body instanceof FormData) body = opts.body;
  else if (opts.body !== undefined) { body = JSON.stringify(opts.body); h["content-type"] = "application/json"; }
  return new Request("http://cc.local" + p, { method, headers: h, body });
};
const run = (r: Request) => handleChat(r, url(r.url.replace("http://cc.local", "")), ctx);
const js = async (r: Response) => ({ status: r.status, body: await r.json() as any });

const seed = (id: string, extra: Partial<{ archived: boolean }> = {}) => {
  S.createSession(ctx.db, { id, model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
  if (extra.archived) S.updateSession(ctx.db, id, { archived: true }, 2);
};

test("GET /models and /config need no x-cc and return contract shapes", async () => {
  const m = await js(await run(req("GET", "/api/chat/models")));
  expect(m.status).toBe(200);
  expect(m.body.map((x: any) => x.id)).toContain("claude-sonnet-5-5");
  const c = await js(await run(req("GET", "/api/chat/config")));
  expect(c.body).toMatchObject({ defaultModel: "claude-sonnet-5-5", defaultEffort: null, maxUploadMb: 20, contextWindow: { "local-llama": 32768 } });
});

test("x-cc is enforced on every non-GET route (403)", async () => {
  seed("s1");
  const cases: [string, string][] = [["POST", "/api/chat/sessions"], ["PATCH", "/api/chat/sessions/s1"], ["DELETE", "/api/chat/sessions/s1"],
    ["POST", "/api/chat/sessions/s1/send"], ["POST", "/api/chat/runs/r1/stop"], ["POST", "/api/chat/runs/r1/steer"]];
  for (const [m, p] of cases) {
    const r = await js(await run(req(m, p, { cc: false, body: {} })));
    expect(r.status).toBe(403);
    expect(typeof r.body.error).toBe("string");
  }
});

test("POST /sessions creates the Hermes session, locks model, mirrors row", async () => {
  const r = await js(await run(req("POST", "/api/chat/sessions", { body: { model: "deepseek-v4-pro", effort: "low" } })));
  expect(r.status).toBe(201);
  expect(r.body).toMatchObject({ id: "fake-1", model: "deepseek-v4-pro", provider: "deepseek", effort: "low", title: "New chat", titleAuto: true, runState: "idle" });
  expect(fake.locks).toEqual([{ id: "fake-1", model: "deepseek-v4-pro", provider: "deepseek" }]);
  const d = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect(d.body.model).toBe("claude-sonnet-5-5");
});

test("POST /sessions rejects unknown model, bad effort, bad JSON; a lock failure rolls back the Hermes session", async () => {
  expect((await js(await run(req("POST", "/api/chat/sessions", { body: { model: "nope" } })))).status).toBe(400);
  expect((await js(await run(req("POST", "/api/chat/sessions", { body: { effort: "max" } })))).status).toBe(400);
  const bad = new Request("http://cc.local/api/chat/sessions", { method: "POST", headers: { "x-cc": "1", "content-type": "application/json" }, body: "{oops" });
  expect((await js(await run(bad))).status).toBe(400);
  fake.lockFails = true;
  const r = await js(await run(req("POST", "/api/chat/sessions", {})));
  expect(r.status).toBe(502);
  expect(fake.sessions.size).toBe(0);
  expect((ctx.db.query("SELECT count(*) c FROM chat_sessions").get() as any).c).toBe(0);
});

test("GET /sessions lists, filters archived, and searches with snippet", async () => {
  seed("s1"); seed("s2", { archived: true });
  S.insertMessage(ctx.db, { id: "m1", sessionId: "s1", seq: 1, role: "user", text: "buy pineapple", createdAt: 1, status: "complete", attachments: [] });
  expect((await js(await run(req("GET", "/api/chat/sessions")))).body.map((s: any) => s.id)).toEqual(["s1"]);
  expect((await js(await run(req("GET", "/api/chat/sessions?archived=1")))).body.map((s: any) => s.id)).toEqual(["s2"]);
  const q = (await js(await run(req("GET", "/api/chat/sessions?q=pineapple&archived=0")))).body;
  expect(q).toHaveLength(1);
  expect(q[0].snippet).toContain("pineapple");
});

test("PATCH sets title (titleAuto false), pinned, archived, effort; validates", async () => {
  seed("s1");
  const r = await js(await run(req("PATCH", "/api/chat/sessions/s1", { body: { title: "  Trip  ", pinned: true, effort: "high" } })));
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ title: "Trip", titleAuto: false, pinned: true, effort: "high" });
  expect((await js(await run(req("PATCH", "/api/chat/sessions/s1", { body: { title: "   " } })))).status).toBe(400);
  expect((await js(await run(req("PATCH", "/api/chat/sessions/s1", { body: { model: "nope" } })))).status).toBe(400);
  expect((await js(await run(req("PATCH", "/api/chat/sessions/s1", { body: { pinned: "yes" } })))).status).toBe(400);
  expect((await js(await run(req("PATCH", "/api/chat/sessions/zzz", { body: { pinned: true } })))).status).toBe(404);
  const m = await js(await run(req("PATCH", "/api/chat/sessions/s1", { body: { model: "gpt-6-luna" } })));
  expect(m.body).toMatchObject({ model: "gpt-6-luna", provider: "openai-codex" });
  expect(fake.locks).toEqual([]); // model is locked in Hermes only at the next send
});

test("DELETE: 409 'run active' while running; otherwise Hermes delete, mirror rows and files removed", async () => {
  seed("s1");
  ctx.db.query("UPDATE chat_sessions SET run_state='running', run_id='r1' WHERE id='s1'").run();
  expect(await js(await run(req("DELETE", "/api/chat/sessions/s1")))).toEqual({ status: 409, body: { error: "run active" } });
  ctx.db.query("UPDATE chat_sessions SET run_state='idle', run_id=NULL WHERE id='s1'").run();
  const sid = await fake.createSession(); // a real Hermes session id for the delete path
  seed(sid);
  S.insertMessage(ctx.db, { id: "m1", sessionId: sid, seq: 1, role: "user", text: "pic", createdAt: 1, status: "complete", attachments: [] });
  const dir = join(root, sid); await Bun.write(join(dir, "f.bin"), "x");
  expect(existsSync(dir)).toBe(true);
  expect(await js(await run(req("DELETE", `/api/chat/sessions/${sid}`)))).toEqual({ status: 200, body: { ok: true } });
  expect(fake.deleted).toEqual([sid]);
  expect(existsSync(dir)).toBe(false);
  expect((await js(await run(req("DELETE", `/api/chat/sessions/${sid}`)))).status).toBe(404);
});

test("GET messages: newest page, before paging, 404 unknown, 400 bad before", async () => {
  seed("s1");
  for (let i = 1; i <= 3; i++) S.insertMessage(ctx.db, { id: `m${i}`, sessionId: "s1", seq: i, role: "user", text: `t${i}`, createdAt: i, status: "complete", attachments: [] });
  const newest = (await js(await run(req("GET", "/api/chat/sessions/s1/messages?limit=2")))).body;
  expect(newest.messages.map((m: any) => m.seq)).toEqual([2, 3]);
  expect(newest.hasMore).toBe(true);
  const older = (await js(await run(req("GET", "/api/chat/sessions/s1/messages?before=2&limit=2")))).body;
  expect(older.messages.map((m: any) => m.seq)).toEqual([1]);
  expect((await js(await run(req("GET", "/api/chat/sessions/nope/messages")))).status).toBe(404);
  expect((await js(await run(req("GET", "/api/chat/sessions/s1/messages?before=abc")))).status).toBe(400);
});

test("GET files: image inline with type, file as attachment octet-stream, 404 for unknown or out-of-root paths", async () => {
  seed("s1");
  const imgPath = join(root, "s1", "0123456789abcdef0123456789abcdef.png");
  await Bun.write(imgPath, PNG);
  const filePath = join(root, "s1", "0123456789abcdef0123456789abcdef.txt");
  await Bun.write(filePath, "hi");
  S.insertMessage(ctx.db, { id: "m1", sessionId: "s1", seq: 1, role: "user", text: "x", createdAt: 1, status: "complete", attachments: [
    { id: "img1", kind: "image", name: "p.png", mime: "image/png", size: PNG.length, sha256: "h", path: imgPath, w: 128, h: 64 },
    { id: "fil1", kind: "file", name: "资料 notes.txt", mime: "text/plain", size: 2, sha256: "h", path: filePath, w: null, h: null },
    { id: "evil", kind: "file", name: "e", mime: "text/plain", size: 2, sha256: "h", path: "/etc/hostname", w: null, h: null },
  ] });
  const i = await run(req("GET", "/api/chat/files/img1"));
  expect(i.status).toBe(200);
  expect(i.headers.get("content-type")).toBe("image/png");
  expect(i.headers.get("x-content-type-options")).toBe("nosniff");
  expect(i.headers.get("cache-control")).toBe("private, max-age=3600");
  const f = await run(req("GET", "/api/chat/files/fil1"));
  expect(f.headers.get("content-type")).toBe("application/octet-stream");
  expect(f.headers.get("content-disposition")).toMatch(/^attachment/);
  expect(await f.text()).toBe("hi");
  expect((await run(req("GET", "/api/chat/files/evil"))).status).toBe(404);
  expect((await run(req("GET", "/api/chat/files/none"))).status).toBe(404);
});

test("GET export returns markdown attachment", async () => {
  seed("s1");
  S.insertMessage(ctx.db, { id: "m1", sessionId: "s1", seq: 1, role: "assistant", text: "answer", createdAt: 1, status: "complete", attachments: [] });
  const r = await run(req("GET", "/api/chat/sessions/s1/export"));
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toContain("text/markdown");
  expect(r.headers.get("content-disposition")).toMatch(/^attachment; filename="[\x20-\x7e]+\.md"/);
  expect(await r.text()).toContain("answer");
  expect((await run(req("GET", "/api/chat/sessions/nope/export"))).status).toBe(404);
});

test("send: validation errors (400/404/409/413) before anything is stored", async () => {
  seed("s1");
  const fd = (text: string, files: File[] = [], extra: Record<string, string> = {}) => { const f = new FormData(); f.set("text", text); for (const x of files) f.append("files", x); for (const [k, v] of Object.entries(extra)) f.set(k, v); return f; };
  expect((await run(req("POST", "/api/chat/sessions/zzz/send", { body: fd("hi") }))).status).toBe(404);
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: fd("") })))).status).toBe(400);
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: fd("hi", [], { model: "nope" }) })))).status).toBe(400);
  const seven = Array.from({ length: 7 }, (_, i) => new File(["a"], `f${i}.txt`, { type: "text/plain" }));
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: fd("hi", seven) })))).status).toBe(400);
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: fd("hi", [new File([], "empty.txt")]) })))).status).toBe(400);
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: fd("look", [new File([SMALL_PNG], "tiny.png", { type: "image/png" })]) })))).body.error).toBe("image too small");
  const bigForm = fd("hi", [new File([new Uint8Array(26 * 1024 * 1024)], "huge.txt", { type: "text/plain" })]);
  expect((await run(req("POST", "/api/chat/sessions/s1/send", { body: bigForm }))).status).toBe(413);
  ctx.db.query("UPDATE chat_sessions SET run_state='running', run_id='r9' WHERE id='s1'").run();
  expect(await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: fd("hi") })))).toEqual({ status: 409, body: { error: "run active" } });
  expect(readdirSync(root).length).toBe(0);
});

/** Fake whose stream is held after run.started until `hold` is released, so stop/steer race-free. */
class HeldHermes extends FakeHermes {
  hold: Promise<void>;
  release!: () => void;
  constructor() {
    super();
    this.hold = new Promise<void>(r => (this.release = r));
  }
  override async startRun(args: Parameters<FakeHermes["startRun"]>[0]) {
    const r = await super.startRun(args);
    const it = r.frames[Symbol.asyncIterator]();
    const hold = this.hold;
    return {
      runId: r.runId,
      frames: (async function* () {
        yield (await it.next()).value!;
        await hold;
        while (true) {
          const n = await it.next();
          if (n.done) return;
          yield n.value;
        }
      })(),
    };
  }
}

const waitIdle = async (id: string) => {
  for (let i = 0; i < 500; i++) {
    if (S.getSession(ctx.db, id)!.runState === "idle") return;
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error("run did not finish");
};
test("send: 201 with runId and both messages; files stored; title and assistant reply persisted", async () => {
  seed("s1");
  const f = new FormData(); f.set("text", "what is this"); f.append("files", new File([PNG], "photo.jpg", { type: "image/jpeg" }));
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: f })));
  expect(r.status).toBe(201);
  expect(r.body.runId).toBeString();
  expect(r.body.userMessage).toMatchObject({ role: "user", text: "what is this", status: "complete" });
  expect(r.body.userMessage.attachments[0]).toMatchObject({ kind: "image", name: "photo.jpg", mime: "image/png", w: 128, h: 64 });
  expect(r.body.assistantMessage).toMatchObject({ role: "assistant", status: "running", runId: r.body.runId });
  expect(existsSync(join(root, "s1"))).toBe(true);
  await waitIdle("s1");
  const page = (await js(await run(req("GET", "/api/chat/sessions/s1/messages")))).body;
  expect(page.messages.at(-1)).toMatchObject({ role: "assistant", status: "complete", text: "Hello world", usage: { input: 10, output: 2 } });
  expect(S.getSession(ctx.db, "s1")).toMatchObject({ title: "what is this", titleAuto: true, runState: "idle", runId: null });
});

test("send: model differing from the locked model is locked in Hermes; same model is not", async () => {
  seed("s1");
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "a"); f.set("model", "deepseek-v4-pro"); return f; })() })))).status).toBe(201);
  await waitIdle("s1");
  expect(fake.locks).toEqual([{ id: "s1", model: "deepseek-v4-pro", provider: "deepseek" }]);
  expect(S.getSession(ctx.db, "s1")).toMatchObject({ model: "deepseek-v4-pro", provider: "deepseek" });
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "b"); return f; })() })))).status).toBe(201);
  await waitIdle("s1");
  expect(fake.locks.length).toBe(1);
});

test("send: a Hermes lock failure is 502, releases the run slot and writes no files", async () => {
  seed("s1");
  fake.lockFails = true;
  const f = new FormData(); f.set("text", "hi"); f.set("model", "deepseek-v4-pro"); f.append("files", new File(["abc"], "a.txt", { type: "text/plain" }));
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: f })));
  expect(r.status).toBe(502);
  expect(existsSync(join(root, "s1"))).toBe(false);
  expect(S.getSession(ctx.db, "s1")!.runState).toBe("idle");
  fake.lockFails = false;
  expect((await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const g = new FormData(); g.set("text", "again"); return g; })() })))).status).toBe(201);
  await waitIdle("s1");
});

test("send: two sends to one session -> second is 409 run active while the first is open", async () => {
  seed("s1");
  const h = new HeldHermes();
  ctx = { ...ctx, hermes: h };
  const first = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "one"); return f; })() })));
  expect(first.status).toBe(201);
  const second = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "two"); return f; })() })));
  expect(second).toEqual({ status: 409, body: { error: "run active" } });
  h.release();
  await waitIdle("s1");
});

test("events: SSE id/event/data lines, Last-Event-ID and ?last replay, ends after done", async () => {
  seed("s1");
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "hello"); return f; })() })));
  await waitIdle("s1");
  const res = await run(req("GET", `/api/chat/runs/${r.body.runId}/events`));
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await res.text();
  expect(text).toMatch(/^id: 1\nevent: run\.started\ndata: /m);
  expect(text).toContain("event: delta");
  expect(text.trimEnd().endsWith('data: {"status":"complete","error":null,"model":"claude-sonnet-5-5"}')).toBe(true);
  const hdr = await run(req("GET", `/api/chat/runs/${r.body.runId}/events`, { headers: { "last-event-id": "3" } }));
  const ids = [...(await hdr.text()).matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
  expect(ids[0]).toBe(4);
  const q = await run(req("GET", `/api/chat/runs/${r.body.runId}/events?last=2`));
  expect([...(await q.text()).matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))).toEqual([3, 4, 5]);
  expect((await js(await run(req("GET", "/api/chat/runs/nope/events")))).status).toBe(404);
});

test("events: a browser that leaves mid-run does not stop the run; a new attach replays and goes live", async () => {
  seed("s1");
  const h = new HeldHermes();
  ctx = { ...ctx, hermes: h };
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "hello"); return f; })() })));
  const res = await run(req("GET", `/api/chat/runs/${r.body.runId}/events`));
  const reader = res.body!.getReader();
  await reader.read();
  await reader.cancel();
  h.release();
  await waitIdle("s1");
  expect(S.getMessage(ctx.db, r.body.assistantMessage.id)).toMatchObject({ status: "complete", text: "Hello world" });
  const again = await (await run(req("GET", `/api/chat/runs/${r.body.runId}/events`, { headers: { "last-event-id": "1" } }))).text();
  expect(again).toContain("event: done");
});

test("stop: 200 ok, Hermes stopped, assistant message ends interrupted", async () => {
  seed("s1");
  const h = new HeldHermes();
  ctx = { ...ctx, hermes: h };
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "hello"); return f; })() })));
  const stop = await js(await run(req("POST", `/api/chat/runs/${r.body.runId}/stop`)));
  expect(stop).toEqual({ status: 200, body: { ok: true } });
  h.release();
  await waitIdle("s1");
  expect(S.getMessage(ctx.db, r.body.assistantMessage.id)!.status).toBe("interrupted");
  expect((await js(await run(req("POST", "/api/chat/runs/nope/stop")))).status).toBe(404);
});

test("steer: 200 forwarded to Hermes; 400 on empty message; 409 'run finished' after the run ends", async () => {
  seed("s1");
  const h = new HeldHermes();
  ctx = { ...ctx, hermes: h };
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "hello"); return f; })() })));
  expect((await js(await run(req("POST", `/api/chat/runs/${r.body.runId}/steer`, { body: { message: "  " } })))).status).toBe(400);
  const ok = await js(await run(req("POST", `/api/chat/runs/${r.body.runId}/steer`, { body: { message: "use pineapple" } })));
  expect(ok).toEqual({ status: 200, body: { ok: true } });
  expect(h.steered).toEqual([{ runId: expect.any(String), message: "use pineapple" }]);
  h.release();
  await waitIdle("s1");
  expect(await js(await run(req("POST", `/api/chat/runs/${r.body.runId}/steer`, { body: { message: "late" } })))).toEqual({ status: 409, body: { error: "run finished" } });
});

test("failure path: scripted failure ends message failed with error and the session idle", async () => {
  seed("s1");
  const r = await js(await run(req("POST", "/api/chat/sessions/s1/send", { body: (() => { const f = new FormData(); f.set("text", "please fail"); return f; })() })));
  await waitIdle("s1");
  const m = S.getMessage(ctx.db, r.body.assistantMessage.id)!;
  expect(m).toMatchObject({ status: "failed", error: "scripted failure" });
  const ev = await (await run(req("GET", `/api/chat/runs/${r.body.runId}/events`))).text();
  expect(ev).toContain('"status":"failed"');
});

test("unknown routes are 404", async () => {
  expect((await run(req("GET", "/api/chat/nope"))).status).toBe(404);
});

test("createChatContext: CHAT_FAKE_HERMES=1 selects FakeHermes; otherwise unconfigured client fails with 503", async () => {
  const db = openDb(":memory:");
  const fakeCtx = createChatContext(db, { env: { CHAT_FAKE_HERMES: "1", CHAT_UPLOAD_DIR: "/tmp/cu" } });
  expect(fakeCtx.hermes).toBeInstanceOf(FakeHermes);
  expect(fakeCtx.uploadRoot).toBe("/tmp/cu");
  const real = createChatContext(db, { env: {} });
  expect(real.hermes).not.toBeInstanceOf(FakeHermes);
  const r = await handleChat(req("POST", "/api/chat/sessions", {}), url("/api/chat/sessions"), real);
  expect(r.status).toBe(503);
  expect((await r.json() as any).error).toBeString();
});

test("GET /credits returns the host credits text, no model involved", async () => {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("DeepSeek $1.33", { headers: { "content-type": "text/plain" } }) });
  try {
    ctx.creditsUrl = `http://127.0.0.1:${srv.port}/credits`;
    const r = await handleChat(req("GET", "/api/chat/credits"), url("/api/chat/credits"), ctx);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ text: "DeepSeek $1.33" });
  } finally { srv.stop(true); }
});

test("GET /credits is 502 when the host endpoint is down or fails", async () => {
  ctx.creditsUrl = "http://127.0.0.1:1/credits";
  const r = await handleChat(req("GET", "/api/chat/credits"), url("/api/chat/credits"), ctx);
  expect(r.status).toBe(502);
  const bad = Bun.serve({ port: 0, fetch: () => new Response("no key", { status: 502 }) });
  try {
    ctx.creditsUrl = `http://127.0.0.1:${bad.port}/credits`;
    const r2 = await handleChat(req("GET", "/api/chat/credits"), url("/api/chat/credits"), ctx);
    expect(r2.status).toBe(502);
    expect((await r2.json()).error).toContain("no key");
  } finally { bad.stop(true); }
});
