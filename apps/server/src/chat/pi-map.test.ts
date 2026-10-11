import { test, expect } from "bun:test";
import { mapPiEvent, newPiMapState } from "./pi";
import type { HermesFrame } from "./hermes";

// Payload shapes are copied from real Pi 1.1.0 runs (live bridge capture, 2026-10-11).
const M = "deepseek-flash";
const map = (st: ReturnType<typeof newPiMapState>, event: string, data: unknown): HermesFrame[] => mapPiEvent(event, data, M, st);

const assistantEnd = (usage: Record<string, number>, stopReason = "stop") => ({
  type: "message_end",
  message: { role: "assistant", content: [], usage: { cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...usage }, stopReason },
});

test("text_delta -> delta; thinking_delta -> reasoning; other message_update parts are ignored", () => {
  const st = newPiMapState();
  const upd = (ae: unknown) => ({ type: "message_update", usage: {}, assistantMessageEvent: ae });
  expect(map(st, "message_update", upd({ type: "text_delta", contentIndex: 0, delta: "Hi" }))).toEqual([{ type: "delta", text: "Hi" }]);
  expect(map(st, "message_update", upd({ type: "thinking_delta", contentIndex: 0, delta: "hmm" }))).toEqual([{ type: "reasoning", text: "hmm" }]);
  expect(map(st, "message_update", upd({ type: "text_start", contentIndex: 0 }))).toEqual([]);
  expect(map(st, "message_update", upd({ type: "text_delta", contentIndex: 0, delta: "" }))).toEqual([]);
});

test("tool_execution_start -> tool.started with a command preview for bash", () => {
  const st = newPiMapState();
  const f = map(st, "tool_execution_start", { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "echo hi", timeout: null } });
  expect(f).toEqual([{ type: "tool.started", id: "c1", name: "bash", args: { command: "echo hi", timeout: null }, preview: "echo hi" }]);
});

test("tool preview falls back to the path for file tools and null otherwise", () => {
  const st = newPiMapState();
  expect(map(st, "tool_execution_start", { toolCallId: "a", toolName: "read", args: { path: "/x/y.ts" } })[0]).toMatchObject({ preview: "/x/y.ts" });
  expect(map(st, "tool_execution_start", { toolCallId: "b", toolName: "todo_write", args: { todos: [] } })[0]).toMatchObject({ preview: null });
});

test("tool_execution_end -> tool.completed ok, with output preview and duration", () => {
  const st = newPiMapState();
  const f = map(st, "tool_execution_end", {
    type: "tool_execution_end", toolCallId: "c1", toolName: "bash",
    result: { content: [{ type: "text", text: "hi\n" }] }, isError: false, durationMs: 7,
  });
  expect(f).toEqual([{ type: "tool.completed", id: "c1", ok: true, durationMs: 7, preview: "hi" }]);
});

test("a blocked tool (isError) -> tool.completed ok:false carrying Pi's reason", () => {
  const st = newPiMapState();
  const f = map(st, "tool_execution_end", {
    toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "Blocked by cc-gate: not approved" }], details: {} }, isError: true,
  });
  expect(f).toEqual([{ type: "tool.completed", id: "c1", ok: false, durationMs: null, preview: "Blocked by cc-gate: not approved" }]);
});

test("a long tool output preview is cut", () => {
  const st = newPiMapState();
  const f = map(st, "tool_execution_end", { toolCallId: "c", toolName: "bash", result: { content: [{ type: "text", text: "x".repeat(5000) }] }, isError: false });
  expect((f[0] as { preview: string }).preview.length).toBeLessThanOrEqual(300);
});

test("assistant message_end -> usage, cumulative over the turns of a run", () => {
  const st = newPiMapState();
  expect(map(st, "message_end", assistantEnd({ input: 1199, output: 86 }))).toEqual([{ type: "usage", input: 1199, output: 86 }]);
  expect(map(st, "message_end", assistantEnd({ input: 1300, output: 40 }))).toEqual([{ type: "usage", input: 2499, output: 126 }]);
});

