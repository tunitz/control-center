import { test, expect } from "bun:test";
import { parseSlash, suggestions, parseEffort, effortOptions, helpText, PI_COMMANDS } from "./slash";

test("plain text is not a command", () => {
  expect(parseSlash("hello /new")).toBeNull();
  expect(parseSlash("")).toBeNull();
});

test("known command with and without args", () => {
  expect(parseSlash("/new")).toEqual({ kind: "command", name: "new", arg: "" });
  expect(parseSlash("/Reasoning  high ")).toEqual({ kind: "command", name: "reasoning", arg: "high" });
});

test("unknown slash word is reported, not sent as a command", () => {
  expect(parseSlash("/compact")).toEqual({ kind: "unknown", name: "compact" });
});

test("suggestions filter by prefix and stop after the first space", () => {
  expect(suggestions("/").map(c => c.name)).toEqual(["new", "model", "reasoning", "stop", "retry", "title", "export", "pin", "archive", "delete", "steer", "credits", "help"]);
  expect(suggestions("/mo").map(c => c.name)).toEqual(["model"]);
  expect(suggestions("/stop now")).toEqual([]);
  expect(suggestions("hi")).toEqual([]);
});

test("effort words parse, others do not", () => {
  expect(parseEffort("off")).toBe("off");
  expect(parseEffort("MED")).toBe("medium");
  expect(parseEffort("max")).toBeNull();
});

test("effort options follow reasoning flags", () => {
  const base = { id: "m", provider: "p", label: "m", vision: false, local: false, online: true };
  expect(effortOptions({ ...base, reasoning: false, canDisableReasoning: false })).toEqual([]);
  expect(effortOptions({ ...base, reasoning: true, canDisableReasoning: true })).toEqual(["off", "low", "medium", "high"]);
  expect(effortOptions({ ...base, reasoning: true, canDisableReasoning: false })).toEqual(["low", "medium", "high"]);
  expect(effortOptions(undefined)).toEqual([]);
});

import { PAGE_COMMANDS, COMMANDS, helpText, unknownText } from "./slash";
test("every page command is a listed command; help and unknown text come from the list", () => {
  for (const n of PAGE_COMMANDS) expect([...COMMANDS, ...PI_COMMANDS].some(c => c.name === n)).toBe(true);
  for (const c of COMMANDS) expect(helpText()).toContain(`/${c.name}`);
  expect(parseSlash("/retry")).toEqual({ kind: "command", name: "retry", arg: "" });
  expect(unknownText("x")).toBe("Unknown command /x. Type /help to list them.");
});

test("/compact exists only for Pi chats", () => {
  expect(parseSlash("/compact")).toEqual({ kind: "unknown", name: "compact" });
  expect(parseSlash("/compact", "hermes")).toEqual({ kind: "unknown", name: "compact" });
  expect(parseSlash("/compact focus on code", "pi")).toEqual({ kind: "command", name: "compact", arg: "focus on code" });
  expect(suggestions("/comp", "pi").map(c => c.name)).toEqual(["compact"]);
  expect(suggestions("/comp").map(c => c.name)).toEqual([]);
  expect(suggestions("/", "pi").map(c => c.name)).toContain("compact");
  expect(suggestions("/", "hermes").map(c => c.name)).not.toContain("compact");
});

test("help lists /compact only for Pi", () => {
  expect(helpText("pi")).toContain("/compact");
  expect(helpText()).not.toContain("/compact");
});
