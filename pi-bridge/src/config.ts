import { homedir } from "node:os";
import { join } from "node:path";

export interface BridgeConfig {
  token: string;
  port: number;
  piBin: string;
  agentDir: string;
  sessionDir: string;
  workspaceRoot: string;
  /** The bridge user's HOME. The directory picker (GET/POST /dirs) never leaves it. */
  homeDir: string;
  piPackageDir: string;
  deepseekApiKey?: string;
  /** Claude subscription token or API key for Pi's Anthropic provider. Passed to Pi only. */
  anthropicOAuthToken?: string;
  anthropicApiKey?: string;
  /** Entry point of the pi-claude-bridge extension, loaded with `-e` when the Claude Code bridge is on. */
  claudeBridgeExtension: string;
  /** Entry point of the cc-browser extension, loaded with `-e` when the browser tools are on. */
  browserExtension: string;
  maxLive: number;
  idleMs: number;
  reapIntervalMs: number;
  ringSize: number;
  commandTimeoutMs: number;
  killGraceMs: number;
}

type Env = Record<string, string | undefined>;

function num(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
  return n;
}

export function loadConfig(env: Env = process.env): BridgeConfig {
  const token = env.PI_BRIDGE_TOKEN ?? "";
  if (token.length < 16) throw new Error("PI_BRIDGE_TOKEN is missing or shorter than 16 characters");
  const home = env.HOME ?? homedir();
  const piHome = env.CC_PI_HOME ?? join(home, ".local/share/cc-pi");
  const agentDir = join(piHome, "agent");
  return {
    token,
    port: num(env, "PI_BRIDGE_PORT", 3050),
    piBin: env.PI_BIN ?? join(home, ".local/bin/pi"),
    agentDir,
    sessionDir: join(agentDir, "sessions"),
    workspaceRoot: join(piHome, "workspace"),
    homeDir: home,
    piPackageDir: join(piHome, "node_modules/@earendil-works/pi-coding-agent"),
    deepseekApiKey: env.DEEPSEEK_API_KEY || undefined,
    anthropicOAuthToken: env.ANTHROPIC_OAUTH_TOKEN || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
    claudeBridgeExtension: env.PI_BRIDGE_CLAUDE_BRIDGE_EXTENSION ?? join(home, ".pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts"),
    browserExtension: env.PI_BRIDGE_BROWSER_EXTENSION ?? join(import.meta.dir, "..", "extensions", "browser.ts"),
    maxLive: num(env, "PI_BRIDGE_MAX_LIVE", 3),
    idleMs: num(env, "PI_BRIDGE_IDLE_MS", 10 * 60_000),
    reapIntervalMs: num(env, "PI_BRIDGE_REAP_MS", 30_000),
    ringSize: num(env, "PI_BRIDGE_RING", 2000),
    commandTimeoutMs: num(env, "PI_BRIDGE_CMD_TIMEOUT_MS", 60_000),
    killGraceMs: num(env, "PI_BRIDGE_KILL_GRACE_MS", 3000),
  };
}
