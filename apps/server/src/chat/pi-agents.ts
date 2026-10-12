/**
 * Validation for subagent definitions sent from the Settings page (PUT /api/chat/pi/agents/:name).
 * The bridge validates again; this keeps bad input out of the proxy and gives a clear 400.
 */
import { ChatError } from "./http";
import { TOOL_NAME_RE } from "./pi-settings";
import type { PiAgent } from "./pi";

export const AGENT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
const TEXT_MAX = 20_000;
const SHORT_MAX = 500;

const strList = (v: unknown, field: string, check?: (s: string) => boolean): string[] => {
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string" && (!check || check(x)))) {
    throw new ChatError(400, `${field} must be a list of names`);
  }
  if (new Set(v).size !== v.length) throw new ChatError(400, `${field} has a duplicate`);
  return v as string[];
};

const text = (v: unknown, field: string, max: number): string => {
  if (typeof v !== "string" || v.length > max) throw new ChatError(400, `${field} must be text of at most ${max} characters`);
  return v;
};

/** Validates an agent body. `name` is the path's name, which the body must match. */
export function parseAgent(name: string, body: unknown): PiAgent {
  if (!AGENT_NAME_RE.test(name)) throw new ChatError(400, "name must be lowercase letters, digits and dashes, starting with a letter, at most 40 characters");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ChatError(400, "agent must be an object");
  const b = body as Record<string, unknown>;
  if (b.name !== name) throw new ChatError(400, "body name must match the name in the URL");
  const thinking = text(b.thinking, "thinking", 32);
  return {
    name,
    description: text(b.description, "description", SHORT_MAX),
    model: text(b.model, "model", SHORT_MAX),
    thinking,
    instructions: text(b.instructions, "instructions", TEXT_MAX),
    notes: text(b.notes, "notes", TEXT_MAX),
    tools: strList(b.tools, "tools", (t) => TOOL_NAME_RE.test(t)),
    skills: strList(b.skills, "skills"),
  };
}
