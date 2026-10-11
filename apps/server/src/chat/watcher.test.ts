import { test, expect, beforeEach } from "bun:test";
import { openDb } from "../db";
import { createChatContext, runsOf, type ChatContext } from "./routes";
import { FakeHermes } from "./fake-hermes";
import { AWAIT_TIMEOUT_MS } from "./runs";
import { parseCompletions, parseDispatches } from "./hermes";
import * as S from "./store";

let ctx: ChatContext;
let fake: FakeHermes;
let t = 1_000_000;
const events: { event: string; data: any }[] = [];

beforeEach(() => {
  t = 1_000_000;
  events.length = 0;
  const db = openDb(":memory:");
  ctx = createChatContext(db, { env: { CHAT_FAKE_HERMES: "1" }, emit: (event, data) => events.push({ event, data }) });
  ctx.now = () => t;
  fake = ctx.hermes as FakeHermes;
  S.createSession(db, { id: "s1", model: "deepseek-v4-flash", provider: "deepseek", effort: null, now: t });
});

async function turn(text: string) {
  const runs = runsOf(ctx);
  runs.reserve("s1");
  const r = runs.begin("s1", { text, message: text, attachments: [], model: "deepseek-v4-flash", effort: null });
  await runs.waitDone(r.runId);
  return r;
}

test("a turn that dispatches a subagent leaves the session awaiting", async () => {
  await turn("run delegate");
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(1);
  const last = events.filter(e => e.event === "chat.run").pop()!;
  expect(last.data).toMatchObject({ sessionId: "s1", state: "idle", awaiting: 1 });
});

test("a plain turn does not await anything", async () => {
  await turn("hi");
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
});

test("no completion yet: the watcher does nothing", async () => {
  await turn("run delegate");
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.runState).toBe("idle");
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(1);
});

test("a completion starts one internal turn that reports it, with no stored user message", async () => {
  await turn("run delegate");
  const before = S.listAllMessages(ctx.db, "s1").length;
  fake.addCompletion("s1", t / 1000 + 5);
  await ctx.watcher!.tick();
  const s = S.getSession(ctx.db, "s1")!;
  expect(s.runState).toBe("running");
  expect(s.awaiting).toBe(0);
  await runsOf(ctx).waitDone(s.runId!);
  const msgs = S.listAllMessages(ctx.db, "s1");
  expect(msgs.length).toBe(before + 1);
  expect(msgs.at(-1)).toMatchObject({ role: "assistant", text: "Hello world", status: "complete" });
  expect(msgs.filter(m => m.role === "user").length).toBe(1);
});

test("the same completion is never reported twice", async () => {
  await turn("run delegate");
  fake.addCompletion("s1", t / 1000 + 5);
  await ctx.watcher!.tick();
  await runsOf(ctx).waitDone(S.getSession(ctx.db, "s1")!.runId!);
  S.addAwaiting(ctx.db, "s1", 1, t, t + AWAIT_TIMEOUT_MS); // a second dispatch is pending
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.runState).toBe("idle");
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(1);
});

test("completions older than the dispatching turn are ignored", async () => {
  await turn("run delegate");
  fake.addCompletion("s1", t / 1000 - 3600);
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.runState).toBe("idle");
});

test("a busy session is left alone and reported once it is free", async () => {
  await turn("run delegate");
  fake.addCompletion("s1", t / 1000 + 5);
  const runs = runsOf(ctx);
  runs.reserve("s1"); // the user is sending something
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(1);
  runs.release("s1");
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
  expect(S.getSession(ctx.db, "s1")!.runState).toBe("running");
});

test("the wait is dropped after the timeout", async () => {
  await turn("run delegate");
  t += AWAIT_TIMEOUT_MS + 1;
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
  const last = events.filter(e => e.event === "chat.run").pop()!;
  expect(last.data.awaiting).toBe(0);
});

test("parseCompletions keeps only async_delegation_complete rows", () => {
  const rows = [
    { id: 5, display_kind: null, timestamp: 1 },
    { id: "7", display_kind: "async_delegation_complete", timestamp: 1791694264.83 },
    { id: 9, display_kind: "async_delegation_complete" },
  ];
  expect(parseCompletions(rows)).toEqual([{ id: 7, ts: 1791694264.83, delegationId: null }]);
});

const dtool = (id: number, ts: number, content: object) => ({ id, role: "tool", tool_name: "delegate_task", timestamp: ts, content: JSON.stringify(content) });

test("parseCompletions reads the delegation id from the row text; parseDispatches only takes dispatch results", () => {
  const rows = [
    { id: 1, display_kind: "async_delegation_complete", timestamp: 5, content: "[ASYNC DELEGATION BATCH COMPLETE — deleg_ab12]\nbody" },
    dtool(2, 4, { status: "dispatched", mode: "background", count: 2, delegation_id: "deleg_ab12" }),
    dtool(3, 4, { status: "dispatched", mode: "background", count: 2, delegation_id: "deleg_ab12" }), // transcript copy
    dtool(4, 4, { action: "steer", subagent_id: "sa-0", status: "queued" }),
  ];
  expect(parseCompletions(rows)[0]!.delegationId).toBe("deleg_ab12");
  expect(parseDispatches(rows)).toEqual([{ delegationId: "deleg_ab12", ts: 4 }]);
});

test("one batch of two tasks is ONE report and clears the indicator (no phantom second subagent)", async () => {
  await turn("run delegate two");   // two delegate_task calls in one turn
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(2);
  fake.addDispatch("s1", "deleg_1", t / 1000 + 1);
  fake.addCompletion("s1", t / 1000 + 5, "deleg_1");
  await ctx.watcher!.tick();
  await runsOf(ctx).waitDone(S.getSession(ctx.db, "s1")!.runId!);
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
});

test("two separate batches: indicator drops to 1 after the first, 0 after the second", async () => {
  await turn("run delegate two");
  fake.addDispatch("s1", "deleg_1", t / 1000 + 1);
  fake.addDispatch("s1", "deleg_2", t / 1000 + 1);
  fake.addCompletion("s1", t / 1000 + 5, "deleg_1");
  await ctx.watcher!.tick();
  await runsOf(ctx).waitDone(S.getSession(ctx.db, "s1")!.runId!);
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(1);
  fake.addCompletion("s1", t / 1000 + 9, "deleg_2");
  await ctx.watcher!.tick();
  await runsOf(ctx).waitDone(S.getSession(ctx.db, "s1")!.runId!);
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
});

test("a steer/list call on delegate_task is not a dispatch", async () => {
  await turn("run delegate steer");
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
});

test("a wait with no dispatch row after the grace period is dropped, not stuck for 30 minutes", async () => {
  await turn("run delegate");
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(1);
  t += 31_000;
  await ctx.watcher!.tick();
  expect(S.getSession(ctx.db, "s1")!.awaiting).toBe(0);
});

test("the client asks Hermes for compacted rows too (a compacted completion must not leave a phantom subagent)", async () => {
  const urls: string[] = [];
  const srv = Bun.serve({ port: 0, fetch: req => { urls.push(req.url); return Response.json({ data: [] }); } });
  try {
    const { HttpHermes } = await import("./hermes");
    await new HttpHermes({ baseUrl: `http://127.0.0.1:${srv.port}`, apiKey: "k" }).delegations("s1");
    expect(urls[0]).toContain("include_compacted=true");
  } finally { srv.stop(true); }
});
