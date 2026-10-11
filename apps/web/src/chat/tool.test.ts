import { test, expect } from "bun:test";
import { toolTarget, toolStatus } from "./tool";
import type { ToolRow } from "./types";

const row = (p: Partial<ToolRow>): ToolRow => ({ id: "t1", name: "terminal", args: null, preview: null, status: "ok", durationMs: 10, ...p });

test("plain string args are joined", () => {
  expect(toolTarget({ command: "echo hi", timeout: 5 })).toBe("echo hi 5");
});

test("delegate_task shows the first goal, never [object Object]", () => {
  expect(toolTarget({ tasks: [{ goal: "Research Pi" }] })).toBe("Research Pi");
  expect(toolTarget({ tasks: [{ goal: "A" }, { goal: "B" }, { goal: "C" }] })).toBe("A +2 more");
});

test("other objects are compact JSON", () => {
  expect(toolTarget({ opts: { a: 1 } })).toBe('{"a":1}');
  expect(toolTarget({ x: null, y: undefined })).toBe("");
});

test("long targets are cut", () => {
  expect(toolTarget({ command: "x".repeat(200) }).length).toBeLessThanOrEqual(80);
});

test("a finished delegate_task is a dispatch, not a result", () => {
  expect(toolStatus(row({ name: "delegate_task" }))).toEqual({ cls: "stat-run", label: "background" });
  expect(toolStatus(row({ name: "delegate_task", status: "failed" }))).toEqual({ cls: "stat-err", label: "failed" });
  expect(toolStatus(row({}))).toEqual({ cls: "stat-ok", label: "ok" });
  expect(toolStatus(row({ status: "running" }))).toEqual({ cls: "stat-run", label: "running" });
});
