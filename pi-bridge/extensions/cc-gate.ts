// cc-gate: Pi extension that asks the user (Approve/Deny in Control Center) before risky tool calls.
// Policy v1 (docs/pi-plan.md T4): ask for risky bash and for write/edit outside the chat workspace,
// and for ANY tool touching a protected path. No answer within the timeout = deny.
// `evaluate` is pure so it can be unit tested without Pi.
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// Structural subset of Pi's ExtensionAPI, so this file typechecks without Pi's types installed here.
interface GateApi {
  on(
    ev: "tool_call",
    fn: (
      event: { toolName: string; input?: unknown },
      ctx: { cwd: string; ui: { confirm(title: string, message: string): Promise<boolean> } },
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void;
}

export interface GatePolicy {
  home: string;
  /** Paths (relative to home) that always need approval, for any tool. */
  protectedPaths: string[];
  /** Regex sources; a bash command matching one runs without asking. */
  bashAllow: string[];
  /** Regex source for risky bash. */
  bashRisky: string;
  timeoutMs: number;
}

export const DEFAULT_POLICY: GatePolicy = {
  home: homedir(),
  protectedPaths: [".hermes", ".ssh", ".local/share/cc-pi/env", ".local/share/cc-pi/agent/auth.json", "projects/control-center/data"],
  bashAllow: [],
  bashRisky: "(^|[\\s;&|(`])(rm|sudo|chmod|chown|curl|wget|ssh|dd|mkfs[.\\w]*)(\\s|$)|>",
  timeoutMs: 120_000,
};

export interface GateDecision {
  confirm: boolean;
  title: string;
  message: string;
}

const RUN: GateDecision = { confirm: false, title: "", message: "" };
const PATH_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);

function expand(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

function abs(p: string, cwd: string, home: string): string {
  const e = expand(p, home);
  return isAbsolute(e) ? resolve(e) : resolve(cwd, e);
}

function under(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir.endsWith("/") ? dir : dir + "/");
}

function protectedHit(p: string, pol: GatePolicy): string | null {
  for (const rel of pol.protectedPaths) {
    if (under(p, resolve(pol.home, rel))) return rel;
  }
  return null;
}

export function evaluate(tool: string, input: Record<string, unknown>, cwd: string, pol: GatePolicy): GateDecision {
  if (tool === "bash") {
    const raw = String(input.command ?? "");
    // `$HOME` and `~` count as the home dir, so protected paths cannot be dodged by spelling.
    const cmd = raw.replace(/\$\{?HOME\}?/g, pol.home).replace(/(^|[\s=:])~(?=\/|\s|$)/g, `$1${pol.home}`);
    for (const rel of pol.protectedPaths) {
      if (cmd.includes(resolve(pol.home, rel))) {
        return { confirm: true, title: "Protected path", message: `Run: ${raw}\n\nTouches ~/${rel}` };
      }
    }
    if (pol.bashAllow.some((r) => new RegExp(r).test(raw))) return RUN;
    // Stderr redirects and /dev/null are not file writes.
    const probe = raw.replace(/\d*>&\d+/g, " ").replace(/\d*>\s*\/dev\/null/g, " ");
    if (new RegExp(pol.bashRisky).test(probe)) {
      return { confirm: true, title: "Allow command?", message: `Run: ${raw}` };
    }
    return RUN;
  }
  if (PATH_TOOLS.has(tool)) {
    const given = String(input.path ?? input.file_path ?? (tool === "read" || WRITE_TOOLS.has(tool) ? "" : "."));
    if (given === "") return RUN;
    const p = abs(given, cwd, pol.home);
    const hit = protectedHit(p, pol);
    if (hit) return { confirm: true, title: "Protected path", message: `${tool}: ${p}\n\nTouches ~/${hit}` };
    if (WRITE_TOOLS.has(tool) && !under(p, resolve(cwd))) {
      return { confirm: true, title: "Write outside workspace", message: `${tool}: ${p}` };
    }
  }
  return RUN;
}

/** Runs `ask`; resolves false if it throws or does not answer within `ms`. */
export async function askWithTimeout(ask: () => Promise<boolean>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deny = new Promise<boolean>((res) => { timer = setTimeout(() => res(false), ms); });
  try {
    return await Promise.race([ask().catch(() => false), deny]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Optional overrides: $PI_CODING_AGENT_DIR/cc-gate.json (same keys as GatePolicy, minus home). */
function loadPolicy(): GatePolicy {
  const dir = process.env.PI_CODING_AGENT_DIR;
  const file = dir ? `${dir}/cc-gate.json` : "";
  if (!file || !existsSync(file)) return DEFAULT_POLICY;
  try {
    const o = JSON.parse(readFileSync(file, "utf8"));
    return {
      ...DEFAULT_POLICY,
      ...(Array.isArray(o.protectedPaths) ? { protectedPaths: o.protectedPaths.map(String) } : {}),
      ...(Array.isArray(o.bashAllow) ? { bashAllow: o.bashAllow.map(String) } : {}),
      ...(typeof o.bashRisky === "string" ? { bashRisky: o.bashRisky } : {}),
      ...(typeof o.timeoutMs === "number" && o.timeoutMs > 0 ? { timeoutMs: o.timeoutMs } : {}),
    };
  } catch {
    return DEFAULT_POLICY; // bad file: fall back to the safe default, never to "allow all"
  }
}

export default function (pi: GateApi) {
  const pol = loadPolicy();
  pi.on("tool_call", async (event, ctx) => {
    const d = evaluate(event.toolName, (event.input ?? {}) as Record<string, unknown>, ctx.cwd, pol);
    if (!d.confirm) return undefined;
    const ok = await askWithTimeout(() => ctx.ui.confirm(d.title, d.message), pol.timeoutMs);
    if (!ok) return { block: true, reason: "Blocked by cc-gate: not approved" };
    return undefined;
  });
}
