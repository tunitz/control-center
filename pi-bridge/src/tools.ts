// Tool discovery: the tools Pi can offer, asked from Pi itself (built-ins plus every extension tool
// for this launch), not from a hard-coded list. A probe starts `pi --mode rpc` with the same -e
// extensions a chat would get, plus the probe extension, sends /probe-list-tools, reads the answer
// and kills the process (~4 s). The result is cached in memory and on disk, keyed on the launch
// config (extension list and their file mtimes). A stale list is served while a refresh runs.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config";
import { readConfig, TOOL_NAME } from "./pi-config";
import { PiProcess } from "./pi-process";

export interface ToolInfo {
  name: string;
  description: string;
}

/** What one probe launch looks like: the same extensions a chat with this config would get. */
export interface ProbeLaunch {
  cfg: BridgeConfig;
  extensions: string[];
  hideAnthropic: boolean;
}

export type Probe = (launch: ProbeLaunch) => Promise<ToolInfo[]>;

/** Used only when no list was ever discovered and the probe cannot run (the pre-discovery names). */
export const FALLBACK_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls", "todo_write"] as const;
export const TOOLS_CACHE_FILE = "cc-tools-cache.json";
const PROBE_TIMEOUT_MS = 20_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const MAX_DESCRIPTION = 500;

/** Launch config for a probe or a chat: the extensions Pi is given for this config (same rule as chat start). */
export function launchFor(cfg: BridgeConfig, over: { browser?: boolean; claudeBridge?: boolean } = {}): ProbeLaunch {
  const cc = readConfig(cfg.agentDir);
  const claudeBridge = over.claudeBridge ?? cc.claudeBridge;
  const browser = over.browser ?? cc.browser;
  const hideAnthropic = claudeBridge && existsSync(cfg.claudeBridgeExtension);
  const extensions: string[] = [];
  if (hideAnthropic) extensions.push(cfg.claudeBridgeExtension);
  if (browser && existsSync(cfg.browserExtension)) extensions.push(cfg.browserExtension);
  return { cfg, extensions, hideAnthropic };
}

const mtime = (path: string): number => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
};

/** Key for a cached list: a change in the extension list or in any extension file means re-discover. */
export function launchKey(launch: ProbeLaunch): string {
  return JSON.stringify([
    launch.hideAnthropic,
    launch.extensions.map((p) => [p, mtime(p)]),
    [launch.cfg.probeExtension, mtime(launch.cfg.probeExtension)],
  ]);
}

/** Keeps entries with a valid name and a string description; drops duplicates. */
export function cleanTools(list: unknown[]): ToolInfo[] {
  const seen = new Set<string>();
  const out: ToolInfo[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const { name, description } = t as Record<string, unknown>;
    if (typeof name !== "string" || !TOOL_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, description: typeof description === "string" ? description.slice(0, MAX_DESCRIPTION) : "" });
  }
  return out;
}

export interface Snapshot {
  tools: ToolInfo[];
  /** False when the list is the pre-discovery fallback: names then need only match TOOL_NAME. */
  discovered: boolean;
}

/** Name check for defaultTools and per-chat tools, against a snapshot. */
export function toolValidator(snap: Snapshot): (name: string) => boolean {
  if (!snap.discovered) return (name) => TOOL_NAME.test(name);
  const known = new Set(snap.tools.map((t) => t.name));
  return (name) => known.has(name);
}

interface Cache {
  key: string;
  tools: ToolInfo[];
}

function readCache(agentDir: string): Cache | null {
  try {
    const v = JSON.parse(readFileSync(join(agentDir, TOOLS_CACHE_FILE), "utf8"));
    if (typeof v?.key !== "string" || !Array.isArray(v.tools)) return null;
    const tools = cleanTools(v.tools);
    return tools.length > 0 ? { key: v.key, tools } : null;
  } catch {
    return null;
  }
}

