// Global Pi configuration the bridge owns on disk (docs/pi-plan.md T6b). One place that validates
// and writes the files Pi and the cc-gate extension read at startup:
//   <agent>/APPEND_SYSTEM.md  extra system-prompt text
//   <agent>/AGENTS.md         standing notes Pi loads as context
//   <agent>/cc-config.json    { defaultTools }
//   <agent>/cc-gate.json      { extraProtectedPaths, extraRisky }  (stricter-only; see cc-gate.ts)
// Every file is written atomically (temp + rename) with mode 600.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./chat";

export const KNOWN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls", "todo_write"] as const;
const MAX_TEXT = 32_000;
const MAX_RULES = 50;
const MAX_RULE_LEN = 200;

export interface GateRules {
  extraProtectedPaths: string[];
  extraRisky: string[];
}

export interface PiConfig {
  appendSystemPrompt: string;
  agentsMd: string;
  defaultTools: string[] | null;
  gate: GateRules;
  /** Run Claude models through Claude Code (the pi-claude-bridge extension) instead of Pi's own Anthropic client. */
  claudeBridge: boolean;
  /** Register the cc-browser tools (browser_navigate, browser_snapshot, …) for Pi chats. */
  browser: boolean;
}

const file = (dir: string, name: string) => join(dir, name);

/** Claude Code discovery for the Claude-bridge toggle: is the CLI installed, and is the extension present. */
export type ClaudeCodeStatus = { found: boolean; path: string | null; extension: boolean };

const CLAUDE_PREFIXES = ["~/.local/bin", "~/.claude/local", "~/.npm-global/bin", "~/.bun/bin", "~/.volta/bin", "/usr/local/bin", "/opt/homebrew/bin"];

/** First `claude`/`claude-code` executable on PATH or in a known install prefix, else null. */
export function findClaudeCode(): string | null {
  const home = process.env.HOME ?? "";
  const dirs = (process.env.PATH ?? "").split(":").filter(Boolean)
    .concat(CLAUDE_PREFIXES.map((p) => p.replace(/^~/, home)));
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const name of ["claude", "claude-code"]) {
      const p = join(dir, name);
      if (seen.has(p)) continue;
      seen.add(p);
      try {
        if (existsSync(p) && statSync(p).isFile()) return p;
      } catch {
        /* unreadable dir */
      }
    }
  }
  return null;
}

export function claudeCodeStatus(claudeBridgeExtension: string): ClaudeCodeStatus {
  const path = findClaudeCode();
  return { found: path !== null, path, extension: existsSync(claudeBridgeExtension) };
}

function readText(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function readJson(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readText(path));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {}; // corrupt file = no override, never a crash
  }
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export function readConfig(agentDir: string): PiConfig {
  const cc = readJson(file(agentDir, "cc-config.json"));
  const tools = strList(cc.defaultTools).filter((t) => (KNOWN_TOOLS as readonly string[]).includes(t));
  const gate = readJson(file(agentDir, "cc-gate.json"));
  return {
    appendSystemPrompt: readText(file(agentDir, "APPEND_SYSTEM.md")),
    agentsMd: readText(file(agentDir, "AGENTS.md")),
    defaultTools: Array.isArray(cc.defaultTools) && tools.length > 0 ? tools : null,
    gate: { extraProtectedPaths: strList(gate.extraProtectedPaths), extraRisky: strList(gate.extraRisky) },
    claudeBridge: cc.claudeBridge === true,
    browser: cc.browser === true,
  };
}

/** Hash of everything a running Pi has already read at startup. A change means "restart me". */
export function fingerprint(agentDir: string): string {
  const h = createHash("sha256");
  for (const n of ["APPEND_SYSTEM.md", "AGENTS.md", "cc-gate.json"]) h.update(n).update("\0").update(readText(file(agentDir, n))).update("\0");
  return h.digest("hex");
}

