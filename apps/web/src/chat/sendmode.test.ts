import { test, expect } from "bun:test";
import { sendMode } from "./sendmode";

test("idle: a normal message to the named agent", () => {
  expect(sendMode(false, "Pi")).toEqual({ kind: "send", label: "Send", title: "Send", placeholder: "Message Pi…", hint: null });
  expect(sendMode(false, "Hermes").placeholder).toBe("Message Hermes…");
});

test("running: everything says steer, so the button cannot be mistaken for Send", () => {
  const m = sendMode(true, "Pi");
  expect(m.kind).toBe("steer");
  expect(m.label).toBe("Steer");
  expect(m.title).toContain("running task");
  expect(m.placeholder).toBe("Steer the running task…");
  expect(m.hint).toContain("steers");
  // The placeholder no longer names the agent, so it cannot read like a fresh message.
  expect(m.placeholder).not.toContain("Message");
});

import { routeInput } from "./sendmode";
import { parseSlash } from "./slash";

test("a slash command never steers or sends, running or idle", () => {
  for (const busy of [true, false]) {
    expect(routeInput(busy, parseSlash("/yolo", "pi"))).toBe("command");
    expect(routeInput(busy, parseSlash("/nope", "pi"))).toBe("command");
    expect(routeInput(busy, parseSlash("/steer be brief", "pi"))).toBe("command");
  }
});

test("plain text steers while running and sends when idle", () => {
  expect(routeInput(true, parseSlash("use bun", "pi"))).toBe("steer");
  expect(routeInput(false, parseSlash("use bun", "pi"))).toBe("send");
});
