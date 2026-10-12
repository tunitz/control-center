import { mkdirSync } from "node:fs";
import type { Subprocess } from "bun";
import type { BridgeConfig } from "./config";
import { encodeLine, LfSplitter } from "./jsonl";

export interface PiHandlers {
  onEvent(obj: any): void;
  onExit(code: number | null): void;
}

interface Pending {
  resolve(resp: any): void;
  reject(err: Error): void;
}

// One `pi --mode rpc` child. Owns stdin writes, stdout JSONL parsing, and request/response
// correlation. Events (anything that is not a response to one of our ids) go to onEvent.
export class PiProcess {
  readonly pid: number;
  readonly exited: Promise<number | null>;
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<string, Pending>();
  private seq = 0;
  private closed = false;

  constructor(cfg: BridgeConfig, cwd: string, args: string[], handlers: PiHandlers, opts: { hideAnthropic?: boolean; extraEnv?: Record<string, string> } = {}) {
    mkdirSync(cwd, { recursive: true });
    const cmd = cfg.piBin.endsWith(".ts") ? [process.execPath, cfg.piBin, ...args] : [cfg.piBin, ...args];
    // Only what Pi needs. CC_* and PI_BRIDGE_TOKEN are never passed on, except the explicit extraEnv
    // the tool probe sets (a temp output path for the probe extension; no secret).
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      PI_CODING_AGENT_DIR: cfg.agentDir,
      ...(opts.extraEnv ?? {}),
    };
    if (cfg.deepseekApiKey) env.DEEPSEEK_API_KEY = cfg.deepseekApiKey;
    // Claude Code hits its own auth error when ANTHROPIC_* overrides are exported (pi-claude-bridge
    // issue #107), so the Claude-bridge mode leaves them out and lets it use its ~/.claude login.
    if (!opts.hideAnthropic) {
      if (cfg.anthropicOAuthToken) env.ANTHROPIC_OAUTH_TOKEN = cfg.anthropicOAuthToken;
      if (cfg.anthropicApiKey) env.ANTHROPIC_API_KEY = cfg.anthropicApiKey;
    }

    this.proc = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.pid = this.proc.pid;

    const proc = this.proc;
    const pumped = this.pump(handlers);
    this.drain(proc.stderr);
    this.exited = (async () => {
      const code = await proc.exited;
      await Promise.race([pumped, new Promise((r) => setTimeout(r, 1000))]);
      this.closed = true;
      for (const [id, p] of this.pending) {
        this.pending.delete(id);
        p.reject(new Error("pi process exited"));
      }
      handlers.onExit(code ?? null);
      return code ?? null;
    })();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // Sends a command and resolves with Pi's response object (check `success`).
  send(cmd: Record<string, unknown>, timeoutMs: number): Promise<any> {
    if (this.closed) return Promise.reject(new Error("pi process is not running"));
    const id = `b${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi did not answer ${String(cmd.type)} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.write({ ...cmd, id });
    });
  }

  // Fire-and-forget write (extension_ui_response has no response).
  write(obj: Record<string, unknown>): void {
    if (this.closed) throw new Error("pi process is not running");
    this.proc.stdin.write(encodeLine(obj));
    this.proc.stdin.flush();
  }

  async kill(graceMs: number): Promise<void> {
    if (this.closed) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {}
    const timer = setTimeout(() => {
      try {
        this.proc.kill("SIGKILL");
      } catch {}
    }, graceMs);
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private async pump(handlers: PiHandlers): Promise<void> {
    const splitter = new LfSplitter();
    const reader = this.proc.stdout.getReader();
    const handle = (line: string) => {
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        return; // not JSON: Pi keeps stdout for JSONL only, so just skip
      }
      if (obj && obj.type === "response" && typeof obj.id === "string" && this.pending.has(obj.id)) {
        const p = this.pending.get(obj.id)!;
        this.pending.delete(obj.id);
        p.resolve(obj);
        return;
      }
      if (obj && obj.type !== "response") handlers.onEvent(obj);
    };
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const line of splitter.push(value)) handle(line);
      }
      for (const line of splitter.end()) handle(line);
    } catch {
      // stream torn down with the process
    }
  }

  private async drain(stream: ReadableStream<Uint8Array>): Promise<void> {
    // stderr is not forwarded (it may echo credentials); drain so the pipe never blocks Pi.
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {}
  }
}
