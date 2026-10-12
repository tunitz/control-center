// Subagent definitions: <agentDir>/agents/<name>.md = YAML frontmatter + a prompt body.
// Updates edit the frontmatter line by line, so keys the bridge does not manage (extensions,
// inheritSkills when skills are kept, acceptanceRole, defaultContext, output, ...) keep their order
// and text exactly. Writes are atomic (temp file + rename).
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HttpError } from "./chat";
import { TOOL_NAME } from "./pi-config";

export const AGENT_NAME = /^[a-z][a-z0-9-]{0,39}$/;
export const NOTES_MARKER = "<!-- cc:notes -->";
const SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const THINKING_LEVELS = ["", "off", "minimal", "low", "medium", "high", "xhigh", "max"];
const BODY_FIELDS = new Set(["name", "description", "model", "thinking", "instructions", "notes", "tools", "skills"]);
const MAX_DESCRIPTION = 500;
const KEY_LINE = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/;

export interface Agent {
  name: string;
  description: string;
  model: string;
  thinking: string;
  instructions: string;
  notes: string;
  tools: string[];
  skills: string[];
}

export const agentsDir = (agentDir: string) => join(agentDir, "agents");
export const agentPath = (agentDir: string, name: string) => join(agentsDir(agentDir), `${name}.md`);

const bad = (msg: string) => new HttpError(400, msg);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function checkAgentName(name: unknown): string {
  if (typeof name !== "string" || !AGENT_NAME.test(name)) throw bad("agent name must match ^[a-z][a-z0-9-]{0,39}$");
  return name;
}

interface Doc {
  fm: string[];
  body: string;
}

/** Splits `---` frontmatter from the body. No frontmatter: the whole text is the body. */
function splitDoc(text: string): Doc {
  const lines = text.split("\n");
  if (lines[0] !== "---") return { fm: [], body: text };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { fm: [], body: text };
  return { fm: lines.slice(1, end), body: lines.slice(end + 1).join("\n") };
}

/** A frontmatter scalar as read: double-quoted (JSON form) or single-quoted, else as written. */
function scalar(raw: string): string {
  const v = raw.trim();
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1);
    }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

const commaList = (v: string | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0);

function parseAgent(name: string, text: string): Agent {
  const { fm, body } = splitDoc(text);
  const fields = new Map<string, string>();
  for (const line of fm) {
    const m = KEY_LINE.exec(line);
    if (m && !fields.has(m[1])) fields.set(m[1], scalar(m[2]));
  }
  const lines = body.split("\n");
  const at = lines.findIndex((l) => l.trim() === NOTES_MARKER);
  const instructions = (at < 0 ? lines : lines.slice(0, at)).join("\n").trim();
  const notes = at < 0 ? "" : lines.slice(at + 1).join("\n").trim();
  return {
    name,
    description: fields.get("description") ?? "",
    model: fields.get("model") ?? "",
    thinking: fields.get("thinking") ?? "",
    instructions,
    notes,
    tools: commaList(fields.get("tools")),
    skills: commaList(fields.get("skills")),
  };
}

/** All agents in the directory, sorted by name. Files whose name is not a valid agent name are skipped. */
export function listAgents(agentDir: string): Agent[] {
  const dir = agentsDir(agentDir);
  if (!existsSync(dir)) return [];
  const out: Agent[] = [];
  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith(".md")) continue;
    const name = file.slice(0, -3);
    if (!AGENT_NAME.test(name)) continue;
    try {
      out.push(parseAgent(name, readFileSync(join(dir, file), "utf8")));
    } catch {
      // unreadable file: left out of the list, not fatal
    }
  }
  return out;
}

/** Validates a PUT body for agent `name`. Throws HttpError 400. Returns the normalised agent. */
export function parseAgentBody(v: unknown, name: string): Agent {
  if (!isObj(v)) throw bad("body must be an object");
  for (const k of Object.keys(v)) if (!BODY_FIELDS.has(k)) throw bad(`unknown agent field: ${k.slice(0, 40)}`);
  if (v.name !== name) throw bad("name must match the path");
  const line = (val: unknown, what: string): string => {
    if (typeof val !== "string") throw bad(`${what} must be a string`);
    if (/[\r\n]/.test(val)) throw bad(`${what} must be one line`);
    return val;
  };
  const description = line(v.description, "description");
  if (description.trim() === "" || description.length > MAX_DESCRIPTION) throw bad(`description must be 1-${MAX_DESCRIPTION} characters`);
  const model = line(v.model, "model");
  const thinking = line(v.thinking, "thinking");
  if (!THINKING_LEVELS.includes(thinking)) throw bad("thinking must be one of off, minimal, low, medium, high, xhigh, max, or empty");
  if (typeof v.instructions !== "string") throw bad("instructions must be a string");
  const instructions = v.instructions.trim();
  if (instructions === "") throw bad("instructions must not be empty");
  if (instructions.includes(NOTES_MARKER)) throw bad("instructions must not contain the notes marker");
  if (typeof v.notes !== "string") throw bad("notes must be a string");
  const notes = v.notes.trim();
  if (notes.includes(NOTES_MARKER)) throw bad("notes must not contain the notes marker");
  const list = (val: unknown, what: string, ok: RegExp): string[] => {
    if (!Array.isArray(val)) throw bad(`${what} must be a list of names`);
    const seen = new Set<string>();
    for (const t of val) {
      if (typeof t !== "string" || !ok.test(t)) throw bad(`${what}: invalid name ${String(t).slice(0, 40)}`);
      if (seen.has(t)) throw bad(`${what}: duplicate ${t}`);
      seen.add(t);
    }
    return [...seen];
  };
  return {
    name,
    description,
    model,
    thinking,
    instructions,
    notes,
    tools: list(v.tools, "tools", TOOL_NAME),
    skills: list(v.skills, "skills", SKILL_NAME),
  };
}

