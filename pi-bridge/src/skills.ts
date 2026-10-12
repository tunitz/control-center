// Pi skills discovery + enable/disable, owned by the bridge. Pi reads skills only at startup, so
// disabling one is done by launching that chat's Pi process with `--no-skills` plus an explicit
// `--skill` for every skill that stays on. The disabled set lives in <agent>/cc-skills.json; the
// user's skill files are never touched.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync, type Dirent } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { BridgeConfig } from "./config";
import { HttpError } from "./chat";

export type SkillScope = "global" | "project";

export type PiSkill = {
  name: string;
  description: string;
  scope: SkillScope;
  /** Absolute path to the SKILL.md file; stable identity for toggling. */
  path: string;
  /** Skill directory, passed to Pi as `--skill`. */
  dir: string;
  /** The working folder a project skill was found for; null for global skills. */
  cwd: string | null;
  enabled: boolean;
};

const SKILL_FILE = "SKILL.md";
const CONFIG_FILE = "cc-skills.json";
const MAX_DISABLED = 500;
const MAX_PATH = 4096;
const MAX_DEPTH = 8;

/** Launch flags for one chat. null = nothing is disabled, so Pi keeps its own discovery. */
export type SkillLaunch = { suppress: boolean; enabled: string[] } | null;

function unquote(v: string): string {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  return t;
}

/** Minimal frontmatter reader: `key: value`, quoted values, and `|`/`>` block scalars. */
export function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!m) return {};
  const lines = m[1].split(/\r?\n/);
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2] ?? "";
    if (/^[|>][+-]?$/.test(val.trim())) {
      const folded = val.trim().startsWith(">");
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].replace(/^\s+/, ""));
      val = parts.join(folded ? " " : "\n");
    } else {
      val = unquote(val);
    }
    out[kv[1]] = val;
  }
  return out;
}

/** Reads one skill. Pi loads a skill only when both name and description are present. */
function readSkill(skillPath: string, scope: SkillScope, cwd: string | null): Omit<PiSkill, "enabled"> | null {
  let text: string;
  try {
    text = readFileSync(skillPath, "utf8");
  } catch {
    return null;
  }
  const fm = parseFrontmatter(text);
  const name = (fm.name ?? "").trim();
  const description = (fm.description ?? "").trim();
  if (name === "" || description === "") return null;
  return { name, description, scope, path: skillPath, dir: dirname(skillPath), cwd };
}

/** Recursively finds directories holding a SKILL.md. A skill directory is a leaf. */
function scan(root: string, scope: SkillScope, cwd: string | null, out: Map<string, Omit<PiSkill, "enabled">>, depth = 0): void {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  if (entries.some((e) => e.isFile() && e.name === SKILL_FILE)) {
    const s = readSkill(join(root, SKILL_FILE), scope, cwd);
    if (s && !out.has(s.path)) out.set(s.path, s);
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith(".")) scan(join(root, e.name), scope, cwd, out, depth + 1);
  }
}

/** Adds one path from a settings `skills` list: a SKILL.md file, or a directory to scan. */
function scanPath(p: string, scope: SkillScope, cwd: string | null, out: Map<string, Omit<PiSkill, "enabled">>): void {
  try {
    if (!existsSync(p)) return;
    if (statSync(p).isFile()) {
      if (p.endsWith(".md")) {
        const s = readSkill(p, scope, cwd);
        if (s && !out.has(s.path)) out.set(s.path, s);
      }
      return;
    }
    scan(p, scope, cwd, out);
  } catch {
    /* unreadable */
  }
}

/**
 * Skill paths named in `<dir>/settings.json`'s `skills` array, resolved from `dir` (`~` allowed).
 * Glob include/exclude entries (`!`, `+`, `-`) are skipped: discovery covers the default roots.
 */
function settingsSkills(dir: string, home: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  } catch {
    return [];
  }
  const list = raw && typeof raw === "object" && Array.isArray((raw as { skills?: unknown }).skills) ? (raw as { skills: unknown[] }).skills : [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry !== "string" || entry.trim() === "") continue;
    const s = entry.trim();
    if (s.startsWith("!") || s.startsWith("+") || s.startsWith("-")) continue;
    out.push(resolve(dir, s.replace(/^~/, home)));
  }
  return out;
}

/** The one user/global skill root: the shared Agent Skills folder in the home directory (Hermes and Pi both read it). */
export function globalRoots(cfg: BridgeConfig): string[] {
  return [join(cfg.homeDir, ".agents", "skills")];
}

