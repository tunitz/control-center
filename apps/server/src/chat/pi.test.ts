import { test, expect, afterEach } from "bun:test";
import { FakePiBridge } from "./fake-pi-bridge";
import { friendlyPiError, PiClient } from "./pi";
import type { HermesFrame } from "./hermes";
import { ChatError } from "./http";

const bridges: FakePiBridge[] = [];
function bridge(opts: { token?: string } = {}): FakePiBridge {
  const b = FakePiBridge.start(opts);
  bridges.push(b);
  return b;
}
afterEach(async () => {
  while (bridges.length) await bridges.pop()!.close();
});

/** A URL nothing listens on: the bridge is down. */
async function deadUrl(): Promise<string> {
  const b = FakePiBridge.start();
  const url = b.url;
  await b.close();
  return url;
}

async function drain(frames: AsyncIterable<HermesFrame>): Promise<HermesFrame[]> {
  const out: HermesFrame[] = [];
  for await (const f of frames) out.push(f);
  return out;
}

async function untilDelta(it: AsyncIterator<HermesFrame>): Promise<void> {
  for (;;) {
    const n = await it.next();
    if (n.done || n.value.type === "delta") return;
  }
}

async function rest(it: AsyncIterator<HermesFrame>): Promise<HermesFrame[]> {
  const out: HermesFrame[] = [];
  for (;;) {
    const n = await it.next();
    if (n.done) return out;
    out.push(n.value);
  }
}

const RUN = { model: "deepseek-flash", provider: "deepseek", effort: null };

test("createSession starts a chat with a random UUID id; sessionRef is the bridge sessionFile", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(pi.sessionRef(id)).toBe(`/fake/sessions/${id}.jsonl`);
  expect(await pi.createSession()).not.toBe(id);
});

test("every bridge request carries the bearer token; the token never appears in returned values", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const before = b.requests.length;
  const id = await pi.createSession();
  await pi.lockModel(id, "deepseek-pro", "deepseek");
  expect(b.requests.slice(before).every((r) => r.auth === `Bearer ${b.token}`)).toBe(true);
  expect(JSON.stringify({ id, ref: pi.sessionRef(id) })).not.toContain(b.token);
});

test("a wrong token is refused as 502 and the error does not echo the token", async () => {
  const b = bridge();
  const bad = new PiClient({ baseUrl: b.url, token: "wrong-token-0123456789" });
  const err = await bad.createSession().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChatError);
  expect((err as ChatError).status).toBe(502);
  expect((err as Error).message).not.toContain("wrong-token");
  expect((err as Error).message).not.toContain(b.token);
});

test("deleteSession ends the live chat; deleting an already-gone chat is not an error", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  expect(b.chats.has(id)).toBe(true);
  await pi.deleteSession(id, pi.sessionRef(id));
  expect(b.chats.has(id)).toBe(false);
  await pi.deleteSession(id);
});

test("listModels maps Pi models to ChatModelDef and caches them for 60 s", async () => {
  const b = bridge();
  let clock = 1_000_000;
  const pi = new PiClient({ baseUrl: b.url, token: b.token, now: () => clock });
  const calls = b.modelsCalls;
  expect((await pi.listModels()).slice(0, 2)).toEqual([
    { id: "deepseek-flash", provider: "deepseek", label: "DeepSeek V4.1 Flash", reasoning: true, canDisableReasoning: true, vision: false, local: false, contextWindow: 1_000_000 },
    { id: "deepseek-pro", provider: "deepseek", label: "DeepSeek V4.1 Pro", reasoning: true, canDisableReasoning: true, vision: false, local: false },
  ]);
  expect(b.modelsCalls).toBe(calls + 1);
  clock += 59_000;
  await pi.listModels();
  expect(b.modelsCalls).toBe(calls + 1);
  clock += 2_000;
  await pi.listModels();
  expect(b.modelsCalls).toBe(calls + 2);
});

test("a failed listModels is not cached: the next call asks the bridge again", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  b.failModels = 1;
  await expect(pi.listModels()).rejects.toBeInstanceOf(ChatError);
  expect((await pi.listModels()).length).toBe(6);
});

test("lockModel applies set_model to the live chat; a refusal is 502", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  await pi.lockModel(id, "deepseek-pro", "deepseek");
  expect(b.chats.get(id)!.model).toEqual({ provider: "deepseek", modelId: "deepseek-pro" });
  const err = await pi.lockModel(id, "no-such-model", "deepseek").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChatError);
  expect((err as ChatError).status).toBe(502);
});

test("lockModel on a chat the bridge has reaped resumes it from the stored sessionFile", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const ref = pi.sessionRef(id)!;
  await pi.deleteSession(id);
  await pi.lockModel(id, "deepseek-pro", "deepseek", ref);
  expect(b.chats.get(id)!.model).toEqual({ provider: "deepseek", modelId: "deepseek-pro" });
  expect(b.chats.get(id)!.sessionFile).toBe(ref);
});

