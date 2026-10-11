import type { Effort } from "./types";

export const COMMANDS = [
  { name: "new", desc: "Start a new chat" },
  { name: "model", desc: "Switch model" },
  { name: "reasoning", desc: "Set reasoning effort" },
  { name: "stop", desc: "Stop the running task" },
] as const;

export type Parsed = { kind: "command"; name: string; arg: string } | { kind: "unknown"; name: string } | null;

/** Parses a message that starts with "/". Null for plain text. */
export function parseSlash(text: string): Parsed {
  const t = text.trim();
  if (!t.startsWith("/")) return null;
  const m = /^\/(\S*)\s*(.*)$/s.exec(t);
  const name = (m?.[1] ?? "").toLowerCase();
  const arg = (m?.[2] ?? "").trim();
  if (COMMANDS.some(c => c.name === name)) return { kind: "command", name, arg };
  return { kind: "unknown", name };
}

/** Palette entries while the user is still typing the command word (no space yet). */
export function suggestions(text: string): (typeof COMMANDS)[number][] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const q = text.slice(1).toLowerCase();
  return COMMANDS.filter(c => c.name.startsWith(q));
}

const EFFORT_WORDS: Record<string, Effort> = { off: "off", low: "low", med: "medium", medium: "medium", high: "high" };
export function parseEffort(word: string): Effort | null {
  return EFFORT_WORDS[word.trim().toLowerCase()] ?? null;
}

import type { ChatModel } from "./types";
/** Which effort choices a model offers. Empty means the thinking control is hidden. */
export function effortOptions(model: ChatModel | undefined): Effort[] {
  if (!model || !model.reasoning) return [];
  return model.canDisableReasoning ? ["off", "low", "medium", "high"] : ["low", "medium", "high"];
}
