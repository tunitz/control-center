import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BridgeConfig } from "./config";
import { readConfig } from "./pi-config";
import { PiProcess } from "./pi-process";

export interface SessionSummary {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
}

// Prefer Pi's own SessionManager.listAll when the installed package is importable; otherwise
// parse the session headers ourselves (same fields, same directory).
export async function listSessions(cfg: BridgeConfig): Promise<SessionSummary[]> {
  const sdk = await loadSdk(cfg);
  if (sdk) {
    try {
      const infos: any[] = await sdk.SessionManager.listAll(cfg.sessionDir);
      return infos
        .map((i) => ({
          path: i.path,
          id: i.id,
          cwd: i.cwd ?? "",
          ...(i.name ? { name: i.name } : {}),
          created: new Date(i.created).toISOString(),
          modified: new Date(i.modified).toISOString(),
          messageCount: i.messageCount ?? 0,
          firstMessage: String(i.firstMessage ?? "").slice(0, 200),
        }))
        .sort((a, b) => b.modified.localeCompare(a.modified));
    } catch {
      // fall through to header parsing
    }
  }
  return parseHeaders(cfg.sessionDir);
}

async function loadSdk(cfg: BridgeConfig): Promise<any | null> {
  const entry = join(cfg.piPackageDir, "dist/index.js");
  if (!existsSync(entry)) return null;
  try {
    return await import(entry);
  } catch {
    return null;
  }
}

export function parseHeaders(dir: string): SessionSummary[] {
  if (!existsSync(dir)) return [];
  const out: SessionSummary[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    const summary = summarize(path);
    if (summary) out.push(summary);
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

function summarize(path: string): SessionSummary | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header?.type !== "session" || typeof header.id !== "string") return null;

  let name: string | undefined;
  let messageCount = 0;
  let firstMessage = "";
  for (const line of lines.slice(1)) {
    let e: any;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session_info" && typeof e.name === "string") name = e.name;
    if (e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant")) {
      messageCount++;
      if (!firstMessage && e.message.role === "user") firstMessage = textOf(e.message.content).slice(0, 200);
    }
  }
  const mtime = statSync(path).mtime;
  return {
    path,
    id: header.id,
    cwd: typeof header.cwd === "string" ? header.cwd : "",
    ...(name ? { name } : {}),
    created: typeof header.timestamp === "string" ? header.timestamp : mtime.toISOString(),
    modified: mtime.toISOString(),
    messageCount,
    firstMessage,
  };
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join(" ");
  }
  return "";
}

// Short-lived `pi --mode rpc --no-session` used when no chat is live, so /models never
// needs a chat and never counts toward the live-process cap.
export async function listModelsOnce(cfg: BridgeConfig, live?: { send(cmd: any, t: number): Promise<any> }): Promise<unknown[]> {
  const claudeBridge = readConfig(cfg.agentDir).claudeBridge && existsSync(cfg.claudeBridgeExtension);
  if (live) {
    const resp = await live.send({ type: "get_available_models" }, cfg.commandTimeoutMs);
    if (!resp.success) throw new Error(resp.error ?? "get_available_models failed");
    return onlyUsableAnthropic(resp.data?.models ?? [], claudeBridge);
  }
  let done: () => void = () => {};
  const exited = new Promise<void>((r) => (done = r));
  const args = ["--mode", "rpc", "--no-session", "--session-dir", cfg.sessionDir];
  // The Claude-bridge models only exist when its extension is loaded, so the probe loads it too.
  if (claudeBridge) args.push("-e", cfg.claudeBridgeExtension);
  const proc = new PiProcess(cfg, join(cfg.workspaceRoot, "_models"), args, {
    onEvent: () => {},
    onExit: () => done(),
  }, { hideAnthropic: claudeBridge });
  try {
    const resp = await proc.send({ type: "get_available_models" }, cfg.commandTimeoutMs);
    if (!resp.success) throw new Error(resp.error ?? "get_available_models failed");
    return onlyUsableAnthropic(resp.data?.models ?? [], claudeBridge);
  } finally {
    await proc.kill(cfg.killGraceMs);
    await exited;
  }
}

/**
 * With the Claude Code bridge on, Pi's native `anthropic` provider is the blocked path *and* reuses
 * the same model ids as the `claude-bridge` provider (claude-sonnet-5-5, …). Consumers key models by
 * id alone, so a duplicate would resolve to the blocked one. Hide it; the claude-bridge entries stay.
 */
export function onlyUsableAnthropic(models: unknown[], claudeBridge: boolean): unknown[] {
  if (!claudeBridge) return models;
  return models.filter((m) => (m as { provider?: unknown } | null)?.provider !== "anthropic");
}
