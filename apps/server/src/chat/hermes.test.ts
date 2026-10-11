import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { parseFrame, newParseState, sseEvents, HttpHermes, type HermesFrame } from "./hermes";
import { ChatError } from "./http";

/* ---------- fixtures ---------- */

type Fixture = { endpoint: string; event: string; data: any };

const FIXTURES: Fixture[] = readFileSync(new URL("./fixtures/chat-fixtures.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(l => l.trim() !== "")
  .map(l => JSON.parse(l) as Fixture);

// Split the captured lines into the three runs (each begins at run.started), dropping the stop response.
function capturedRuns(): Fixture[][] {
  const out: Fixture[][] = [];
  for (const f of FIXTURES) {
    if (f.endpoint.startsWith("/v1/")) continue;
    if (f.event === "run.started") out.push([]);
    out[out.length - 1].push(f);
  }
  return out;
}

const [PLAIN, TOOL, STOPPED] = capturedRuns();

function replay(fs: Fixture[]): HermesFrame[] {
  const st = newParseState();
  const out: HermesFrame[] = [];
  for (const f of fs) {
    const fr = parseFrame(f.event, f.data, st);
    if (fr) out.push(fr);
  }
  return out;
}

/* ---------- (1) parseFrame / status mapping on captured runs ---------- */

describe("captured fixtures", () => {
  test("file holds 24 frames: three runs (7+9+7) plus one stop_response", () => {
    expect(FIXTURES.length).toBe(24);
    expect(capturedRuns().map(r => r.length)).toEqual([7, 9, 7]);
    expect(FIXTURES[23].event).toBe("stop_response");
  });

  test("plain run maps to deltas, reasoning, usage and status complete", () => {
    expect(replay(PLAIN)).toEqual([
      {
        type: "run.started",
        runId: "run_fb75d6c7157143c8832bbf90e25fa685",
        sessionId: "api_1791683732_af09f650",
        assistantMessageId: "",
        model: "claude-haiku-5-5",
      },
      { type: "delta", text: "PLAIN_OK" },
      { type: "reasoning", text: "PLAIN_OK" },
      { type: "usage", input: 22960, output: 10 },
      { type: "done", status: "complete", error: null, model: "claude-haiku-5-5" },
    ]);
  });

  test("tool-call run pairs tool.started/tool.completed and reports complete", () => {
    expect(replay(TOOL)).toEqual([
      {
        type: "run.started",
        runId: "run_32316742e5154d2992932473e967c15b",
        sessionId: "api_1791683735_0eb26319",
        assistantMessageId: "",
        model: "claude-haiku-5-5",
      },
      { type: "tool.started", id: "t1", name: "terminal", args: { command: "echo hi" }, preview: "echo hi" },
      { type: "tool.completed", id: "t1", ok: true, durationMs: 80, preview: null },
      { type: "delta", text: "\n\nhi" },
      { type: "reasoning", text: "hi" },
      { type: "usage", input: 46160, output: 109 },
      { type: "done", status: "complete", error: null, model: "claude-haiku-5-5" },
    ]);
  });

  test("stopped run: interrupted flag + run.cancelled give status interrupted; tool.failed gives ok:false", () => {
    expect(replay(STOPPED)).toEqual([
      {
        type: "run.started",
        runId: "run_446eed9c46924eaf8fd38c8296085dbb",
        sessionId: "api_1791683739_d868565e",
        assistantMessageId: "",
        model: "claude-haiku-5-5",
      },
      {
        type: "tool.started",
        id: "t1",
        name: "terminal",
        args: { command: "for i in $(seq 1 40); do echo COUNT $i; sleep 1; done", timeout: 120 },
        preview: "for i in $(seq 1 40) + 3 commands",
      },
      { type: "tool.completed", id: "t1", ok: false, durationMs: 3295, preview: null },
      { type: "done", status: "interrupted", error: null, model: "claude-haiku-5-5" },
    ]);
  });

  test("stop_response and message.started are not mapped to frames", () => {
    expect(parseFrame("stop_response", FIXTURES[23].data, newParseState())).toBeNull();
    expect(parseFrame("message.started", PLAIN[1].data, newParseState())).toBeNull();
  });
});

describe("parseFrame status and tool edge cases", () => {
  test("run.failed yields status failed with the error message", () => {
    const st = newParseState();
    expect(parseFrame("run.failed", { message: "model overloaded" }, st)).toBeNull();
    expect(parseFrame("done", {}, st)).toEqual({ type: "done", status: "failed", error: "model overloaded", model: null });
  });

  test("error event with only error field is failed; failed beats interrupted", () => {
    const st = newParseState();
    parseFrame("run.cancelled", {}, st);
    parseFrame("error", { error: "boom" }, st);
    expect(parseFrame("done", {}, st)).toEqual({ type: "done", status: "failed", error: "boom", model: null });
  });

  test("tool.failed with no open call gets a fresh id and null duration", () => {
    const st = newParseState();
    expect(parseFrame("tool.failed", { tool_name: "terminal" }, st)).toEqual({
      type: "tool.completed", id: "t1", ok: false, durationMs: null, preview: null,
    });
  });

  test("tool.completed matches open calls by name, FIFO", () => {
    const st = newParseState();
    parseFrame("tool.started", { tool_name: "a", ts: 1 }, st);
    parseFrame("tool.started", { tool_name: "b", ts: 2 }, st);
    parseFrame("tool.started", { tool_name: "a", ts: 3 }, st);
    const first = parseFrame("tool.completed", { tool_name: "a", ts: 1.5 }, st);
    expect(first).toMatchObject({ type: "tool.completed", id: "t1", ok: true, durationMs: 500 });
    const second = parseFrame("tool.completed", { tool_name: "a", ts: 4 }, st);
    expect(second).toMatchObject({ type: "tool.completed", id: "t3" });
  });
});

/* ---------- (2) _thinking reasoning mapping ---------- */

describe("tool.progress reasoning", () => {
  test("_thinking delta maps to reasoning", () => {
    expect(parseFrame("tool.progress", { tool_name: "_thinking", delta: "considering" }, newParseState()))
      .toEqual({ type: "reasoning", text: "considering" });
  });

  test("other tool.progress names and empty deltas map to null", () => {
    expect(parseFrame("tool.progress", { tool_name: "terminal", delta: "x" }, newParseState())).toBeNull();
    expect(parseFrame("tool.progress", { tool_name: "_thinking", delta: "" }, newParseState())).toBeNull();
    expect(parseFrame("tool.progress", { tool_name: "_thinking" }, newParseState())).toBeNull();
  });
});

/* ---------- (4) approval.request ---------- */

describe("approval.request", () => {
  test("maps to an approval frame with the command", () => {
    expect(parseFrame("approval.request", { command: "rm -rf /tmp/x", choices: ["once", "deny"] }, newParseState()))
      .toEqual({ type: "approval", command: "rm -rf /tmp/x", note: "needs approval in Hermes" });
  });

  test("missing command maps to null command", () => {
    expect(parseFrame("approval.request", {}, newParseState()))
      .toEqual({ type: "approval", command: null, note: "needs approval in Hermes" });
  });
});

/* ---------- (3) sseEvents ---------- */

const enc = new TextEncoder();

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });
}

