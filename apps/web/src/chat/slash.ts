import type { Effort } from "./types";

export const COMMANDS = [
  { name: "new", desc: "Start a new chat" },
  { name: "model", desc: "Switch model" },
  { name: "reasoning", desc: "Set reasoning effort" },
  { name: "stop", desc: "Stop the running task" },
  { name: "retry", desc: "Send your last message again" },
  { name: "title", desc: "Rename this chat" },
  { name: "export", desc: "Download this chat as markdown" },
  { name: "pin", desc: "Pin or unpin this chat" },
  { name: "archive", desc: "Archive or restore this chat" },
  { name: "delete", desc: "Delete this chat" },
  { name: "steer", desc: "Send a note to the running task" },
  { name: "credits", desc: "Show account balances and usage limits" },
  { name: "help", desc: "List commands" },
] as const;

/** Commands the page handles (they need the active chat); the rest the composer handles itself. */
export const PAGE_COMMANDS = ["retry", "title", "export", "pin", "archive", "delete", "steer", "credits"] as const;

export const helpText = () => COMMANDS.map(c => `/${c.name} ${c.desc.toLowerCase()}`).join(" · ");
export const unknownText = (name: string) => `Unknown command /${name}. Type /help to list them.`;

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
