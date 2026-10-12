import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { BridgeConfig } from "./config";
import { PiProcess } from "./pi-process";
import { appendPromptArgs } from "./pi-config";

export interface Frame {
  id?: number;
  event: string;
  data: any;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// One live Pi process plus the per-chat state the bridge keeps for it: the event ring
// (for reconnect replay), live subscribers, and whether a run is active.
export class Chat {
  readonly ring: Frame[] = [];
  readonly subs = new Set<(f: Frame) => void>();
  seq = 0;
  busy = false;
  settledCount = 0;
  lastActivity = Date.now();
  exited = false;
  exitCode: number | null = null;
  sessionFile: string | undefined;
  ready: Promise<void> = Promise.resolve();
  proc: PiProcess | undefined;
  /** What this process was started with (tools + config files). A different key means it must restart. */
  launchKey = "";
  /** The tool list this process was launched with (null = Pi default). */
  launchTools: string[] | null = null;
  /** Ids of questions (confirm/select/input) Pi has asked and nobody has answered yet. */
  pendingUi = new Set<string>();
  private lastAssistant: any = null;

  constructor(
    readonly cfg: BridgeConfig,
    readonly id: string,
    private readonly onGone: (chat: Chat) => void,
  ) {}

  /** The directory the user chose at creation (fixed for the chat's life). null = workspace/<chatId>. */
  chosenCwd: string | null = null;

  get cwd(): string {
    return this.chosenCwd ?? join(this.cfg.workspaceRoot, this.id);
  }

  touch(): void {
    this.lastActivity = Date.now();
  }

  launch(sessionPath?: string, tools?: string[] | null, key = "", skills?: { suppress: boolean; enabled: string[] } | null, opts: { hideAnthropic?: boolean; extensions?: string[] } = {}): void {
    this.launchKey = key;
    this.launchTools = tools && tools.length > 0 ? tools : null;
    const args = ["--mode", "rpc", "--session-dir", this.cfg.sessionDir];
    if (sessionPath) args.push("--session", sessionPath);
    args.push(...appendPromptArgs(this.cfg.agentDir));
    if (tools && tools.length > 0) args.push("--tools", tools.join(","));
    for (const ext of opts.extensions ?? []) args.push("-e", ext);
    // A disabled skill means Pi's own discovery is off; the enabled ones are named explicitly.
    if (skills?.suppress) {
      args.push("--no-skills");
      for (const dir of skills.enabled) args.push("--skill", dir);
    }
    mkdirSync(this.cfg.sessionDir, { recursive: true });
    this.proc = new PiProcess(this.cfg, this.cwd, args, {
      onEvent: (obj) => this.onPiEvent(obj),
      onExit: (code) => this.onExit(code),
    }, { hideAnthropic: opts.hideAnthropic });
    this.ready = this.rawState().then((st) => {
      this.sessionFile = typeof st.sessionFile === "string" ? st.sessionFile : undefined;
    });
  }

  async send(cmd: Record<string, unknown>, timeoutMs?: number): Promise<any> {
    if (!this.proc || this.exited) throw new HttpError(502, "pi process is not running");
    try {
      return await this.proc.send(cmd, timeoutMs ?? this.cfg.commandTimeoutMs);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  }

  // Sends a command that must succeed; maps Pi's own refusal to HTTP.
  async expectOk(cmd: Record<string, unknown>): Promise<any> {
    const resp = await this.send(cmd);
    if (!resp.success) throw rpcError(resp);
    return resp;
  }

  async rawState(): Promise<any> {
    const resp = await this.send({ type: "get_state" });
    if (!resp.success) throw rpcError(resp);
    return resp.data ?? {};
  }

  async state(): Promise<any> {
    return { ...(await this.rawState()), pid: this.proc?.pid };
  }

  write(obj: Record<string, unknown>): void {
    if (!this.proc || this.exited) throw new HttpError(502, "pi process is not running");
    try {
      this.proc.write(obj);
    } catch (e) {
      throw new HttpError(502, (e as Error).message);
    }
  }

  async kill(): Promise<void> {
    await this.proc?.kill(this.cfg.killGraceMs);
  }

  emit(event: string, data: any): Frame {
    const f: Frame = { id: ++this.seq, event, data };
    this.ring.push(f);
    if (this.ring.length > this.cfg.ringSize) this.ring.splice(0, this.ring.length - this.cfg.ringSize);
    for (const s of this.subs) s(f);
    return f;
  }

  private onPiEvent(obj: any): void {
    if (typeof obj.type !== "string") return;
    this.touch();
    let data = obj;
    switch (obj.type) {
      case "extension_ui_request":
        if (typeof obj.id === "string" && ["confirm", "select", "input", "editor"].includes(obj.method)) this.pendingUi.add(obj.id);
        break;
      case "agent_start":
        this.busy = true;
        this.lastAssistant = null;
        break;
      case "message_end":
        if (obj.message?.role === "assistant") this.lastAssistant = obj.message;
        break;
      case "agent_end":
        if (Array.isArray(obj.messages)) {
          const a = [...obj.messages].reverse().find((m: any) => m?.role === "assistant");
          if (a) this.lastAssistant = a;
        }
        break;
      case "agent_settled": {
        // Terminal info comes from the last assistant message, not agent_settled.aborted
        // (the spike did not confirm that flag for aborts).
        const last = this.lastAssistant;
        data = {
          ...obj,
          stopReason: last?.stopReason ?? null,
          errorMessage: last?.errorMessage ?? null,
        };
        this.busy = false;
        this.settledCount++;
        break;
      }
    }
    this.emit(obj.type, data);
  }

  private onExit(code: number | null): void {
    this.exited = true;
    this.exitCode = code;
    this.busy = false;
    this.emit("process_exit", { type: "process_exit", code });
    this.onGone(this);
  }
}

export function rpcError(resp: any): HttpError {
  const msg = typeof resp?.error === "string" ? resp.error : "pi rejected the command";
  return new HttpError(/already processing|streaming/i.test(msg) ? 409 : 502, msg);
}
