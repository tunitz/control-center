import { test, expect, beforeEach } from "bun:test";
import { subscribeHash } from "./route";

// Stubbed globals, same style as clipboard.test.ts: a small listener registry
// so we can dispatch events and inspect what the unsubscribe removed.
let registry: Map<string, Set<() => void>>, seen: string[];
beforeEach(() => {
  registry = new Map();
  seen = [];
  (globalThis as any).location = { hash: "" };
  (globalThis as any).addEventListener = (ev: string, fn: () => void) => {
    const set = registry.get(ev) ?? new Set();
    set.add(fn);
    registry.set(ev, set);
  };
  (globalThis as any).removeEventListener = (ev: string, fn: () => void) => {
    registry.get(ev)?.delete(fn);
  };
});
const dispatch = (ev: string) => {
  for (const fn of registry.get(ev) ?? []) fn();
};

test("dispatching hashchange, popstate and pageshow after setting location.hash fires onChange", () => {
  const off = subscribeHash(h => seen.push(h));
  (globalThis as any).location.hash = "#/unit/1";
  for (const ev of ["hashchange", "popstate", "pageshow"]) {
    seen = [];
    dispatch(ev);
    expect(seen).toEqual(["#/unit/1"]);
  }
  off();
});

test("empty location.hash reports #/", () => {
  const off = subscribeHash(h => seen.push(h));
  expect(seen).toEqual(["#/"]);
  off();
});

test("the returned function removes all listeners (registry empty afterwards)", () => {
  const off = subscribeHash(() => {});
  expect([...registry.keys()].sort()).toEqual(["cc-nav", "hashchange", "pageshow", "popstate"]);
  off();
  expect([...registry.values()].every(s => s.size === 0)).toBe(true);
});