test("user and system message_end produce nothing", () => {
  const st = newPiMapState();
  expect(map(st, "message_end", { type: "message_end", message: { role: "user", content: [] } })).toEqual([]);
  expect(map(st, "message_end", { type: "message_end", message: { role: "system", content: "" } })).toEqual([]);
});

test("extension_ui_request confirm -> approval with id, options, the command and the title", () => {
  const st = newPiMapState();
  const f = map(st, "extension_ui_request", {
    type: "extension_ui_request", id: "u1", method: "confirm", title: "Allow command?", message: "Run: rm -rf x",
  });
  expect(f).toEqual([{ type: "approval", id: "u1", command: "Run: rm -rf x", note: "Allow command?", options: ["approve", "deny"] }]);
});

test("other extension_ui_request methods (notify, setWidget) are ignored", () => {
  const st = newPiMapState();
  expect(map(st, "extension_ui_request", { id: "n", method: "notify", message: "pong" })).toEqual([]);
  expect(map(st, "extension_ui_request", { id: "w", method: "setWidget" })).toEqual([]);
});

test("agent_settled: stopReason stop -> complete; aborted -> interrupted; error -> failed with message", () => {
  const st = newPiMapState();
  expect(map(st, "agent_settled", { stopReason: "stop", errorMessage: null })).toEqual([{ type: "done", status: "complete", error: null, model: M }]);
  expect(map(st, "agent_settled", { stopReason: "aborted" })).toEqual([{ type: "done", status: "interrupted", error: null, model: M }]);
  expect(map(st, "agent_settled", { stopReason: "error", errorMessage: "401 bad key" })).toEqual([{ type: "done", status: "failed", error: "401 bad key", model: M }]);
  expect(map(st, "agent_settled", { stopReason: "error", errorMessage: null })).toEqual([{ type: "done", status: "failed", error: "pi run failed", model: M }]);
});

test("process_exit -> done failed", () => {
  expect(map(newPiMapState(), "process_exit", { code: 1 })).toEqual([{ type: "done", status: "failed", error: "pi process exited", model: M }]);
});

test("unknown events map to nothing", () => {
  expect(map(newPiMapState(), "turn_start", { type: "turn_start" })).toEqual([]);
});

test("todo_write tool_execution_end -> tool.completed plus a todo frame from result.details (not the widget)", () => {
  const todos = [
    { id: "1", content: "read code", status: "completed" as const },
    { id: "2", content: "write test", status: "in_progress" as const },
  ];
  const f = map(newPiMapState(), "tool_execution_end", {
    toolCallId: "t1", toolName: "todo_write", isError: false,
    result: { content: [{ type: "text", text: "Todo list updated (2 items)" }], details: { todos } },
  });
  expect(f.map((x) => x.type)).toEqual(["tool.completed", "todo"]);
  expect(f[1]).toEqual({ type: "todo", todos });
});

test("a failed todo_write, or a malformed list, produces no todo frame; bad items are dropped", () => {
  const st = newPiMapState();
  const end = (isError: boolean, details: unknown) => map(st, "tool_execution_end", { toolCallId: "t", toolName: "todo_write", isError, result: { content: [], details } });
  expect(end(true, { todos: [{ id: "1", content: "x", status: "pending" }] }).map((x) => x.type)).toEqual(["tool.completed"]);
  expect(end(false, undefined).map((x) => x.type)).toEqual(["tool.completed"]);
  expect(end(false, { todos: "nope" }).map((x) => x.type)).toEqual(["tool.completed"]);
  const f = end(false, { todos: [{ id: "1", content: "ok", status: "pending" }, { id: 2, content: "bad id" }, { id: "3", content: "bad status", status: "weird" }] });
  expect(f[1]).toEqual({ type: "todo", todos: [{ id: "1", content: "ok", status: "pending" }] });
});

test("an empty list clears the todos", () => {
  const f = map(newPiMapState(), "tool_execution_end", { toolCallId: "t", toolName: "todo_write", isError: false, result: { content: [], details: { todos: [] } } });
  expect(f[1]).toEqual({ type: "todo", todos: [] });
});
