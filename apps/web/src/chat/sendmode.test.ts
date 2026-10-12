import { test, expect } from "bun:test";
import { sendMode, routeInput } from "./sendmode";
import { parseSlash } from "./slash";

test("idle: a normal message to the named agent", () => {
  expect(sendMode(false, "Pi")).toEqual({ label: "Send", title: "Send", placeholder: "Message Pi…", hint: null });
  expect(sendMode(false, "Hermes").placeholder).toBe("Message Hermes…");
});

test("running: still Send, and the hint says it replaces the task or waits", () => {
  const m = sendMode(true, "Pi");
  expect(m.label).toBe("Send");
  expect(m.title).toContain("stops the running task");
  expect(m.hint).toContain("waits if subagents");
});

test("a slash command never becomes a message, running or idle", () => {
  expect(routeInput(parseSlash("/yolo", "pi"))).toBe("command");
  expect(routeInput(parseSlash("/nope", "pi"))).toBe("command");
  expect(routeInput(parseSlash("/steer be brief", "pi"))).toBe("command");
});

test("plain text is a message", () => {
  expect(routeInput(parseSlash("use bun", "pi"))).toBe("send");
});
