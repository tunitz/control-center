import { test, expect, describe } from "bun:test";
import { modelOptions, thinkingValue, filterSkills, validAgentName, blankAgent, agentFromDraft } from "./subagents";
import type { PiAgent, PiSkill } from "./types";

const A = (over: Partial<PiAgent>): PiAgent => ({ name: "a", description: "", model: "inherit", thinking: "", instructions: "", notes: "", tools: [], skills: [], ...over });

describe("modelOptions", () => {
  test("'inherit' comes first, then each distinct model the agents use, sorted; blanks dropped", () => {
    const agents = [A({ model: "deepseek-pro" }), A({ name: "b", model: "inherit" }), A({ name: "c", model: "claude-haiku-5-5" }), A({ name: "d", model: "deepseek-pro" }), A({ name: "e", model: "" })];
    expect(modelOptions(agents)).toEqual(["inherit", "claude-haiku-5-5", "deepseek-pro"]);
  });

  test("no agents yet: just 'inherit'", () => {
    expect(modelOptions([])).toEqual(["inherit"]);
  });
});

describe("thinkingValue", () => {
  test("the default option is the empty string; the four levels pass through", () => {
    expect(thinkingValue("")).toBe("");
    expect(thinkingValue("off")).toBe("off");
    expect(thinkingValue("high")).toBe("high");
  });

  test("anything else becomes the default, never an unknown value", () => {
    expect(thinkingValue("max")).toBe("");
    expect(thinkingValue(undefined)).toBe("");
  });
});

describe("filterSkills", () => {
  const S = (name: string, description: string): PiSkill => ({ name, description, scope: "global", path: `/p/${name}`, dir: `/p/${name}`, cwd: null, enabled: true });
  const skills = [S("pdf-tools", "Extract text from PDF files."), S("release-notes", "Draft release notes."), S("browser", "Drive a web page.")];

  test("an empty query returns all skills in order", () => {
    expect(filterSkills(skills, "  ").map((s) => s.name)).toEqual(["pdf-tools", "release-notes", "browser"]);
  });

  test("matches name or description, case-insensitively", () => {
    expect(filterSkills(skills, "PDF").map((s) => s.name)).toEqual(["pdf-tools"]);
    expect(filterSkills(skills, "notes").map((s) => s.name)).toEqual(["release-notes"]);
    expect(filterSkills(skills, "web page").map((s) => s.name)).toEqual(["browser"]);
    expect(filterSkills(skills, "nothing here")).toEqual([]);
  });
});

describe("validAgentName", () => {
  test("matches the bridge rule: lowercase, starts with a letter, letters digits dashes, up to 40", () => {
    expect(validAgentName("reviewer")).toBe(true);
    expect(validAgentName("code-review-2")).toBe(true);
    expect(validAgentName("a".repeat(40))).toBe(true);
    expect(validAgentName("a".repeat(41))).toBe(false);
    expect(validAgentName("Reviewer")).toBe(false);
    expect(validAgentName("2fast")).toBe(false);
    expect(validAgentName("snake_case")).toBe(false);
    expect(validAgentName("")).toBe(false);
  });
});

describe("blankAgent and agentFromDraft", () => {
  test("a new agent starts with nothing preselected and inherits the model", () => {
    expect(blankAgent()).toEqual({ description: "", model: "inherit", thinking: "", instructions: "", notes: "", tools: [], skills: [] });
  });

  test("the draft becomes a saveable agent: trims the model and text, keeps the name, drops nothing", () => {
    const out = agentFromDraft("reviewer", { description: " Reviews ", model: " inherit ", thinking: "high", instructions: "Be strict.", notes: "", tools: ["read"], skills: ["pdf-tools"] });
    expect(out).toEqual({ name: "reviewer", description: "Reviews", model: "inherit", thinking: "high", instructions: "Be strict.", notes: "", tools: ["read"], skills: ["pdf-tools"] });
  });

  test("a blank model is saved as 'inherit'", () => {
    expect(agentFromDraft("x", { description: "", model: "  ", thinking: "", instructions: "", notes: "", tools: [], skills: [] }).model).toBe("inherit");
  });
});
