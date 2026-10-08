import { test, expect } from "bun:test";
import { createChat, parseSse, SESSION_ID } from "./chat";

type Call = { url: string; method: string; headers: Record<string, string>; body: any };

// Fake Hermes upstream: records every call and answers with a canned response.
function fakeUpstream(respond: (c: Call) => Response = () => Response.json({ ok: true })) {
  const calls: Call[] = [];
  const f = (async (input: any, init: any = {}) => {
    const h = new Headers(init.headers ?? {});
    const c: Call = {
      url: String(input),
      method: init.method ?? "GET",
      headers: Object.fromEntries(h.entries()),
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(c);
    return respond(c);
  }) as unknown as typeof fetch;
  return { f, calls };
}
const chatWith = (f: typeof fetch, key = "k-test") => createChat({ baseUrl: "http://hermes.test", key, fetch: f });
const req = (path: string, init: RequestInit = {}) => new Request("http://cc.test" + path, init);

test("parseSse splits events and keeps an unfinished tail for the next chunk", () => {
  const a = parseSse("", 'event: assistant.delta\ndata: {"delta":"po');
  expect(a.events).toEqual([]);
  const b = parseSse(a.rest, 'ng"}\n\nevent: run.completed\ndata: {"completed":true}\n\n');
  expect(b.events).toEqual([
    { event: "assistant.delta", data: { delta: "pong" } },
    { event: "run.completed", data: { completed: true } },
  ]);
  expect(b.rest).toBe("");
});

test("parseSse tolerates a non-JSON data line by keeping the raw text", () => {
  const r = parseSse("", "event: done\ndata: not-json\n\n");
  expect(r.events).toEqual([{ event: "done", data: "not-json" }]);
});

test("session ids are restricted to safe characters so they cannot rewrite the upstream path", () => {
  expect(SESSION_ID.test("api_1791428903_856f1412")).toBe(true);
  expect(SESSION_ID.test("20261008_100909_791f4bb4")).toBe(true);
  expect(SESSION_ID.test("../../etc")).toBe(false);
  expect(SESSION_ID.test("a/b")).toBe(false);
  expect(SESSION_ID.test("")).toBe(false);
});

test("list sessions forwards the bearer key and returns the upstream JSON", async () => {
  const { f, calls } = fakeUpstream(() => Response.json({ object: "list", data: [{ id: "s1" }] }));
  const res = await chatWith(f).handle(req("/api/chat/sessions"), "/api/chat/sessions");
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ object: "list", data: [{ id: "s1" }] });
  expect(calls[0].url).toBe("http://hermes.test/api/sessions?limit=100&include_children=false");
  expect(calls[0].headers.authorization).toBe("Bearer k-test");
});

test("create session returns the new id at the top level", async () => {
  const { f, calls } = fakeUpstream(() => Response.json({ object: "hermes.session", session: { id: "s2", title: "Plan" } }, { status: 201 }));
  const res = await chatWith(f).handle(req("/api/chat/sessions", { method: "POST", body: JSON.stringify({ title: "Plan" }) }), "/api/chat/sessions");
  expect(res.status).toBe(201);
  expect(calls[0].method).toBe("POST");
  expect(calls[0].url).toBe("http://hermes.test/api/sessions");
  expect(calls[0].body).toEqual({ title: "Plan" });
  expect(await res.json()).toMatchObject({ id: "s2", title: "Plan" });
});

test("messages, rename and delete hit the matching upstream session routes", async () => {
  const { f, calls } = fakeUpstream();
  const c = chatWith(f);
  await c.handle(req("/api/chat/sessions/s1/messages"), "/api/chat/sessions/s1/messages");
  await c.handle(req("/api/chat/sessions/s1", { method: "PATCH", body: JSON.stringify({ title: "Renamed" }) }), "/api/chat/sessions/s1");
  await c.handle(req("/api/chat/sessions/s1", { method: "DELETE" }), "/api/chat/sessions/s1");
  expect(calls.map(x => `${x.method} ${x.url}`)).toEqual([
    "GET http://hermes.test/api/sessions/s1/messages?inline_images=false",
    "PATCH http://hermes.test/api/sessions/s1",
    "DELETE http://hermes.test/api/sessions/s1",
  ]);
  expect(calls[1].body).toEqual({ title: "Renamed" });
});

