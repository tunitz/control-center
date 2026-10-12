import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridge, type Bridge, type BridgeDeps } from "../src/bridge";
import type { BridgeConfig } from "../src/config";
import type { ProbeLaunch, ToolInfo } from "../src/tools";

export const TOKEN = "test-token-0123456789abcdef";
export const FAKE_PI = join(import.meta.dir, "fake-pi.ts");
/** Stand-in for `pi --mode rpc` that answers /probe-list-tools by writing CC_TOOLS_OUT. */
export const FAKE_PROBE_PI = join(import.meta.dir, "fake-probe-pi.ts");

/** The built-in tools Pi reports with no extension loaded. */
export const BASE_TOOLS: ToolInfo[] = [
  { name: "read", description: "Read the contents of a file." },
  { name: "bash", description: "Execute a bash command." },
  { name: "edit", description: "Edit a file." },
  { name: "write", description: "Write a file." },
  { name: "grep", description: "Search file contents." },
  { name: "find", description: "Find files." },
  { name: "ls", description: "List a directory." },
  { name: "todo_write", description: "Write the todo list." },
  { name: "subagent", description: "Delegate a task to a subagent." },
];
export const BROWSER_TOOLS: ToolInfo[] = [
  { name: "browser_navigate", description: "Open a URL." },
  { name: "browser_snapshot", description: "Snapshot the page." },
];

/** Default probe for tests: the built-ins, plus the browser tools when the browser extension is loaded. */
export const testProbe = async (launch: ProbeLaunch): Promise<ToolInfo[]> =>
  launch.extensions.includes(launch.cfg.browserExtension) ? [...BASE_TOOLS, ...BROWSER_TOOLS] : [...BASE_TOOLS];

export interface Harness {
  base: string;
  token: string;
  cfg: BridgeConfig;
  bridge: Bridge;
  root: string;
  close(): Promise<void>;
}

export function makeConfig(root: string, over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    token: TOKEN,
    port: 0,
    piBin: FAKE_PI,
    agentDir: join(root, "agent"),
    sessionDir: join(root, "sessions"),
    workspaceRoot: join(root, "ws"),
    homeDir: join(root, "home"),
    piPackageDir: join(root, "no-sdk-here"),
    claudeBridgeExtension: join(root, "claude-bridge.ts"),
    browserExtension: join(root, "browser-ext.ts"),
    probeExtension: join(root, "probe-ext.ts"),
    deepseekApiKey: "sk-test-not-a-real-key",
    anthropicOAuthToken: "test-oauth-token",
    anthropicApiKey: undefined,
    maxLive: 50,
    idleMs: 600_000,
    reapIntervalMs: 50,
    ringSize: 2000,
    commandTimeoutMs: 5000,
    killGraceMs: 500,
    ...over,
  };
}

export async function harness(over: Partial<BridgeConfig> = {}, deps: BridgeDeps = {}): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "pi-bridge-test-"));
  mkdirSync(join(root, "sessions"), { recursive: true });
  const cfg = makeConfig(root, over);
  const bridge = createBridge(cfg, { probeTools: testProbe, ...deps });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: bridge.fetch });
  const base = `http://127.0.0.1:${server.port}`;
  return {
    base,
    token: TOKEN,
    cfg,
    bridge,
    root,
    async close() {
      await bridge.shutdown();
      server.stop(true);
    },
  };
}

export async function api(
  h: Pick<Harness, "base" | "token">,
  method: string,
  path: string,
  body?: unknown,
  token: string | null = h.token,
) {
  const headers: Record<string, string> = {};
  if (token !== null) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(h.base + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}

export interface Frame {
  id?: number;
  event: string;
  data: any;
}

export function parseFrame(raw: string): Frame | null {
  let id: number | undefined;
  let event: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue;
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = line.slice(0, i);
    const value = line.slice(i + 1).replace(/^ /, "");
    if (field === "id") id = Number(value);
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!event || data.length === 0) return null;
  return { id, event, data: JSON.parse(data.join("\n")) };
}

// Reads the SSE stream until `until` matches (or the timeout passes). Never throws.
export async function readEvents(
  h: Pick<Harness, "base" | "token">,
  chatId: string,
  opts: { after?: number; until?: (f: Frame) => boolean; timeoutMs?: number; token?: string | null } = {},
): Promise<{ frames: Frame[]; matched: boolean; status: number }> {
  const ac = new AbortController();
  const frames: Frame[] = [];
  let matched = false;
  let status = -1;
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 10_000);
  const headers: Record<string, string> = {};
  const tok = opts.token === undefined ? h.token : opts.token;
  if (tok !== null) headers.authorization = `Bearer ${tok}`;
  try {
    const res = await fetch(`${h.base}/chats/${chatId}/events?after=${opts.after ?? 0}`, {
      headers,
      signal: ac.signal,
    });
    status = res.status;
    if (!res.ok || !res.body) return { frames, matched, status };
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const f = parseFrame(raw);
        if (!f) continue;
        frames.push(f);
        if (opts.until?.(f)) {
          matched = true;
          ac.abort();
          return { frames, matched, status };
        }
      }
    }
  } catch {
    // abort or network end: return what we have
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  return { frames, matched, status };
}

export const settled = (f: Frame) => f.event === "agent_settled";
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