// Plain scalars as Pi writes them; anything else is double-quoted so YAML reads it back intact.
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9 ._/()@+-]*$/;
const RESERVED = /^(true|false|null|yes|no|on|off|~)$/i;
function scalarOut(v: string): string {
  return PLAIN.test(v) && !/\s$/.test(v) && !RESERVED.test(v) ? v : JSON.stringify(v);
}

/** Lines of `extensions:` (and any indented continuation) from coder.md, copied to new agents. */
function extensionLinesFromCoder(dir: string): string[] {
  const path = join(dir, "coder.md");
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n");
  const at = lines.findIndex((l) => l.startsWith("extensions:"));
  if (at < 0) return [];
  const out = [lines[at]];
  for (let i = at + 1; i < lines.length && /^\s/.test(lines[i]); i++) out.push(lines[i]);
  return out;
}

function bodyText(a: Agent): string {
  let t = `${a.instructions}\n`;
  if (a.notes) t += `\n${NOTES_MARKER}\n\n${a.notes}\n`;
  return t;
}

function render(fm: string[], a: Agent): string {
  return ["---", ...fm, "---", "", bodyText(a)].join("\n");
}

function freshFrontmatter(a: Agent, extensions: string[]): string[] {
  const lines = [`name: ${a.name}`, `description: ${scalarOut(a.description)}`];
  if (a.model) lines.push(`model: ${scalarOut(a.model)}`);
  if (a.thinking) lines.push(`thinking: ${a.thinking}`);
  if (a.tools.length) lines.push(`tools: ${a.tools.join(", ")}`);
  lines.push("systemPromptMode: replace", "inheritProjectContext: false", "inheritSkills: false");
  if (a.skills.length) lines.push(`skills: ${a.skills.join(", ")}`);
  return [...lines, ...extensions];
}

/**
 * Edits the frontmatter of an existing agent. Managed keys are rewritten in place (or removed when
 * empty, or added after `description` when missing). Every other line is kept exactly as it was.
 */
function updateFrontmatter(fm: string[], a: Agent): string[] {
  const want = new Map<string, string | null>([
    ["name", a.name],
    ["description", scalarOut(a.description)],
    ["model", a.model ? scalarOut(a.model) : null],
    ["thinking", a.thinking || null],
    ["tools", a.tools.length ? a.tools.join(", ") : null],
    ["skills", a.skills.length ? a.skills.join(", ") : null],
  ]);
  // No skills means nothing to inherit: inheritSkills must be false. With skills it is left alone.
  if (a.skills.length === 0) want.set("inheritSkills", "false");

  const seen = new Set<string>();
  const out: string[] = [];
  let dropping = false;
  for (const line of fm) {
    const m = KEY_LINE.exec(line);
    if (m) {
      dropping = false;
      const key = m[1];
      if (want.has(key)) {
        seen.add(key);
        const v = want.get(key);
        dropping = true; // the old value's indented continuation lines go with it
        if (v !== null && v !== undefined) out.push(`${key}: ${v}`);
        continue;
      }
      out.push(line);
      continue;
    }
    if (dropping && /^\s/.test(line)) continue;
    dropping = false;
    out.push(line);
  }

  const missing: string[] = [];
  for (const [key, v] of want) if (!seen.has(key) && v !== null) missing.push(`${key}: ${v}`);
  if (missing.length) {
    const anchor = Math.max(out.findIndex((l) => l.startsWith("description:")), out.findIndex((l) => l.startsWith("name:")));
    out.splice(anchor + 1, 0, ...missing);
  }
  return out;
}

function writeAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

/** Creates or updates agent `name` from a PUT body. Returns the saved agent. */
export function saveAgent(agentDir: string, name: unknown, body: unknown): Agent {
  const checked = checkAgentName(name);
  const agent = parseAgentBody(body, checked);
  const dir = agentsDir(agentDir);
  mkdirSync(dir, { recursive: true });
  const path = agentPath(agentDir, checked);
  const text = existsSync(path)
    ? render(updateFrontmatter(splitDoc(readFileSync(path, "utf8")).fm, agent), agent)
    : render(freshFrontmatter(agent, extensionLinesFromCoder(dir)), agent);
  writeAtomic(path, text);
  return agent;
}

/** Removes agent `name`. 404 when it does not exist. */
export function deleteAgent(agentDir: string, name: unknown): void {
  const checked = checkAgentName(name);
  const path = agentPath(agentDir, checked);
  if (!existsSync(path)) throw new HttpError(404, "no such agent");
  unlinkSync(path);
}
