/**
 * Directory picker support for Pi chats: browse HOME, create a folder, and validate a chat's cwd.
 * Everything here is relative to the bridge user's HOME (cfg.homeDir). Symlinks are resolved
 * before any check, so a link cannot lead out of HOME or into a protected folder.
 */
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import type { BridgeConfig } from "./config";
import { HttpError } from "./chat";

/**
 * Protected folders, relative to HOME. A chosen cwd must not be, contain, or sit inside one of these.
 * The list is duplicated from extensions/cc-gate.ts (DEFAULT_POLICY.protectedPaths) on purpose: the gate
 * runs inside Pi's process and works per file. pi-dirs.test.ts checks that every gate entry is covered here.
 */
export const PROTECTED_REL = [".hermes", ".ssh", ".local/share/cc-pi", "projects/control-center/data"];

export type DirEntry = { name: string; path: string };
export type DirListing = { path: string; parent: string | null; entries: DirEntry[] };

const under = (p: string, dir: string): boolean => p === dir || p.startsWith(dir.endsWith(sep) ? dir : dir + sep);

function homeReal(cfg: BridgeConfig): string {
  try {
    return realpathSync(cfg.homeDir);
  } catch {
    throw new HttpError(500, "HOME is not available");
  }
}

/** Absolute protected roots, under the real HOME, plus the Pi agent dir wherever it lives. */
export function protectedRoots(cfg: BridgeConfig): string[] {
  const h = homeReal(cfg);
  const roots = PROTECTED_REL.map((rel) => join(h, rel));
  const agent = resolve(cfg.agentDir);
  try {
    roots.push(realpathSync(agent));
  } catch {
    roots.push(agent);
  }
  return roots;
}

/** A real, existing, non-protected directory inside HOME. Throws 400 otherwise. */
function resolveDir(cfg: BridgeConfig, raw: unknown, what: string): string {
  if (typeof raw !== "string" || !isAbsolute(raw)) throw new HttpError(400, `${what} must be an absolute path`);
  let real: string;
  try {
    real = realpathSync(raw);
  } catch {
    throw new HttpError(400, `${what} does not exist`);
  }
  if (!statSync(real).isDirectory()) throw new HttpError(400, `${what} is not a directory`);
  if (!under(real, homeReal(cfg))) throw new HttpError(400, `${what} is outside HOME`);
  if (protectedRoots(cfg).some((r) => under(real, r))) throw new HttpError(400, `${what} is a protected directory`);
  return real;
}

/** GET /dirs: the subdirectories of `raw` (default HOME). Dot-folders and protected folders are omitted. */
export function listDirs(cfg: BridgeConfig, raw: string | undefined): DirListing {
  const h = homeReal(cfg);
  const dir = raw === undefined ? h : resolveDir(cfg, raw, "path");
  const roots = protectedRoots(cfg);
  let children;
  try {
    children = readdirSync(dir, { withFileTypes: true });
  } catch {
    throw new HttpError(400, "cannot read directory");
  }
  const entries: DirEntry[] = [];
  for (const d of children) {
    if (d.name.startsWith(".")) continue;
    const path = join(dir, d.name);
    let real: string;
    try {
      real = realpathSync(path);
      if (!statSync(real).isDirectory()) continue;
    } catch {
      continue; // broken link
    }
    if (!under(real, h) || roots.some((r) => under(real, r))) continue;
    entries.push({ name: d.name, path });
  }
  entries.sort((a, b) => {
    const x = a.name.toLowerCase();
    const y = b.name.toLowerCase();
    if (x !== y) return x < y ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return { path: dir, parent: dir === h ? null : dirname(dir), entries };
}

function validateName(v: unknown): string {
  if (typeof v !== "string") throw new HttpError(400, "name must be a string");
  if (v.length < 1 || v.length > 64) throw new HttpError(400, "name must be 1-64 characters");
  if (v.includes("/") || v.includes("\0")) throw new HttpError(400, "name cannot contain / or NUL");
  if (v.startsWith(".")) throw new HttpError(400, "name cannot start with .");
  return v;
}

/** POST /dirs: one non-recursive mkdir under a valid parent. 409 if the name exists. */
export function makeDir(cfg: BridgeConfig, parentRaw: unknown, nameRaw: unknown): { path: string; name: string } {
  const name = validateName(nameRaw);
  const parent = resolveDir(cfg, parentRaw, "parent");
  const path = join(parent, name);
  if (protectedRoots(cfg).some((r) => under(path, r))) throw new HttpError(400, "that is a protected directory");
  try {
    mkdirSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new HttpError(409, `${name} already exists`);
    throw new HttpError(400, `cannot create ${name}`);
  }
  return { path, name };
}

/**
 * Validates a chat's cwd. The same rules as GET /dirs, plus: the directory must not contain a protected
 * folder. HOME itself is allowed (its protected children are dot-folders or are only reached by path).
 */
export function chosenCwd(cfg: BridgeConfig, raw: unknown): string {
  const real = resolveDir(cfg, raw, "cwd");
  if (real !== homeReal(cfg) && protectedRoots(cfg).some((r) => under(r, real))) {
    throw new HttpError(400, "cwd cannot contain a protected directory");
  }
  return real;
}
