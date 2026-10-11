import { test, expect } from "bun:test";
import { effortMenuItems, menuLeft } from "./menu";
import type { ChatModel } from "./types";

const base: ChatModel = { id: "m", provider: "p", label: "m", reasoning: true, canDisableReasoning: true, vision: false, local: false, online: true };

test("effort menu lists Off only when the model can disable reasoning", () => {
  expect(effortMenuItems(base).map(i => i.value)).toEqual(["off", "low", "medium", "high"]);
  expect(effortMenuItems({ ...base, canDisableReasoning: false }).map(i => i.value)).toEqual(["low", "medium", "high"]);
});

test("effort menu is empty for models without reasoning or no model", () => {
  expect(effortMenuItems({ ...base, reasoning: false })).toEqual([]);
  expect(effortMenuItems(undefined)).toEqual([]);
});

test("effort menu labels are title case", () => {
  expect(effortMenuItems(base).map(i => i.label)).toEqual(["Off", "Low", "Medium", "High"]);
});

test("menu left edge follows the trigger when it fits", () => {
  expect(menuLeft(100, 60, 200, 390)).toBe(100);
});

test("menu left edge clamps to the 16px gutters", () => {
  expect(menuLeft(4, 40, 240, 390)).toBe(16);
  expect(menuLeft(330, 40, 240, 390)).toBe(390 - 16 - 240);
});
