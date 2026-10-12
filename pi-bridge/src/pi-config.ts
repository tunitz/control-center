// Global Pi configuration the bridge owns on disk (docs/pi-plan.md T6b). One place that validates
// and writes the files Pi and the cc-gate extension read at startup:
//   <agent>/APPEND_SYSTEM.md  extra system-prompt text
//   <agent>/AGENTS.md         standing notes Pi loads as context
//   <agent>/cc-config.json    { defaultTools, claudeBridge, browser }
//   <agent>/cc-gate.json      { extraProtectedPaths, extraRisky }  (stricter-only; see cc-gate.ts)
//   <agent>/settings.json     compaction, FIXED by syncCompaction (not configurable): trigger 256k,
//                             keep 51,200. Every other key Pi wrote is kept as it is.
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

/** Pi compacts when the context passes this many tokens. Fixed: not configurable. */
export const COMPACT_AT_TOKENS = 256_000;
/** Recent context Pi keeps verbatim after a compaction. Fixed: 20% of COMPACT_AT_TOKENS. */
export const KEEP_RECENT_TOKENS = 51_200;
/** Pi's own default reserve (core/compaction/compaction.js DEFAULT_COMPACTION_SETTINGS). */
export const PI_DEFAULT_RESERVE = 16_384;

const file = (dir: string, name: string) => join(dir, name);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Pi reserve for one model: its window minus the fixed compaction point. A window not larger than
 * that has nothing to reserve, so Pi's default applies.
 */
export function compactionReserve(contextWindow: number): number {
  return contextWindow > COMPACT_AT_TOKENS ? contextWindow - COMPACT_AT_TOKENS : PI_DEFAULT_RESERVE;
}

/**
 * Per-model keepRecentTokens for a window that is not above COMPACT_AT_TOKENS: at most half of what
 * is left above Pi's reserve, capped at KEEP_RECENT_TOKENS. Larger windows use the global value.
 */
export function keepRecentFor(contextWindow: number): number | undefined {
  if (contextWindow > COMPACT_AT_TOKENS) return undefined;
  return Math.max(0, Math.min(KEEP_RECENT_TOKENS, Math.floor((contextWindow - PI_DEFAULT_RESERVE) / 2)));
}

/**
 * Models with a known context window, from Pi's models-store.json. Unknown or corrupt entries are
 * skipped. With the Claude Code bridge on, Pi hides `anthropic` and chats use `claude-bridge/<id>`
 * with the same ids and windows, so each anthropic model is also listed under `claude-bridge`.
 */
export function modelWindows(agentDir: string): { provider: string; id: string; contextWindow: number }[] {
  const store = readJson(file(agentDir, "models-store.json"));
  const out: { provider: string; id: string; contextWindow: number }[] = [];
  for (const [provider, entry] of Object.entries(store)) {
    const models = isObj(entry) && Array.isArray(entry.models) ? entry.models : [];
    for (const m of models) {
      if (!isObj(m) || typeof m.id !== "string" || !Number.isSafeInteger(m.contextWindow) || (m.contextWindow as number) <= 0) continue;
      const contextWindow = m.contextWindow as number;
      out.push({ provider, id: m.id, contextWindow });
      if (provider === "anthropic") out.push({ provider: "claude-bridge", id: m.id, contextWindow });
    }
  }
  return out;
}

/** Pi's settings.json read strictly for a write: missing = {}, corrupt = 400 (never overwritten). */
function readSettingsStrict(agentDir: string): Record<string, unknown> {
  const path = file(agentDir, "settings.json");
  if (!existsSync(path)) return {};
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new HttpError(400, "settings.json is not valid JSON, so compaction cannot be written; fix that file first");
  }
  if (!isObj(v)) throw new HttpError(400, "settings.json must be a JSON object");
  return v;
}

/** Pi's settings with the fixed compaction block set. Every other key, and every other model override, is kept. */
function mergeCompaction(settings: Record<string, unknown>, windows: ReturnType<typeof modelWindows>): Record<string, unknown> {
  const prev = isObj(settings.compaction) ? settings.compaction : {};
  const prevOverrides = isObj(prev.modelOverrides) ? prev.modelOverrides : {};
  const modelOverrides: Record<string, unknown> = { ...prevOverrides };
  for (const m of windows) {
    const key = `${m.provider}/${m.id}`;
    const entry: Record<string, unknown> = { ...(isObj(prevOverrides[key]) ? prevOverrides[key] : {}) };
    entry.reserveTokens = compactionReserve(m.contextWindow);
    const keep = keepRecentFor(m.contextWindow);
    if (keep === undefined) delete entry.keepRecentTokens;
    else entry.keepRecentTokens = keep;
    modelOverrides[key] = entry;
  }
  // `enabled` is kept if Pi wrote it, Pi's default (true) otherwise.
  return { ...settings, compaction: { ...prev, enabled: prev.enabled ?? true, keepRecentTokens: KEEP_RECENT_TOKENS, modelOverrides } };
}

/**
 * Writes the fixed compaction block into Pi's settings.json, only when it changed. Runs on every chat
 * start and once at bridge startup, so a model added later is covered without any user action.
 * Returns the block as text: the launch key includes it, because Pi reads settings only at process start.
 * A corrupt settings.json throws 400 and is never overwritten.
 */
export function syncCompaction(agentDir: string): string {
  const path = file(agentDir, "settings.json");
  const next = mergeCompaction(readSettingsStrict(agentDir), modelWindows(agentDir));
  const text = JSON.stringify(next, null, 2);
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
    mkdirSync(agentDir, { recursive: true });
    writeAtomic(path, text);
  }
  return JSON.stringify(next.compaction);
}

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
    else throw new HttpError(400, `unknown config key: ${k}`); // includes `compaction`: fixed by the bridge, not configurable
  }
  if (touched === 0) throw new HttpError(400, "no config given");

  mkdirSync(agentDir, { recursive: true });
  writeOrRemove(file(agentDir, "APPEND_SYSTEM.md"), next.appendSystemPrompt);
  writeOrRemove(file(agentDir, "AGENTS.md"), next.agentsMd);
  writeAtomic(file(agentDir, "cc-config.json"), JSON.stringify({ defaultTools: next.defaultTools, claudeBridge: next.claudeBridge, browser: next.browser }, null, 2));
  writeAtomic(file(agentDir, "cc-gate.json"), JSON.stringify(next.gate, null, 2));
  return next;
}
