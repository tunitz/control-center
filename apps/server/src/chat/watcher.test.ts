import { test, expect, beforeEach } from "bun:test";
import { openDb } from "../db";
import { createChatContext, runsOf, type ChatContext } from "./routes";
import { FakeHermes } from "./fake-hermes";
import { AWAIT_TIMEOUT_MS } from "./runs";
import { parseCompletions } from "./hermes";
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
  expect(parseCompletions(rows)).toEqual([{ id: 7, ts: 1791694264.83 }]);
});