async function collectSse(chunks: Uint8Array[]): Promise<{ event: string; data: unknown }[]> {
  const out: { event: string; data: unknown }[] = [];
  for await (const e of sseEvents(streamOf(chunks))) out.push(e);
  return out;
}

const SSE_TEXT =
  ": keepalive\n\n" +
  "event: run.started\ndata: {\"run_id\":\"r1\"}\n\n" +
  ": keepalive\n\n" +
  "event: assistant.delta\ndata: {\"delta\":\"caf\u00e9 \u2603\"}\n\n" +
  "event: multi\ndata: {\"a\":\ndata: 1}\n\n" +
  "event: bad\ndata: {not json\n\n" +
  "event: done\ndata: {}\n\n";

const EXPECTED_EVENTS = [
  { event: "run.started", data: { run_id: "r1" } },
  { event: "assistant.delta", data: { delta: "caf\u00e9 \u2603" } },
  { event: "multi", data: { a: 1 } },
  { event: "done", data: {} },
];

describe("sseEvents", () => {
  test("whole buffer parses; comments and invalid JSON are skipped; multi-line data joined", async () => {
    expect(await collectSse([enc.encode(SSE_TEXT)])).toEqual(EXPECTED_EVENTS);
  });

  test("every two-way byte split gives the same events (mid-line, mid-event, mid multi-byte char)", async () => {
    const bytes = enc.encode(SSE_TEXT);
    for (let k = 0; k <= bytes.length; k++) {
      const got = await collectSse([bytes.slice(0, k), bytes.slice(k)]);
      expect(got).toEqual(EXPECTED_EVENTS);
    }
  });

  test("one byte per chunk gives the same events", async () => {
    const bytes = enc.encode(SSE_TEXT);
    const chunks = Array.from(bytes, b => new Uint8Array([b]));
    expect(await collectSse(chunks)).toEqual(EXPECTED_EVENTS);
  });

  test("captured fixture bytes, split at arbitrary offsets, replay identically", async () => {
    const text = FIXTURES.map(f => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
    const bytes = enc.encode(text);
    const expected = FIXTURES.map(f => ({ event: f.event, data: f.data }));
    for (const k of [1, 7, 100, 333, bytes.length - 1]) {
      expect(await collectSse([bytes.slice(0, k), bytes.slice(k)])).toEqual(expected);
    }
  });

  test("CRLF line endings parse the same, including a CRLF split across chunks", async () => {
    const text = "event: a\r\ndata: {\"x\":1}\r\n\r\nevent: b\r\ndata: {}\r\n\r\n";
    const bytes = enc.encode(text);
    const expected = [{ event: "a", data: { x: 1 } }, { event: "b", data: {} }];
    for (let k = 0; k <= bytes.length; k++) {
      expect(await collectSse([bytes.slice(0, k), bytes.slice(k)])).toEqual(expected);
    }
  });

  test("a keepalive comment inside an event block does not swallow the event", async () => {
    const got = await collectSse([enc.encode(": keepalive\nevent: x\ndata: {\"ok\":true}\n\n")]);
    expect(got).toEqual([{ event: "x", data: { ok: true } }]);
  });
});

/* ---------- (5) HttpHermes against a fake server ---------- */

const KEY = "sk-test-KEYVALUE-9f3a7c2e";

type Rec = { method: string; path: string; auth: string | null; body: any; raw: string };
const log: Rec[] = [];
let server: ReturnType<typeof Bun.serve>;
let base: string;

const sseBody = (fs: Fixture[]) =>
  fs.map(f => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");

const APPROVAL_FRAMES: Fixture[] = [
  PLAIN[0],
  PLAIN[1],
  { endpoint: PLAIN[1].endpoint, event: "approval.request", data: { command: "rm -rf /tmp/x", choices: ["once", "deny"] } },
  ...PLAIN.slice(2),
];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const raw = req.method === "POST" ? await req.text() : "";
      let body: any = undefined;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { /* keep undefined */ }
      log.push({ method: req.method, path: url.pathname, auth: req.headers.get("authorization"), body, raw });
      const p = url.pathname;
      const sse = (fs: Fixture[]) => new Response(sseBody(fs), { headers: { "content-type": "text/event-stream" } });
      if (p === "/api/sessions" && req.method === "POST") return Response.json({ session: { id: "sess_1" } }, { status: 201 });
      if (p === "/api/sessions/sess_1/model") return Response.json({ ok: true });
      if (p === "/api/sessions/sess_1/chat/stream") return sse(PLAIN);
      if (p === "/api/sessions/sess_appr/chat/stream") return sse(APPROVAL_FRAMES);
      if (p === "/api/sessions/sess_empty/chat/stream") return new Response(": keepalive\n\n", { headers: { "content-type": "text/event-stream" } });
      if (p === "/api/sessions/sess_err/chat/stream") return new Response("internal boom", { status: 500 });
      if (p === "/v1/runs/run_abc/stop") return Response.json({ status: "stopping" });
      if (p === "/v1/runs/run_done/steer") return new Response("{}", { status: 409 });
      if (p === "/v1/runs/run_missing/stop") return new Response("{}", { status: 404 });
      if (p === "/v1/runs/run_500/stop") return new Response("x", { status: 500 });
      return new Response("not found", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const client = () => new HttpHermes({ baseUrl: base + "/", apiKey: KEY });
const last = () => log[log.length - 1];

async function expectNoKey(p: Promise<unknown>): Promise<ChatError> {
  let err: unknown;
  try { await p; } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ChatError);
  expect((err as Error).message).not.toContain(KEY);
  return err as ChatError;
}

describe("HttpHermes", () => {
  test("every request carries the Bearer key", async () => {
    await client().createSession();
    expect(last().auth).toBe(`Bearer ${KEY}`);
    await client().stopRun("run_abc");
    expect(last().auth).toBe(`Bearer ${KEY}`);
  });

  test("baseUrl trailing slashes are stripped", async () => {
    await new HttpHermes({ baseUrl: base + "///", apiKey: KEY }).stopRun("run_abc");
    expect(last().path).toBe("/v1/runs/run_abc/stop");
  });

  test("createSession posts {source:'api_server'} and returns the session id", async () => {
    const id = await client().createSession();
    expect(id).toBe("sess_1");
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/api/sessions");
    expect(last().body).toEqual({ source: "api_server" });
  });

  test("lockModel posts model and provider to /api/sessions/{id}/model", async () => {
    await client().lockModel("sess_1", "claude-haiku-5-5", "anthropic");
    expect(last().path).toBe("/api/sessions/sess_1/model");
    expect(last().body).toEqual({ model: "claude-haiku-5-5", provider: "anthropic" });
  });

  test("startRun body has no model field, even when args.model is set", async () => {
    const { runId, frames } = await client().startRun({
      sessionId: "sess_1", message: "hi", model: "claude-haiku-5-5",
    });
    expect(runId).toBe("run_fb75d6c7157143c8832bbf90e25fa685");
    const sent = log.find(r => r.path === "/api/sessions/sess_1/chat/stream")!;
    expect(sent.body).toEqual({ message: "hi" });
    expect(sent.raw).not.toContain("model");
    const types: string[] = [];
    for await (const f of frames) types.push(f.type);
    expect(types[types.length - 1]).toBe("done");
  });

  test("startRun sends effort 'off' as reasoning disabled with effort none", async () => {
    await client().startRun({ sessionId: "sess_1", message: "hi", model: "m", effort: "off" });
    const sent = log.filter(r => r.path === "/api/sessions/sess_1/chat/stream").at(-1)!;
    expect(sent.body.model_options).toEqual({ reasoning: { enabled: false, effort: "none" } });
  });

  test("stopRun posts to /v1/runs/{id}/stop", async () => {
    await client().stopRun("run_abc");
    expect(last().method).toBe("POST");
    expect(last().path).toBe("/v1/runs/run_abc/stop");
  });

  test("steerRun maps 409 to ChatError 409 'run finished'", async () => {
    const err = await expectNoKey(client().steerRun("run_done", "change course"));
    expect(err.status).toBe(409);
    expect(err.message).toBe("run finished");
  });

  test("non-2xx on the chat stream surfaces as a ChatError, without the key", async () => {
    const err = await expectNoKey(client().startRun({ sessionId: "sess_err", message: "x", model: "m" }));
    expect(err.status).toBe(502);
    expect(err.message).toBe("hermes stream failed (500)");
  });

  test("non-2xx on stop surfaces as a ChatError, without the key", async () => {
    const err = await expectNoKey(client().stopRun("run_500"));
    expect(err.status).toBe(502);
  });

  test("stream that ends before run.started is an error", async () => {
    const err = await expectNoKey(client().startRun({ sessionId: "sess_empty", message: "x", model: "m" }));
    expect(err.message).toBe("hermes stream ended before run.started");
  });

  test("approval.request in the stream does not hang the frame iterator", async () => {
    const { frames } = await client().startRun({ sessionId: "sess_appr", message: "x", model: "m" });
    const collected = (async () => {
      const out: HermesFrame[] = [];
      for await (const f of frames) out.push(f);
      return out;
    })();
    const out = await Promise.race([
      collected,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("iterator hung")), 2000)),
    ]);
    expect(out).toContainEqual({ type: "approval", command: "rm -rf /tmp/x", note: "needs approval in Hermes" });
    expect(out[out.length - 1]).toEqual({ type: "done", status: "complete", error: null, model: "claude-haiku-5-5" });
  });

  test("unreachable hermes gives 502 'hermes unreachable' without the key", async () => {
    const dead = new HttpHermes({ baseUrl: "http://127.0.0.1:1", apiKey: KEY });
    const err = await expectNoKey(dead.createSession());
    expect(err.status).toBe(502);
    expect(err.message).toBe("hermes unreachable");
  });

  test("auth-bearing failure messages never contain the key", async () => {
    const errs = [
      await expectNoKey(client().steerRun("run_missing", "x")),
      await expectNoKey(client().stopRun("run_500")),
      await expectNoKey(client().startRun({ sessionId: "sess_err", message: "x", model: "m" })),
    ];
    for (const e of errs) expect(e.message).not.toContain(KEY);
  });
});

describe("run.completed usage", () => {
  test("keeps Hermes cache read/write tokens next to input and output", () => {
    const st = newParseState();
    expect(parseFrame("run.completed", { usage: { input_tokens: 100, output_tokens: 7, total_tokens: 9100, cache_read_tokens: 8000, cache_write_tokens: 1000 } }, st))
      .toEqual({ type: "usage", input: 100, output: 7, cacheRead: 8000, cacheWrite: 1000 });
  });
  test("without cache counters the frame stays input/output only", () => {
    expect(parseFrame("run.completed", { usage: { input_tokens: 5, output_tokens: 1 } }, newParseState()))
      .toEqual({ type: "usage", input: 5, output: 1 });
  });
});