/** Validates a tool list. Throws HttpError 400. */
export function parseTools(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length === 0) throw new HttpError(400, `${what} must be a non-empty list of tool names`);
  const seen = new Set<string>();
  for (const t of v) {
    if (typeof t !== "string" || !(KNOWN_TOOLS as readonly string[]).includes(t)) throw new HttpError(400, `${what}: unknown tool ${String(t).slice(0, 40)}`);
    if (seen.has(t)) throw new HttpError(400, `${what}: duplicate tool ${t}`);
    seen.add(t);
  }
  return [...seen];
}

function parseText(v: unknown, what: string): string {
  if (typeof v !== "string") throw new HttpError(400, `${what} must be a string`);
  if (v.length > MAX_TEXT) throw new HttpError(400, `${what} is longer than ${MAX_TEXT} characters`);
  return v;
}

function ruleList(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_RULES) throw new HttpError(400, `${what} must be a list of at most ${MAX_RULES} strings`);
  return v.map((x) => {
    if (typeof x !== "string" || x.trim() === "" || x.length > MAX_RULE_LEN) throw new HttpError(400, `${what}: each rule is a non-empty string up to ${MAX_RULE_LEN} characters`);
    return x;
  });
}

function parseGate(v: unknown, current: GateRules): GateRules {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "gate must be an object");
  const out: GateRules = { ...current };
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "extraProtectedPaths") {
      out.extraProtectedPaths = ruleList(val, k).map((p) => {
        // Relative to the home directory; cannot climb out of it.
        if (p.startsWith("/") || p.startsWith("~") || p.split("/").includes("..")) throw new HttpError(400, `${k}: use a path under your home directory, like projects/secret`);
        return p;
      });
    } else if (k === "extraRisky") {
      out.extraRisky = ruleList(val, k).map((r) => {
        try { new RegExp(r); } catch { throw new HttpError(400, `${k}: not a valid pattern: ${r.slice(0, 60)}`); }
        return r;
      });
    } else {
      // bashAllow, protectedPaths and anything else would loosen the gate: not accepted.
      throw new HttpError(400, `unknown gate setting: ${k}`);
    }
  }
  return out;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

function writeOrRemove(path: string, text: string): void {
  if (text === "") rmSync(path, { force: true });
  else writeAtomic(path, text);
}

/** Validates the whole patch first, then writes. A rejected patch changes nothing. */
export function applyConfigPatch(agentDir: string, body: unknown): PiConfig {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "body must be an object");
  const cur = readConfig(agentDir);
  const next: PiConfig = { ...cur, gate: { ...cur.gate } };
  let touched = 0;
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    touched++;
    if (k === "appendSystemPrompt") next.appendSystemPrompt = parseText(v, k);
    else if (k === "agentsMd") next.agentsMd = parseText(v, k);
    else if (k === "defaultTools") next.defaultTools = v === null ? null : parseTools(v, k);
    else if (k === "claudeBridge") {
      if (typeof v !== "boolean") throw new HttpError(400, "claudeBridge must be a boolean");
      next.claudeBridge = v;
    } else if (k === "browser") {
      if (typeof v !== "boolean") throw new HttpError(400, "browser must be a boolean");
      next.browser = v;
    } else if (k === "gate") next.gate = parseGate(v, cur.gate);
    else throw new HttpError(400, `unknown config key: ${k}`);
  }
  if (touched === 0) throw new HttpError(400, "no config given");

  mkdirSync(agentDir, { recursive: true });
  writeOrRemove(file(agentDir, "APPEND_SYSTEM.md"), next.appendSystemPrompt);
  writeOrRemove(file(agentDir, "AGENTS.md"), next.agentsMd);
  writeAtomic(file(agentDir, "cc-config.json"), JSON.stringify({ defaultTools: next.defaultTools, claudeBridge: next.claudeBridge, browser: next.browser }, null, 2));
  writeAtomic(file(agentDir, "cc-gate.json"), JSON.stringify(next.gate, null, 2));
  return next;
}