test("a turn is streamed: the upstream SSE body passes through as text/event-stream", async () => {
  const sse = 'event: run.completed\ndata: {"completed":true}\n\n';
  const { f, calls } = fakeUpstream(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  const res = await chatWith(f).handle(req("/api/chat/sessions/s1/stream", { method: "POST", body: JSON.stringify({ input: "hi" }) }), "/api/chat/sessions/s1/stream");
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  expect(await res.text()).toBe(sse);
  expect(calls[0].url).toBe("http://hermes.test/api/sessions/s1/chat/stream");
  expect(calls[0].body).toEqual({ input: "hi" });
});

test("empty or oversized input is rejected before reaching Hermes", async () => {
  const { f, calls } = fakeUpstream();
  const c = chatWith(f);
  const empty = await c.handle(req("/api/chat/sessions/s1/stream", { method: "POST", body: JSON.stringify({ input: "   " }) }), "/api/chat/sessions/s1/stream");
  const huge = await c.handle(req("/api/chat/sessions/s1/stream", { method: "POST", body: JSON.stringify({ input: "x".repeat(20001) }) }), "/api/chat/sessions/s1/stream");
  expect(empty.status).toBe(400);
  expect(huge.status).toBe(400);
  expect(calls.length).toBe(0);
});

test("a bad session id is a 400 and never reaches Hermes", async () => {
  const { f, calls } = fakeUpstream();
  const res = await chatWith(f).handle(req("/api/chat/sessions/..%2Fx/messages"), "/api/chat/sessions/../x/messages");
  expect(res.status).toBe(400);
  expect(calls.length).toBe(0);
});

test("missing Hermes key is a 503 with a clear error, not an upstream call", async () => {
  const { f, calls } = fakeUpstream();
  const res = await chatWith(f, "").handle(req("/api/chat/sessions"), "/api/chat/sessions");
  expect(res.status).toBe(503);
  expect((await res.json()).error).toMatch(/HERMES_API_KEY/);
  expect(calls.length).toBe(0);
});

test("an unreachable Hermes is a 502 with the error text", async () => {
  const f = (async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:8642"); }) as unknown as typeof fetch;
  const res = await chatWith(f).handle(req("/api/chat/sessions"), "/api/chat/sessions");
  expect(res.status).toBe(502);
  expect((await res.json()).error).toMatch(/ECONNREFUSED/);
});

test("model options are fetched from Hermes with the bearer key", async () => {
  const { f, calls } = fakeUpstream(() => Response.json({ providers: [] }));
  const res = await chatWith(f).handle(req("/api/chat/model-options"), "/api/chat/model-options");
  expect(res.status).toBe(200);
  expect(calls[0].url).toBe("http://hermes.test/api/model/options");
  expect(calls[0].headers.authorization).toBe("Bearer k-test");
});

test("setting a session model posts provider and model to the matching Hermes lock route", async () => {
  const { f, calls } = fakeUpstream(() => Response.json({ object: "hermes.session.model_lock" }));
  const res = await chatWith(f).handle(
    req("/api/chat/sessions/s1/model", { method: "POST", body: JSON.stringify({ provider: "nous", model: "anthropic/claude-haiku-5.5" }) }),
    "/api/chat/sessions/s1/model");
  expect(res.status).toBe(200);
  expect(calls[0].url).toBe("http://hermes.test/api/sessions/s1/model");
  expect(calls[0].method).toBe("POST");
  expect(calls[0].body).toEqual({ provider: "nous", model: "anthropic/claude-haiku-5.5" });
});

test("a session model call without a model is rejected before reaching Hermes", async () => {
  const { f, calls } = fakeUpstream();
  const res = await chatWith(f).handle(
    req("/api/chat/sessions/s1/model", { method: "POST", body: JSON.stringify({ provider: "nous" }) }),
    "/api/chat/sessions/s1/model");
  expect(res.status).toBe(400);
  expect(calls.length).toBe(0);
});

test("a turn forwards the chosen reasoning effort as model_options", async () => {
  const sse = 'event: run.completed\ndata: {"completed":true}\n\n';
  const { f, calls } = fakeUpstream(() => new Response(sse, { headers: { "content-type": "text/event-stream" } }));
  await chatWith(f).handle(
    req("/api/chat/sessions/s1/stream", { method: "POST", body: JSON.stringify({ input: "hi", model_options: { reasoning: { enabled: true, effort: "high" } } }) }),
    "/api/chat/sessions/s1/stream");
  expect(calls[0].body).toEqual({ input: "hi", model_options: { reasoning: { enabled: true, effort: "high" } } });
});

test("a turn without model_options sends only the input", async () => {
  const { f, calls } = fakeUpstream(() => new Response("", { headers: { "content-type": "text/event-stream" } }));
  await chatWith(f).handle(req("/api/chat/sessions/s1/stream", { method: "POST", body: JSON.stringify({ input: "hi" }) }), "/api/chat/sessions/s1/stream");
  expect(calls[0].body).toEqual({ input: "hi" });
});

test("unknown reasoning effort is dropped before reaching Hermes", async () => {
  const { f, calls } = fakeUpstream(() => new Response("", { headers: { "content-type": "text/event-stream" } }));
  await chatWith(f).handle(req("/api/chat/sessions/s1/stream", { method: "POST", body: JSON.stringify({ input: "hi", model_options: { reasoning: { effort: "turbo" } } }) }), "/api/chat/sessions/s1/stream");
  expect(calls[0].body).toEqual({ input: "hi" });
});

test("unknown chat sub-route is a 404", async () => {
  const { f } = fakeUpstream();
  const res = await chatWith(f).handle(req("/api/chat/nope"), "/api/chat/nope");
  expect(res.status).toBe(404);
});
