import { test, expect } from "bun:test";
import { FakeHermes } from "./fake-hermes";
import type { HermesFrame } from "./hermes";
import { ChatError } from "./http";

const collect = async (it: AsyncIterable<HermesFrame>) => { const out: HermesFrame[] = []; for await (const f of it) out.push(f); return out; };

test("createSession ids are deterministic and lockModel is recorded", async () => {
  const h = new FakeHermes();
  expect(await h.createSession()).toBe("fake-1");
  expect(await h.createSession()).toBe("fake-2");
  await h.lockModel("fake-1", "claude-sonnet-5-5", "anthropic");
  expect(h.locks).toEqual([{ id: "fake-1", model: "claude-sonnet-5-5", provider: "anthropic" }]);
  await h.deleteSession("fake-2");
  expect(h.sessions.has("fake-2")).toBe(false);
});

test("default script streams started, deltas, usage, complete done", async () => {
  const h = new FakeHermes();
  const sid = await h.createSession();
  const { runId, frames } = await h.startRun({ sessionId: sid, message: "hello", model: "claude-sonnet-5-5" });
  const out = await collect(frames);
  expect(out[0]).toMatchObject({ type: "run.started", runId, sessionId: sid, model: "claude-sonnet-5-5" });
  expect(out.filter(f => f.type === "delta").map(f => (f as any).text).join("")).toBe("Hello world");
  expect(out.at(-2)).toMatchObject({ type: "usage" });
  expect(out.at(-1)).toMatchObject({ type: "done", status: "complete", error: null, model: "claude-sonnet-5-5" });
});

test("scripted markers: tool, think, fail, interrupt", async () => {
  const h = new FakeHermes();
  const sid = await h.createSession();
  const tools = await collect((await h.startRun({ sessionId: sid, message: "run tool", model: "m" })).frames);
  expect(tools.map(f => f.type)).toEqual(expect.arrayContaining(["tool.started", "tool.completed"]));
  const think = await collect((await h.startRun({ sessionId: sid, message: "think hard", model: "m" })).frames);
  expect(think.some(f => f.type === "reasoning")).toBe(true);
  const fail = await collect((await h.startRun({ sessionId: sid, message: "please fail", model: "m" })).frames);
  expect(fail.at(-1)).toMatchObject({ type: "done", status: "failed", error: "scripted failure" });
  const intr = await collect((await h.startRun({ sessionId: sid, message: "interrupt me", model: "m" })).frames);
  expect(intr.at(-1)).toMatchObject({ type: "done", status: "interrupted" });
});

test("stopRun during a run ends it as interrupted; steer works only while active", async () => {
  const h = new FakeHermes();
  const sid = await h.createSession();
  const r = await h.startRun({ sessionId: sid, message: "hello", model: "m" });
  await h.steerRun(r.runId, "pineapple");
  expect(h.steered).toEqual([{ runId: r.runId, message: "pineapple" }]);
  await h.stopRun(r.runId);
  const out = await collect(r.frames);
  expect(out.at(-1)).toMatchObject({ type: "done", status: "interrupted" });
  await expect(h.steerRun(r.runId, "late")).rejects.toMatchObject({ status: 409, message: "run finished" });
  expect(r.runId).toBeTypeOf("string");
});

test("steer after a completed run is 409; errors are ChatError", async () => {
  const h = new FakeHermes();
  const sid = await h.createSession();
  const r = await h.startRun({ sessionId: sid, message: "hello", model: "m" });
  await collect(r.frames);
  let err: unknown;
  try { await h.steerRun(r.runId, "x"); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ChatError);
  expect((err as ChatError).status).toBe(409);
});

test("modelOptions scripted failure surfaces as a thrown error", async () => {
  const h = new FakeHermes({ modelOptionsError: "down" });
  await expect(h.modelOptions()).rejects.toThrow("down");
});
