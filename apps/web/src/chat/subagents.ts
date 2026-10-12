// Pure helpers for the Settings > Subagents editor. No React here, so they unit-test.
import type { PiAgent, PiSkill } from "./types";

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
export const THINKING_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Default" },
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Model choices for the field: "inherit" first, then each model already used by a subagent. */
export function modelOptions(agents: PiAgent[]): string[] {
  const used = new Set<string>();
  for (const a of agents) if (a.model && a.model !== "inherit") used.add(a.model);
  return ["inherit", ...[...used].sort()];
}

/** A stored thinking value the select knows; anything else shows as the default. */
export function thinkingValue(v: string | undefined): string {
  return THINKING_OPTIONS.some((o) => o.value === v) ? (v as string) : "";
}

/** Skills whose name or description contains the query (case-insensitive). Blank query = all. */
export function filterSkills(skills: PiSkill[], query: string): PiSkill[] {
  const q = query.trim().toLowerCase();
  if (q === "") return skills;
  return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
}

export const validAgentName = (name: string): boolean => AGENT_NAME_RE.test(name);

export type AgentDraft = Omit<PiAgent, "name">;

/** A new subagent: nothing preselected, inherits the chat's model. */
export function blankAgent(): AgentDraft {
  return { description: "", model: "inherit", thinking: "", instructions: "", notes: "", tools: [], skills: [] };
}

/** Turns the editor's draft into the saved shape: trimmed text, blank model -> "inherit". */
export function agentFromDraft(name: string, d: AgentDraft): PiAgent {
  return {
    name,
    description: d.description.trim(),
    model: d.model.trim() === "" ? "inherit" : d.model.trim(),
    thinking: d.thinking,
    instructions: d.instructions,
    notes: d.notes,
    tools: d.tools,
    skills: d.skills,
  };
}
