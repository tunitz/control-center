import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toolRows, toggleTool } from "./tools";
import type { PiTool } from "./types";

const TOOLS: PiTool[] = [
  { name: "read", description: "Read a file from disk." },
  { name: "subagent", description: "Delegate a task to a named subagent." },
  { name: "bg_wait", description: "Wait for a background task." },
];

describe("toolRows", () => {
  test("lists every tool the bridge offers, with its description, in bridge order", () => {
    expect(toolRows(TOOLS, null)).toEqual([
      { name: "read", description: "Read a file from disk.", checked: false, missing: false },
      { name: "subagent", description: "Delegate a task to a named subagent.", checked: false, missing: false },
      { name: "bg_wait", description: "Wait for a background task.", checked: false, missing: false },
    ]);
  });

  test("ticks the effective selection", () => {
    const rows = toolRows(TOOLS, ["read", "bg_wait"]);
    expect(rows.map((r) => [r.name, r.checked])).toEqual([["read", true], ["subagent", false], ["bg_wait", true]]);
  });

  test("a selected tool that is no longer offered still shows (so it can be unticked), marked missing", () => {
    const rows = toolRows(TOOLS, ["read", "gone_tool"]);
    expect(rows.at(-1)).toEqual({ name: "gone_tool", description: "No longer offered by Pi.", checked: true, missing: true });
  });

  test("a new tool appears with no code change", () => {
    const rows = toolRows([...TOOLS, { name: "brand_new", description: "New." }], null);
    expect(rows.find((r) => r.name === "brand_new")).toMatchObject({ description: "New.", checked: false });
  });

  test("with no tool list yet, selected names still show", () => {
    expect(toolRows([], ["read"]).map((r) => r.name)).toEqual(["read"]);
  });

  test("null selection with a tool list: nothing ticked here (the caller decides what 'default' means)", () => {
    expect(toolRows(TOOLS, null).every((r) => !r.checked)).toBe(true);
  });
});

describe("toggleTool", () => {
  test("adds a tool in bridge order", () => {
    expect(toggleTool(TOOLS, ["bg_wait"], "read")).toEqual(["read", "bg_wait"]);
  });

  test("removes a tool; refuses to empty the selection", () => {
    expect(toggleTool(TOOLS, ["read", "bg_wait"], "read")).toEqual(["bg_wait"]);
    expect(toggleTool(TOOLS, ["read"], "read")).toEqual(["read"]);
  });

  test("can untick a tool that is no longer offered", () => {
    expect(toggleTool(TOOLS, ["read", "gone_tool"], "gone_tool")).toEqual(["read"]);
  });
});

test("no tool name is hardcoded in the components that show the list", () => {
  const files = ["../components/PiConfigCard.tsx", "../components/chat/PiSheet.tsx"];
  for (const f of files) {
    const src = readFileSync(join(import.meta.dir, f), "utf8");
    for (const name of ["todo_write", "bash", "subagent", "bg_wait", "web_search"]) {
      expect(src.includes(`"${name}"`)).toBe(false);
    }
  }
});
