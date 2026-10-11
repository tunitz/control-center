import { test, expect } from "bun:test";
import { sendEffort } from "./effort";
import type { ChatModel } from "./types";

const base: ChatModel = { id: "m", provider: "p", label: "m", reasoning: true, canDisableReasoning: true, vision: false, local: false, online: true };

test("effort is sent only for models with reasoning", () => {
  expect(sendEffort({ ...base, reasoning: false }, "high")).toBeNull();
  expect(sendEffort(base, "high")).toBe("high");
  expect(sendEffort(undefined, "high")).toBeNull();
});

test("off is sent only when the model can disable reasoning", () => {
  expect(sendEffort({ ...base, canDisableReasoning: false }, "off")).toBeNull();
  expect(sendEffort(base, "off")).toBe("off");
});

test("no effort set means nothing is sent", () => {
  expect(sendEffort(base, null)).toBeNull();
});
