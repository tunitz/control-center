import { test, expect, describe } from "bun:test";
import { newRunView, applyEvent, reduceEvents, showReasoning, isAbnormal } from "./reduce";
import type { ChatMessage } from "./types";

const base: ChatMessage = { id: "a1", seq: 2, role: "assistant", text: "", reasoning: null, tools: [], blocks: [], usage: null, status: "running", runId: null, model: null, attachments: [], createdAt: 0, error: null };
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
  expect(v.message.blocks).toEqual([{ kind: "approval", approval: { command: "rm -rf x", note: "needs approval in Hermes" } }]);
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

describe("todo events", () => {
  const base = { id: "a1", seq: 2, role: "assistant", text: "", reasoning: null, tools: [], usage: null, status: "running", runId: "r", model: "m", attachments: [], createdAt: 0, error: null } as any;
  const t1 = [{ id: "1", content: "a", status: "in_progress" }];
  const t2 = [{ id: "1", content: "a", status: "completed" }, { id: "2", content: "b", status: "pending" }];
  test("a todo event replaces the whole list", () => {
    let v = newRunView(base);
    v = applyEvent(v, { id: 1, type: "todo", data: { todos: t1 } });
    expect(v.message.todos).toEqual(t1);
    v = applyEvent(v, { id: 2, type: "todo", data: { todos: t2 } });
    expect(v.message.todos).toEqual(t2);
  });
  test("an empty list clears; a replayed event is ignored", () => {
    let v = applyEvent(newRunView(base), { id: 1, type: "todo", data: { todos: t1 } });
    v = applyEvent(v, { id: 1, type: "todo", data: { todos: t2 } });
    expect(v.message.todos).toEqual(t1);
    v = applyEvent(v, { id: 2, type: "todo", data: { todos: [] } });
    expect(v.message.todos).toEqual([]);
  });
  test("a malformed payload leaves the list alone", () => {
    const v = applyEvent(applyEvent(newRunView(base), { id: 1, type: "todo", data: { todos: t1 } }), { id: 2, type: "todo", data: { todos: "x" } });
    expect(v.message.todos).toEqual(t1);
  });
  test("newRunView starts with no todos", () => {
    expect(newRunView(base).message.todos ?? null).toBeNull();
  });
});

describe("Pi approvals", () => {
  const ask = { id: "u1", command: "Run: rm -rf x", note: "Allow command?", options: ["approve", "deny"] };
  const start = (id: string) => ({ id, name: "bash", args: null, preview: null });
  const approvalOf = (v: ReturnType<typeof newRunView>) => {
    const b = v.message.blocks?.find(x => x.kind === "approval");
    return b && b.kind === "approval" ? b.approval : undefined;
  };

  test("a Pi approval keeps its id and options and starts pending", () => {
    const v = applyEvent(newRunView(base), ev(1, "approval", ask));
    expect(v.message.blocks).toEqual([{ kind: "approval", approval: { ...ask, status: "pending" } }]);
  });
  test("a Hermes approval (no id) stays exactly as before", () => {
    const v = applyEvent(newRunView(base), ev(1, "approval", { command: "x", note: "needs approval in Hermes" }));
    expect(v.message.blocks).toEqual([{ kind: "approval", approval: { command: "x", note: "needs approval in Hermes" } }]);
  });
  test("tool.completed ok resolves the pending approval as approved", () => {
    const v = reduceEvents(newRunView(base), [ev(1, "tool.started", start("t1")), ev(2, "approval", ask), ev(3, "tool.completed", { id: "t1", ok: true, durationMs: 5 })]);
    expect(approvalOf(v)?.status).toBe("approved");
  });
  test("tool.completed failed resolves it as denied", () => {
    const v = reduceEvents(newRunView(base), [ev(1, "tool.started", start("t1")), ev(2, "approval", ask), ev(3, "tool.completed", { id: "t1", ok: false })]);
    expect(approvalOf(v)?.status).toBe("denied");
  });
  test("approval.answered folds the card before the tool completes", () => {
    const pending = reduceEvents(newRunView(base), [ev(1, "tool.started", start("t1")), ev(2, "approval", ask)]);
    expect(approvalOf(applyEvent(pending, ev(3, "approval.answered", { id: "u1", choice: "approve" })))?.status).toBe("approved");
    expect(approvalOf(applyEvent(pending, ev(3, "approval.answered", { id: "u1", choice: "deny" })))?.status).toBe("denied");
  });
  test("a late tool.completed does not overwrite an answered approval", () => {
    const v = reduceEvents(newRunView(base), [
      ev(1, "tool.started", start("t1")), ev(2, "approval", ask),
      ev(3, "approval.answered", { id: "u1", choice: "approve" }), ev(4, "tool.completed", { id: "t1", ok: false }),
    ]);
    expect(approvalOf(v)?.status).toBe("approved");
  });
  test("a run that ends while an approval is still pending marks it ended", () => {
    const v = reduceEvents(newRunView(base), [ev(1, "approval", ask), ev(2, "done", { status: "interrupted" })]);
    expect(approvalOf(v)?.status).toBe("ended");
  });
  test("an already resolved approval is not changed by later events", () => {
    const v = reduceEvents(newRunView(base), [
      ev(1, "approval", ask), ev(2, "tool.completed", { id: "t1", ok: true }),
      ev(3, "tool.completed", { id: "t2", ok: false }), ev(4, "done", { status: "complete" }),
    ]);
    expect(approvalOf(v)?.status).toBe("approved");
  });
  test("replaying the same events gives the same approvals", () => {
    const events = [ev(1, "approval", ask), ev(2, "tool.completed", { id: "t1", ok: true })];
    expect(reduceEvents(reduceEvents(newRunView(base), events), events).message.blocks).toEqual(reduceEvents(newRunView(base), events).message.blocks);
  });
  test("blocks keep text, tools and approvals in the order they arrived", () => {
    const v = reduceEvents(newRunView(base), [
      ev(1, "delta", { text: "Let me clean that up." }),
      ev(2, "delta", { text: " One moment." }),
      ev(3, "tool.started", start("t1")),
      ev(4, "approval", ask),
      ev(5, "tool.completed", { id: "t1", ok: true }),
      ev(6, "delta", { text: "Done." }),
    ]);
    expect(v.message.blocks?.map(b => b.kind)).toEqual(["text", "tool", "approval", "text"]);
    expect(v.message.blocks?.[0]).toEqual({ kind: "text", text: "Let me clean that up. One moment." });
    expect(v.message.blocks?.[3]).toEqual({ kind: "text", text: "Done." });
  });
});
