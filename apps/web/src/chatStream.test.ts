import { test, expect } from "bun:test";
import { parseSse, applyEvent, initialStream, toViewMessages, sessionLabel } from "./chatStream";

test("parseSse keeps a partial event until its blank line arrives", () => {
  const a = parseSse("", 'event: assistant.delta\ndata: {"delta":"po');
  expect(a.events).toEqual([]);
  const b = parseSse(a.rest, 'ng"}\n\nevent: run.completed\ndata: {"completed":true}\n\n');
  expect(b.events).toEqual([
    { event: "assistant.delta", data: { delta: "pong" } },
    { event: "run.completed", data: { completed: true } },
  ]);
});

test("applyEvent appends deltas in order", () => {
  let s = initialStream;
  s = applyEvent(s, { event: "assistant.delta", data: { delta: "Hel" } });
  s = applyEvent(s, { event: "assistant.delta", data: { delta: "lo" } });
  expect(s).toEqual({ text: "Hello", status: "streaming", error: "" });
});

test("run.completed marks the reply done and keeps the final assistant text", () => {
  let s = applyEvent(initialStream, { event: "assistant.delta", data: { delta: "pon" } });
  s = applyEvent(s, { event: "run.completed", data: { messages: [{ role: "assistant", content: "pong" }] } });
  expect(s.status).toBe("done");
  expect(s.text).toBe("pong");
});

test("run.failed carries the error text and stops streaming", () => {
  const s = applyEvent(initialStream, { event: "run.failed", data: { error: "model timeout" } });
  expect(s.status).toBe("error");
  expect(s.error).toBe("model timeout");
});

test("run.cancelled is a distinct terminal state", () => {
  expect(applyEvent(initialStream, { event: "run.cancelled", data: {} }).status).toBe("cancelled");
});

test("tool events do not change the reply text", () => {
  const s = applyEvent(initialStream, { event: "tool.started", data: { tool: "terminal" } });
  expect(s).toEqual(initialStream);
});

test("toViewMessages keeps only user and assistant turns with text", () => {
  const raw = [
    { role: "user", content: "hi" },
    { role: "tool", content: "{}" },
    { role: "assistant", content: "hello" },
    { role: "assistant", content: null },
  ];
  expect(toViewMessages(raw)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ]);
});

test("sessionLabel prefers the title, then the preview, then a placeholder", () => {
  expect(sessionLabel({ title: "Plan", preview: "x" })).toBe("Plan");
  const long = "Integrate Hermes chat into the control center with session switching and new chats";
  expect(sessionLabel({ title: null, preview: long })).toBe(long.slice(0, 60));
  expect(sessionLabel({ title: null, preview: "short" })).toBe("short");
  expect(sessionLabel({ title: null, preview: null })).toBe("New chat");
});