test("startRun on a reaped chat resumes from the stored sessionFile before prompting", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const ref = pi.sessionRef(id)!;
  await pi.deleteSession(id);
  const { frames } = await pi.startRun({ sessionId: id, message: "hi", ref, ...RUN });
  const start = b.requests.filter((r) => r.path === `/chats/${id}/start`).at(-1)!;
  expect(start.body).toMatchObject({ sessionPath: ref, model: { provider: "deepseek", modelId: "deepseek-flash" } });
  await drain(frames);
});

test("run to done: deltas stream in order and the run completes", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const { runId, frames } = await pi.startRun({ sessionId: id, message: "say hi", ...RUN });
  const out = await drain(frames);
  expect(out[0]).toEqual({ type: "run.started", runId, sessionId: id, assistantMessageId: "", model: "deepseek-flash" });
  expect(out.filter((f) => f.type === "delta").map((f) => (f as { text: string }).text).join("")).toBe("Hello world");
  expect(out.at(-1)).toEqual({ type: "done", status: "complete", error: null, model: "deepseek-flash" });
  expect(b.chats.get(id)!.prompts).toEqual(["say hi"]);
});

test("a second run on the same chat does not replay the first run's events", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  await drain((await pi.startRun({ sessionId: id, message: "one", ...RUN })).frames);
  const out = await drain((await pi.startRun({ sessionId: id, message: "two", ...RUN })).frames);
  expect(out.filter((f) => f.type === "done")).toHaveLength(1);
  expect(out.filter((f) => f.type === "delta").map((f) => (f as { text: string }).text).join("")).toBe("Hello world");
});

test("stopRun aborts a slow run: done is interrupted, not failed", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const { runId, frames } = await pi.startRun({ sessionId: id, message: "SLOW one", ...RUN });
  const it = frames[Symbol.asyncIterator]();
  await untilDelta(it);
  await pi.stopRun(runId);
  const tail = await rest(it);
  expect(tail.at(-1)).toEqual({ type: "done", status: "interrupted", error: null, model: "deepseek-flash" });
});

test("a run that settles with stopReason error is done failed with Pi's message", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const out = await drain((await pi.startRun({ sessionId: id, message: "ERR please", ...RUN })).frames);
  expect(out.at(-1)).toEqual({ type: "done", status: "failed", error: "boom: provider down", model: "deepseek-flash" });
});

test("steerRun reaches the live run", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const { runId, frames } = await pi.startRun({ sessionId: id, message: "SLOW steer", ...RUN });
  const it = frames[Symbol.asyncIterator]();
  await untilDelta(it);
  await pi.steerRun(runId, "use pineapple");
  expect(b.chats.get(id)!.steers).toEqual(["use pineapple"]);
  await pi.stopRun(runId);
  await rest(it);
});

test("steering an idle chat is a 502 from the bridge", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  await pi.lockModel(id, "deepseek-flash", "deepseek");
  const err = await pi.steerRun(id, "late").catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChatError);
  expect((err as ChatError).status).toBe(502);
});

test("the Pi process exiting mid-run ends the run failed", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const { runId, frames } = await pi.startRun({ sessionId: id, message: "SLOW crash", ...RUN });
  const it = frames[Symbol.asyncIterator]();
  await untilDelta(it);
  b.crash(id);
  const tail = await rest(it);
  expect(tail.at(-1)).toMatchObject({ type: "done", status: "failed" });
  expect(runId).toBeTruthy();
});

test("bridge down: calls fail with 502 and nothing leaks the token", async () => {
  const token = "dead-bridge-token-0123456789";
  const pi = new PiClient({ baseUrl: await deadUrl(), token });
  const err = await pi.createSession().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ChatError);
  expect((err as ChatError).status).toBe(502);
  expect((err as Error).message).not.toContain(token);
  expect(await pi.listModels().catch((e: unknown) => e)).toBeInstanceOf(ChatError);
});

test("a tool run maps to tool.started, tool.completed and usage frames", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const out = await drain((await pi.startRun({ sessionId: id, message: "TOOL please", ...RUN })).frames);
  const types = out.map((f) => f.type);
  expect(types.indexOf("tool.started")).toBeGreaterThan(-1);
  expect(types.indexOf("tool.completed")).toBeGreaterThan(types.indexOf("tool.started"));
  expect(out.find((f) => f.type === "tool.completed")).toMatchObject({ id: "call-1", ok: true, durationMs: 7 });
  expect(out.filter((f) => f.type === "usage").length).toBeGreaterThan(0);
  expect(out.at(-1)).toMatchObject({ type: "done", status: "complete" });
});

