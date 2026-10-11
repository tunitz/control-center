import { test, expect } from "bun:test";
import { chatHeight } from "./viewport";

test("phone: chat ends at the tabbar top, so the page never needs to scroll", () => {
  expect(chatHeight({ top: 100, vvh: 844, tabbarTop: 770 })).toBe(670);
});
test("keyboard open: visual viewport is shorter than the tabbar top, it wins", () => {
  expect(chatHeight({ top: 100, vvh: 500, tabbarTop: 770 })).toBe(400);
});
test("desktop (no tabbar): leaves a 16px bottom gutter", () => {
  expect(chatHeight({ top: 100, vvh: 800, tabbarTop: null })).toBe(684);
});
test("never below 320px", () => {
  expect(chatHeight({ top: 600, vvh: 700, tabbarTop: null })).toBe(320);
});
