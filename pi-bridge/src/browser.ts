// Pure helpers for the cc-browser extension (extensions/browser.ts). Kept Pi-free so bun test can
// import them: the extension itself imports Pi packages that are not installed in this repo.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export type Env = Record<string, string | undefined>;

const AGENT_NAMES = ["agent-browser", "agent-browser-linux-x64"];

function isExec(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
}

/** `<home>/.hermes/tools/<prefix>*` entries, newest name last (the bundled tools, if Hermes is installed). */
function bundled(home: string, prefix: string): string[] {
  const tools = join(home, ".hermes/tools");
  if (!existsSync(tools)) return [];
  try {
    return readdirSync(tools).filter((n) => n.startsWith(prefix)).sort().map((n) => join(tools, n));
  } catch {
    return [];
  }
}

/**
 * The `agent-browser` CLI: `CC_BROWSER_BIN`, else PATH and common bin dirs, else the CLI Hermes
 * bundles on this host. null when nothing is found.
 */
export function resolveAgentBrowser(env: Env, home: string): string | null {
  const explicit = env.CC_BROWSER_BIN;
  if (explicit && isExec(explicit)) return explicit;
  const dirs = (env.PATH ?? "").split(":").filter(Boolean)
    .concat([join(home, ".local/bin"), join(home, ".bun/bin"), join(home, ".npm-global/bin"), "/usr/local/bin"]);
  for (const dir of dirs) for (const name of AGENT_NAMES) {
    const p = join(dir, name);
    if (isExec(p)) return p;
  }
  for (const dir of bundled(home, "agent-browser-")) {
    for (const name of AGENT_NAMES) {
      const p = join(dir, "bin", name);
      if (isExec(p)) return p;
    }
  }
  return null;
}

/**
 * The Chrome/Chromium binary for `AGENT_BROWSER_EXECUTABLE_PATH`. Auto-detection finds Playwright's
 * Chromium, whose shared libraries are often missing on a headless host, so the Chromium Hermes
 * bundles (if present) is preferred. null = let agent-browser auto-detect.
 */
export function resolveChromium(env: Env, home: string): string | null {
  const explicit = env.AGENT_BROWSER_EXECUTABLE_PATH;
  if (explicit && isExec(explicit)) return explicit;
  for (const dir of bundled(home, "chromium-")) {
    const p = join(dir, "chrome-linux64", "chrome");
    if (isExec(p)) return p;
  }
  return null;
}

/** One browser session per Pi process: a Pi process is one chat. */
export const sessionName = (pid: number): string => `cc-${pid}`;

/** Adds the browser env over the Pi child's env, without clobbering an explicit value. */
export function browserEnv(base: Env, chromium: string | null, socketDir: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") env[k] = v;
  if (chromium) env.AGENT_BROWSER_EXECUTABLE_PATH = env.AGENT_BROWSER_EXECUTABLE_PATH || chromium;
  env.AGENT_BROWSER_SOCKET_DIR = socketDir;
  return env;
}

/** Caps command output so one page snapshot cannot flood the context. */
export function cleanOutput(raw: string, limit = 20_000): string {
  const text = raw.trim();
  if (text.length <= limit) return text || "(no output)";
  return `${text.slice(0, limit)}\n\n…[${text.length - limit} chars trimmed]`;
}