test("approval: the confirm becomes an approval frame; respondApproval(approve) lets the tool run", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const { runId, frames } = await pi.startRun({ sessionId: id, message: "GATE please", ...RUN });
  const it = frames[Symbol.asyncIterator]();
  let ap: HermesFrame | undefined;
  for (;;) { const n = await it.next(); if (n.done) break; if (n.value.type === "approval") { ap = n.value; break; } }
  expect(ap).toEqual({ type: "approval", id: "ui-1", command: "Run: echo hi > /tmp/x", note: "Allow command?", options: ["approve", "deny"] });
  await pi.respondApproval(runId, "ui-1", true);
  const tail = await rest(it);
  expect(b.uiResponses).toEqual([{ id: "ui-1", confirmed: true }]);
  expect(tail.find((f) => f.type === "tool.completed")).toMatchObject({ ok: true });
  expect(tail.at(-1)).toMatchObject({ type: "done", status: "complete" });
});

test("approval: deny blocks the tool (tool.completed ok:false) and the run still completes", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const { runId, frames } = await pi.startRun({ sessionId: id, message: "GATE please", ...RUN });
  const it = frames[Symbol.asyncIterator]();
  for (;;) { const n = await it.next(); if (n.done || n.value.type === "approval") break; }
  await pi.respondApproval(runId, "ui-1", false);
  const tail = await rest(it);
  expect(b.uiResponses).toEqual([{ id: "ui-1", confirmed: false }]);
  expect(tail.find((f) => f.type === "tool.completed")).toMatchObject({ ok: false, preview: "Blocked by cc-gate: not approved" });
});

test("respondApproval with nothing pending is a 502 from the bridge", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  await expect(pi.respondApproval(id, "nope", true)).rejects.toBeInstanceOf(ChatError);
});

const startBodies = (b: FakePiBridge) => b.requests.filter((r) => r.method === "POST" && r.path.endsWith("/start")).map((r) => r.body);

test("startRun sends the effort as thinking and the chat's stored settings with every start", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  await drain((await pi.startRun({
    sessionId: id, message: "hi", ...RUN, effort: "high", piSettings: { steeringMode: "all", autoRetry: false },
  })).frames);
  expect(startBodies(b).at(-1)).toMatchObject({ thinking: "high", settings: { steeringMode: "all", autoRetry: false, followUpMode: "one-at-a-time", autoCompaction: true } });
});

test("startRun with no effort and no stored settings sends no thinking, and names tools:null so a cleared override takes effect", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  await drain((await pi.startRun({ sessionId: id, message: "hi", ...RUN })).frames);
  const last = startBodies(b).at(-1);
  expect(last).not.toHaveProperty("thinking");
  expect(last).toMatchObject({ settings: { tools: null } });
  expect(startBodies(b).at(-1).settings).toEqual({ tools: null, steeringMode: "one-at-a-time", followUpMode: "one-at-a-time", autoCompaction: true, autoRetry: true });
});

test("compact starts the chat from its session file, compacts and returns Pi's numbers", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  const r = await pi.compact(id, pi.sessionRef(id), "focus on code");
  expect(r).toEqual({ tokensBefore: 1000, tokensAfter: 200 });
  expect(b.chats.get(id)!.compactions).toBe(1);
  const cmd = b.requests.filter((x) => x.path.endsWith("/command")).at(-1)!;
  expect(cmd.body).toMatchObject({ name: "compact", args: { customInstructions: "focus on code" } });
});

test("thinkingLevels returns the model's levels from the bridge", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const id = await pi.createSession();
  expect(await pi.thinkingLevels(id, pi.sessionRef(id), "deepseek-flash", "deepseek")).toEqual(["off", "low", "high"]);
});

test("listModels trims Anthropic to Opus/Sonnet/Haiku 5.5 and keeps every other provider Pi has a key for", async () => {
  const b = bridge();
  const pi = new PiClient({ baseUrl: b.url, token: b.token });
  const ids = (await pi.listModels()).map((m) => `${m.provider}/${m.id}`);
  expect(ids).toEqual([
    "deepseek/deepseek-flash", "deepseek/deepseek-pro",
    "anthropic/claude-opus-5-5", "anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5",
    "openai-codex/gpt-6-luna",
  ]);
});

test("friendlyPiError unwraps a provider error and explains the Anthropic subscription block", () => {
  // Plain strings are left alone (the fake bridge's "boom: provider down").
  expect(friendlyPiError("boom: provider down")).toBe("boom: provider down");
  // A JSON body is reduced to the provider's own message.
  expect(friendlyPiError('502 {"type":"error","error":{"message":"overloaded"}}')).toBe("overloaded");
  // The Anthropic third-party restriction gets a concrete next step, not raw JSON.
  const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."},"request_id":"req_1"}';
  const msg = friendlyPiError(raw);
  expect(msg).toContain("claude.ai/settings/usage");
  expect(msg).toContain("/login");
  expect(msg).not.toContain("{");
});
