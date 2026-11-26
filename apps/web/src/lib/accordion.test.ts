import { test, expect } from "bun:test";
import { readOpenSection, writeOpenSection } from "./accordion";

const mem = (init: Record<string, string> = {}) => {
  const d = { ...init };
  return { getItem: (k: string) => (k in d ? d[k] : null), setItem: (k: string, v: string) => { d[k] = v; }, d };
};
const IDS = ["appearance", "monitoring", "security"];

test("a stored section that still exists is reopened", () => {
  expect(readOpenSection(mem({ k: "security" }), "k", IDS, "appearance")).toBe("security");
});

test("nothing stored, an unknown id or no storage falls back", () => {
  expect(readOpenSection(mem(), "k", IDS, "appearance")).toBe("appearance");
  expect(readOpenSection(mem({ k: "removed-section" }), "k", IDS, "appearance")).toBe("appearance");
  expect(readOpenSection(null, "k", IDS, "appearance")).toBe("appearance");
});

test("all closed is remembered too, instead of reopening the default", () => {
  const s = mem();
  writeOpenSection(s, "k", "");
  expect(readOpenSection(s, "k", IDS, "appearance")).toBe("");
});

test("blocked storage never throws", () => {
  const blocked = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); } };
  expect(readOpenSection(blocked, "k", IDS, "monitoring")).toBe("monitoring");
  expect(() => writeOpenSection(blocked, "k", "security")).not.toThrow();
});
