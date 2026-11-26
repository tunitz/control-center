import { test, expect } from "bun:test";
import { parentHash, isBackSwipe } from "./swipe";

test("parentHash: unit and settings go to the dashboard, dashboard has none", () => {
  expect(parentHash("#/unit/3")).toBe("#/");
  expect(parentHash("#/settings")).toBe("#/");
  expect(parentHash("#/")).toBeNull();
  expect(parentHash("")).toBeNull();
});

test("parentHash: a chat route is not a route any more", () => {
  expect(parentHash("#/chat/s-abc")).toBeNull();
  expect(parentHash("#/chat")).toBeNull();
});

test("isBackSwipe: starts at the left edge and travels right", () => {
  expect(isBackSwipe({ x0: 5, y0: 300, x1: 120, y1: 310, ms: 250 })).toBe(true);
});
test("isBackSwipe: rejects starts away from the edge", () => {
  expect(isBackSwipe({ x0: 80, y0: 300, x1: 220, y1: 300, ms: 250 })).toBe(false);
});
test("isBackSwipe: rejects short, mostly vertical, or slow drags", () => {
  expect(isBackSwipe({ x0: 5, y0: 300, x1: 40, y1: 300, ms: 200 })).toBe(false);
  expect(isBackSwipe({ x0: 5, y0: 300, x1: 120, y1: 460, ms: 200 })).toBe(false);
  expect(isBackSwipe({ x0: 5, y0: 300, x1: 120, y1: 300, ms: 1500 })).toBe(false);
});
test("isBackSwipe: rejects leftward drags", () => {
  expect(isBackSwipe({ x0: 5, y0: 300, x1: -50, y1: 300, ms: 200 })).toBe(false);
});