/** Identity of a skill file for matching: its realpath, or the exact path when it cannot be resolved. */
export function canonPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Project skill roots for a working folder: `.pi/skills`, then `.agents/skills` up to the repo root. */
function projectRoots(cwd: string, homeDir: string): string[] {
  const roots = [join(cwd, ".pi", "skills")];
  const home = resolve(homeDir);
  let cur = resolve(cwd);
  // Walk up to the repo root, but never above the home directory (its ~/.agents/skills is the global root).
  // A folder outside home gets only its own .agents/skills.
  const inside = (p: string) => p === home || p.startsWith(home + sep);
  for (;;) {
    if (cur === home) break; // the global root is already scanned
    roots.push(join(cur, ".agents", "skills"));
    if (existsSync(join(cur, ".git")) || !inside(cur)) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return roots;
}

/** Every skill Pi would see for these working folders, with the disabled set applied. */
export function listSkills(cfg: BridgeConfig, cwds: string[]): PiSkill[] {
  const disabled = readSkillsConfig(cfg.agentDir);
  const found = new Map<string, Omit<PiSkill, "enabled">>();
  for (const root of globalRoots(cfg)) scan(root, "global", null, found);
  for (const p of settingsSkills(cfg.agentDir, cfg.homeDir)) scanPath(p, "global", null, found);
  const seen = new Set<string>();
  for (const raw of cwds) {
    let cwd: string;
    try {
      cwd = realpathSync(raw);
    } catch {
      continue;
    }
    if (seen.has(cwd)) continue;
    seen.add(cwd);
    for (const root of projectRoots(cwd, cfg.homeDir)) scan(root, "project", cwd, found);
    for (const p of settingsSkills(join(cwd, ".pi"), cfg.homeDir)) scanPath(p, "project", cwd, found);
  }
  return [...found.values()]
    .map((s) => ({ ...s, enabled: !disabled.has(canonPath(s.path)) }))
    .sort((a, b) => (a.scope === b.scope ? a.name.localeCompare(b.name) : a.scope === "global" ? -1 : 1));
}

/** The launch flags for one working folder. Runs on every start, so it stays cheap. */
export function skillLaunch(cfg: BridgeConfig, cwd: string): SkillLaunch {
  const disabled = readSkillsConfig(cfg.agentDir);
  if (disabled.size === 0) return null;
  const enabled = listSkills(cfg, [cwd])
    .filter((s) => s.enabled)
    .map((s) => s.dir);
  return { suppress: true, enabled };
}

/**
 * A fingerprint of the skills Pi would load for this folder: every SKILL.md with its modified time. A new skill, a
 * deleted one or an edited description changes it. Part of the launch key, so a chat's Pi process (which reads skills
 * only at startup) is restarted on its next message and sees the change, with no command needed.
 */
export function skillsSignature(cfg: BridgeConfig, cwd: string): string {
  return listSkills(cfg, [cwd])
    .map((sk) => {
      let mtime = 0;
      try {
        mtime = Math.round(statSync(sk.path).mtimeMs);
      } catch {
        /* vanished between scan and stat */
      }
      return `${sk.path}@${mtime}`;
    })
    .sort()
    .join("\n");
}

/** Disabled skill paths, keyed by their absolute SKILL.md path. */
export function readSkillsConfig(agentDir: string): Set<string> {
  try {
    const raw = JSON.parse(readFileSync(join(agentDir, CONFIG_FILE), "utf8"));
    const list = raw && Array.isArray(raw.disabled) ? raw.disabled : [];
    return new Set(list.filter((x: unknown): x is string => typeof x === "string" && isAbsolute(x)).map(canonPath));
  } catch {
    return new Set();
  }
}

export function writeSkillsConfig(agentDir: string, disabled: string[]): void {
  mkdirSync(agentDir, { recursive: true });
  const tmp = join(agentDir, `${CONFIG_FILE}.tmp${process.pid}`);
  writeFileSync(tmp, JSON.stringify({ disabled }, null, 2), { mode: 0o600 });
  renameSync(tmp, join(agentDir, CONFIG_FILE));
}

/** Validates a disabled list from a request body. */
export function parseDisabled(v: unknown): string[] {
  if (!Array.isArray(v)) throw new HttpError(400, "disabled must be a list of skill paths");
  if (v.length > MAX_DISABLED) throw new HttpError(400, `at most ${MAX_DISABLED} disabled skills`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string" || x.length > MAX_PATH || !isAbsolute(x) || x.includes("..")) {
      throw new HttpError(400, "each disabled skill must be an absolute path");
    }
    out.push(x);
  }
  return [...new Set(out)];
}