function writeCache(agentDir: string, cache: Cache): void {
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, TOOLS_CACHE_FILE);
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cache));
  renameSync(tmp, path);
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`probe did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/** The real probe: a short-lived `pi --mode rpc`, killed once the list is read. */
export async function probePi(launch: ProbeLaunch): Promise<ToolInfo[]> {
  const { cfg } = launch;
  const dir = join(cfg.workspaceRoot, ".probe");
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${randomUUID()}.json`);
  const args = ["--mode", "rpc", "--no-session", "-e", cfg.probeExtension];
  for (const ext of launch.extensions) args.push("-e", ext);
  const proc = new PiProcess(cfg, dir, args, { onEvent: () => {}, onExit: () => {} }, {
    hideAnthropic: launch.hideAnthropic,
    extraEnv: { CC_TOOLS_OUT: out },
  });
  try {
    // The prompt's reply is not needed: the file is the answer. A failed send shows up as no file.
    proc.send({ type: "prompt", message: "/probe-list-tools" }, cfg.commandTimeoutMs).catch(() => {});
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    while (!existsSync(out)) {
      if (proc.isClosed) throw new Error("pi exited before it answered the tool probe");
      if (Date.now() > deadline) throw new Error("tool probe timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
    const parsed = JSON.parse(readFileSync(out, "utf8"));
    if (!Array.isArray(parsed?.tools)) throw new Error("tool probe answered without a tools list");
    return parsed.tools;
  } finally {
    rmSync(out, { force: true });
    await proc.kill(cfg.killGraceMs);
  }
}

export class ToolRegistry {
  private last: Cache | null;
  private inflight: Promise<Cache | null> | null = null;
  private failedAt = 0;

  constructor(private readonly cfg: BridgeConfig, private readonly probe: Probe) {
    this.last = readCache(cfg.agentDir);
  }

  /** Probes for this launch, unless one is already running or the last failure is recent. Null on failure. */
  private refresh(launch: ProbeLaunch): Promise<Cache | null> {
    if (this.inflight) return this.inflight;
    if (Date.now() - this.failedAt < RETRY_AFTER_FAILURE_MS) return Promise.resolve(null);
    const key = launchKey(launch);
    const p: Promise<Cache | null> = (async () => {
      try {
        const tools = cleanTools(await withTimeout(Promise.resolve(this.probe(launch)), PROBE_TIMEOUT_MS));
        if (tools.length === 0) throw new Error("empty tool list");
        const cache = { key, tools };
        this.last = cache;
        this.failedAt = 0;
        try {
          writeCache(this.cfg.agentDir, cache);
        } catch (e) {
          console.error("pi-bridge: tool cache not written:", (e as Error).message);
        }
        return cache;
      } catch (e) {
        this.failedAt = Date.now();
        console.error("pi-bridge: tool discovery failed:", (e as Error).message);
        return null;
      }
    })().finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    this.inflight = p;
    return p;
  }

  private fallback(): Snapshot {
    return { tools: FALLBACK_TOOL_NAMES.map((name) => ({ name, description: "" })), discovered: false };
  }

  /**
   * The tools for a launch with `over` applied.
   * - "wait": a config change (or no list yet) waits for the probe, so a name is checked against the
   *   list the chat will really get. Used for config writes and chat starts.
   * - "swr": serve the last list at once, refresh in the background if the launch changed.
   */
  async snapshot(over: { browser?: boolean; claudeBridge?: boolean }, mode: "wait" | "swr"): Promise<Snapshot> {
    const launch = launchFor(this.cfg, over);
    const key = launchKey(launch);
    if (this.last && this.last.key === key) return { tools: this.last.tools, discovered: true };
    if (mode === "wait" || !this.last) {
      const fresh = await this.refresh(launch);
      if (fresh) return { tools: fresh.tools, discovered: true };
      if (this.last) return { tools: this.last.tools, discovered: true }; // stale, better than nothing
      return this.fallback();
    }
    void this.refresh(launch);
    return { tools: this.last.tools, discovered: true };
  }
}
