/**
 * In-memory, deterministic HermesClient for tests and for CHAT_FAKE_HERMES=1.
 * Run behaviour is scripted from the user message text:
 *   "run tool"      -> tool.started / tool.completed frames
 *   "think"         -> reasoning frame
 *   "please fail"   -> done{status:failed}
 *   "interrupt me" -> done{status:interrupted}
 *   anything else   -> deltas "Hello" + " world", usage, done{complete}
 */
import { ChatError } from "./http";
import type { HermesClient, HermesFrame, ModelOptions, StartRunArgs, ContentPart } from "./hermes";

export type FakeOptions = {
  modelOptions?: ModelOptions;
  modelOptionsError?: string;
};

const DEFAULT_OPTIONS: ModelOptions = {
  unavailable_models: [],
  providers: [
    { id: "anthropic", authenticated: true },
    { id: "deepseek", authenticated: true },
    { id: "openai-codex", authenticated: true },
    { id: "custom:local-llama", authenticated: true },
  ],
};

type RunState = { sessionId: string; model: string; stopped: boolean; finished: boolean; steers: string[] };

export class FakeHermes implements HermesClient {
  sessions = new Set<string>();
  locks: { id: string; model: string; provider: string }[] = [];
  deleted: string[] = [];
  steered: { runId: string; message: string }[] = [];
  lockFails = false;

  private seq = 0;
  private runSeq = 0;
  private runs = new Map<string, RunState>();
  private opts: FakeOptions;

  constructor(opts: FakeOptions = {}) {
    this.opts = opts;
  }

  async createSession(): Promise<string> {
    this.seq += 1;
    const id = `fake-${this.seq}`;
    this.sessions.add(id);
    return id;
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    this.deleted.push(id);
  }

  async lockModel(id: string, model: string, provider: string): Promise<void> {
    if (this.lockFails) throw new ChatError(502, "lock failed");
    this.locks.push({ id, model, provider });
  }

  async modelOptions(): Promise<ModelOptions> {
    if (this.opts.modelOptionsError) throw new Error(this.opts.modelOptionsError);
    return this.opts.modelOptions ?? DEFAULT_OPTIONS;
  }

  async startRun(args: StartRunArgs): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }> {
    this.runSeq += 1;
    const runId = `fake-run-${this.runSeq}`;
    const state: RunState = { sessionId: args.sessionId, model: args.model, stopped: false, finished: false, steers: [] };
    this.runs.set(runId, state);
    const text = typeof args.message === "string" ? args.message : textOf(args.message);
    return { runId, frames: this.frames(runId, state, text) };
  }

  async stopRun(runId: string): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new ChatError(404, "run not found");
    r.stopped = true;
  }

  async steerRun(runId: string, message: string): Promise<void> {
    const r = this.runs.get(runId);
    if (!r) throw new ChatError(404, "run not found");
    if (r.finished) throw new ChatError(409, "run finished");
    r.steers.push(message);
    this.steered.push({ runId, message });
  }

  private async *frames(runId: string, r: RunState, text: string): AsyncGenerator<HermesFrame> {
    const started: HermesFrame = {
      type: "run.started", runId, sessionId: r.sessionId, assistantMessageId: `${runId}-asst`, model: r.model,
    };
    yield started;

    const body: HermesFrame[] = [];
    let terminal: "complete" | "failed" | "interrupted" = "complete";
    let error: string | null = null;

    if (text.includes("think")) body.push({ type: "reasoning", text: "considering" });
    if (text.includes("run tool")) {
      body.push({ type: "tool.started", id: "t1", name: "terminal", args: { cmd: "ls" }, preview: "ls" });
      body.push({ type: "tool.completed", id: "t1", ok: true, durationMs: 12, preview: "ok" });
    }
    if (text.includes("please fail")) { terminal = "failed"; error = "scripted failure"; }
    if (text.includes("interrupt me")) terminal = "interrupted";
    if (terminal === "complete") {
      body.push({ type: "delta", text: "Hello" }, { type: "delta", text: " world" });
      body.push({ type: "usage", input: 10, output: 2 });
    }

    for (const f of body) {
      if (r.stopped) break;
      await Promise.resolve();
      yield f;
    }
    if (r.stopped) terminal = "interrupted";
    r.finished = true;
    yield { type: "done", status: terminal, error: terminal === "failed" ? error : null, model: r.model };
  }
}

function textOf(parts: ContentPart[]): string {
  return parts.map(p => (p.type === "text" ? p.text : "")).join(" ");
}
