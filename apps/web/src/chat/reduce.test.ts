import { test, expect } from "bun:test";
import { newRunView, applyEvent, reduceEvents, showReasoning, isAbnormal } from "./reduce";
import type { ChatMessage } from "./types";

const base: ChatMessage = { id: "a1", seq: 2, role: "assistant", text: "", reasoning: null, tools: [], usage: null, status: "running", runId: null, model: null, attachments: [], createdAt: 0, error: null };
const ev = (id: number, type: string, data: any) => ({ id, type, data });

test("deltas and reasoning append, run.started sets runId and model", () => {
  const v = reduceEvents(newRunView(base), [
    ev(1, "run.started", { runId: "r1", sessionId: "s", assistantMessageId: "a1", model: "m1" }),
    ev(2, "reasoning", { text: "think " }),
    ev(3, "reasoning", { text: "more" }),
    ev(4, "delta", { text: "Hel" }),
    ev(5, "delta", { text: "lo" }),
  ]);
  expect(v.message.text).toBe("Hello");
  expect(v.message.reasoning).toBe("think more");
  expect(v.message.runId).toBe("r1");
  expect(v.message.model).toBe("m1");
  expect(v.lastId).toBe(5);
});

test("tool rows: started then completed updates status and duration", () => {
  const v = reduceEvents(newRunView(base), [
    ev(1, "tool.started", { id: "t1", name: "terminal", args: { command: "docker ps" }, preview: null }),
    ev(2, "tool.completed", { id: "t1", ok: true, durationMs: 800, preview: "CONTAINER" }),
    ev(3, "tool.started", { id: "t2", name: "read_file", args: null, preview: null }),
    ev(4, "tool.completed", { id: "t2", ok: false, durationMs: 90, preview: "no such file" }),
  ]);
  expect(v.message.tools).toEqual([
    { id: "t1", name: "terminal", args: { command: "docker ps" }, preview: "CONTAINER", status: "ok", durationMs: 800 },
    { id: "t2", name: "read_file", args: null, preview: "no such file", status: "failed", durationMs: 90 },
  ]);
});

test("replay: events at or below lastId are ignored, so re-delivery never duplicates text", () => {
  const first = reduceEvents(newRunView(base), [ev(1, "delta", { text: "A" }), ev(2, "delta", { text: "B" })]);
  const again = reduceEvents(first, [ev(1, "delta", { text: "A" }), ev(2, "delta", { text: "B" }), ev(3, "delta", { text: "C" })]);
  expect(again.message.text).toBe("ABC");
  expect(again.lastId).toBe(3);
});

test("usage and done set status, error and model; approval is collected", () => {
  const v = reduceEvents(newRunView(base), [
    ev(1, "approval", { command: "rm -rf x", note: "needs approval in Hermes" }),
    ev(2, "usage", { input: 1200, output: 80 }),
    ev(3, "done", { status: "interrupted", error: "client gone", model: "m2" }),
  ]);
  expect(v.message.usage).toEqual({ input: 1200, output: 80 });
  expect(v.message.status).toBe("interrupted");
  expect(v.message.error).toBe("client gone");
  expect(v.message.model).toBe("m2");
  expect(v.approvals).toEqual([{ command: "rm -rf x", note: "needs approval in Hermes" }]);
  expect(v.done).toBe(true);
});

test("unknown event types are ignored but still advance lastId", () => {
  const v = applyEvent(newRunView(base), ev(7, "future.thing", { x: 1 }));
  expect(v.message).toEqual(base);
  expect(v.lastId).toBe(7);
});

test("reasoning row only when it differs from the final text", () => {
  expect(showReasoning({ ...base, reasoning: "same", text: "same" })).toBe(false);
  expect(showReasoning({ ...base, reasoning: "plan", text: "answer" })).toBe(true);
  expect(showReasoning({ ...base, reasoning: null, text: "x" })).toBe(false);
});

test("failed and interrupted are abnormal, complete and running are not", () => {
  expect(isAbnormal({ ...base, status: "failed" })).toBe(true);
  expect(isAbnormal({ ...base, status: "interrupted" })).toBe(true);
  expect(isAbnormal({ ...base, status: "complete" })).toBe(false);
  expect(isAbnormal({ ...base, status: "running" })).toBe(false);
});
