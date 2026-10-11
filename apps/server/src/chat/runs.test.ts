import { test, expect, beforeEach } from "bun:test";
import { openDb } from "../db";
import { RunManager, recoverRuns } from "./runs";
import type { HermesClient, HermesFrame, ModelOptions, StartRunArgs } from "./hermes";
import { ChatError } from "./http";
import { createChatContext } from "./routes";
import * as S from "./store";

/** A Hermes stream the test drives frame by frame. */
class Stream {
  private q: HermesFrame[] = [];
  private closed = false;
  private err: unknown = null;
  private wake: (() => void) | null = null;
  constructor(readonly runId: string) {}
  push(f: HermesFrame) { this.q.push(f); this.kick(); }
  end() { this.closed = true; this.kick(); }
  fail(e: unknown) { this.err = e; this.kick(); }
  private kick() { const w = this.wake; this.wake = null; w?.(); }
  async *iter(): AsyncGenerator<HermesFrame> {
    while (true) {
      if (this.q.length) { yield this.q.shift()!; continue; }
      if (this.err) throw this.err;
      if (this.closed) return;
      await new Promise<void>(r => (this.wake = r));
    }
  }
}

class Controlled implements HermesClient {
  streams: Stream[] = [];
  stopped: string[] = [];
  steered: { runId: string; message: string }[] = [];
  steerConflict = false;
  startError: Error | null = null;
  gate: Promise<void> | null = null;
  locks: { id: string; model: string; provider: string }[] = [];
  private seq = 0;
  async createSession(): Promise<string> { return "unused"; }
  async deleteSession(): Promise<void> {}
  async lockModel(id: string, model: string, provider: string): Promise<void> { this.locks.push({ id, model, provider }); }
  async modelOptions(): Promise<ModelOptions> { return { unavailable_models: [], providers: [] }; }
  async startRun(args: StartRunArgs): Promise<{ runId: string; frames: AsyncIterable<HermesFrame> }> {
    if (this.gate) await this.gate;
    if (this.startError) throw this.startError;
    this.seq += 1;
    const s = new Stream(`hr-${this.seq}`);
    s.push({ type: "run.started", runId: s.runId, sessionId: args.sessionId, assistantMessageId: "", model: args.model });
    this.streams.push(s);
    return { runId: s.runId, frames: s.iter() };
  }
  async stopRun(runId: string): Promise<void> { this.stopped.push(runId); }
  async steerRun(runId: string, message: string): Promise<void> {
    if (this.steerConflict) throw new ChatError(409, "run finished");
    this.steered.push({ runId, message });
  }
  get last(): Stream { return this.streams[this.streams.length - 1]; }
}

const tick = () => new Promise(r => setTimeout(r, 0));
const done = (status: "complete" | "failed" | "interrupted", error: string | null = null, model: string | null = null): HermesFrame =>
  ({ type: "done", status, error, model });
const delta = (text: string): HermesFrame => ({ type: "delta", text });

let db: ReturnType<typeof openDb>;
let hermes: Controlled;
let emitted: [string, unknown][];
let mgr: RunManager;

beforeEach(() => {
  db = openDb(":memory:");
  hermes = new Controlled();
  emitted = [];
  mgr = new RunManager({ db, hermes, now: () => 1000, emit: (e, d) => emitted.push([e, d]), keepaliveMs: 20 });
  S.createSession(db, { id: "s1", model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
});

const begin = (sid: string, text: string, attachments: S.NewAttachment[] = []) => {
  mgr.reserve(sid);
  return mgr.begin(sid, { text, message: text, attachments, model: "claude-sonnet-5-5", effort: null });
};
const dbEvents = (runId: string) =>
  db.query("SELECT n, type, data FROM chat_run_events WHERE run_id = ? ORDER BY n").all(runId) as { n: number; type: string; data: string }[];
const sseIds = (text: string) => [...text.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]));
const readAll = async (res: Response) => res.text();

test("begin persists user message with attachments and a running assistant placeholder", async () => {
  const att: S.NewAttachment = { id: "a1", kind: "file", name: "n.txt", mime: "text/plain", size: 2, sha256: "h", path: "/x/a1.txt", w: null, h: null };
  const r = begin("s1", "hi", [att]);
  expect(r.userMessage).toMatchObject({ role: "user", text: "hi", status: "complete", seq: 1 });
  expect(r.userMessage!.attachments[0]).toMatchObject({ id: "a1", name: "n.txt" });
  expect(r.assistantMessage).toMatchObject({ role: "assistant", text: "", status: "running", runId: r.runId, seq: 2 });
  expect(S.getSession(db, "s1")).toMatchObject({ runState: "running", runId: r.runId });
  expect(emitted).toContainEqual(["chat.run", { sessionId: "s1", runId: r.runId, state: "running", awaiting: 0 }]);
  await tick();
  hermes.last.push(done("complete")); hermes.last.end();
  await mgr.waitDone(r.runId);
});

test("deltas persist as they arrive; done finalises message, session and emits idle", async () => {
  const r = begin("s1", "please write a long poem about the sea today");
  await tick();
  const s = hermes.last;
  s.push(delta("Hel")); s.push(delta("lo")); await tick();
  expect(S.getMessage(db, r.assistantMessage.id)!.text).toBe("Hello");
  s.push({ type: "reasoning", text: "think" });
  s.push({ type: "usage", input: 5, output: 2 });
  s.push(done("complete", null, "claude-sonnet-5-5"));
  s.end();
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)).toMatchObject({
    text: "Hello", reasoning: "think", status: "complete", usage: { input: 5, output: 2 }, model: "claude-sonnet-5-5", error: null,
  });
  expect(S.getSession(db, "s1")).toMatchObject({ runState: "idle", runId: null, title: "please write a long poem about the sea", titleAuto: true });
  expect(dbEvents(r.runId).map(e => [e.n, e.type])).toEqual([[1, "run.started"], [2, "delta"], [3, "delta"], [4, "reasoning"], [5, "usage"], [6, "done"]]);
  expect(JSON.parse(dbEvents(r.runId).at(-1)!.data)).toEqual({ status: "complete", error: null, model: "claude-sonnet-5-5" });
  expect(emitted.at(-1)).toEqual(["chat.run", { sessionId: "s1", runId: r.runId, state: "idle", awaiting: 0 }]);
});

test("tool.started and tool.completed update the tool row in the message", async () => {
  const r = begin("s1", "run tool");
  await tick();
  const s = hermes.last;
  s.push({ type: "tool.started", id: "t1", name: "terminal", args: { cmd: "ls" }, preview: "ls" });
  await tick();
  expect(S.getMessage(db, r.assistantMessage.id)!.tools).toEqual([
    { id: "t1", name: "terminal", args: { cmd: "ls" }, preview: "ls", status: "running", durationMs: null },
  ]);
  s.push({ type: "tool.completed", id: "t1", ok: true, durationMs: 12, preview: "ok" });
  s.push(done("complete")); s.end();
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)!.tools).toEqual([
    { id: "t1", name: "terminal", args: { cmd: "ls" }, preview: "ok", status: "ok", durationMs: 12 },
  ]);
});

test("approval frame sets needs_approval, does not hang, returns to running on the next frame", async () => {
  const r = begin("s1", "rm things");
  await tick();
  const s = hermes.last;
  s.push({ type: "approval", command: "rm -rf x", note: "needs approval in Hermes" });
  await tick();
  expect(S.getSession(db, "s1")!.runState).toBe("needs_approval");
  expect(emitted).toContainEqual(["chat.run", { sessionId: "s1", runId: r.runId, state: "needs_approval", awaiting: 0 }]);
  expect(dbEvents(r.runId).some(e => e.type === "approval")).toBe(true);
  s.push(delta("ok")); await tick();
  expect(S.getSession(db, "s1")!.runState).toBe("running");
  s.push(done("complete")); s.end();
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)!.status).toBe("complete");
});

test("browser detach does not abort the Hermes stream", async () => {
  const r = begin("s1", "hello");
  await tick();
  const s = hermes.last;
  const sub = mgr.subscribe(r.runId, 0, () => {});
  sub.unsubscribe();
  s.push(delta("A")); s.push(delta("B")); await tick();
  expect(S.getMessage(db, r.assistantMessage.id)!.text).toBe("AB");
  expect(hermes.stopped).toEqual([]);
  s.push(done("complete")); s.end();
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)!.status).toBe("complete");
});

test("subscribe replays from last id out of the ring, then streams live events", async () => {
  const r = begin("s1", "hello");
  await tick();
  const s = hermes.last;
  s.push(delta("a")); s.push(delta("b")); await tick();
  const live: number[] = [];
  const sub = mgr.subscribe(r.runId, 2, ev => live.push(ev.n));
  expect(sub.backlog.map(e => e.n)).toEqual([3]);
  s.push(delta("c")); await tick();
  expect(live).toEqual([4]);
  s.push(done("complete")); s.end();
  await mgr.waitDone(r.runId);
  sub.unsubscribe();
});

test("ring overflow falls back to the DB for replay", async () => {
  const small = new RunManager({ db, hermes, now: () => 1000, ringSize: 2, keepaliveMs: 20 });
  mgr = small;
  const r = begin("s1", "hello");
  await tick();
  const s = hermes.last;
  for (const t of ["a", "b", "c", "d"]) s.push(delta(t));
  await tick();
  const sub = small.subscribe(r.runId, 0, () => {});
  expect(sub.backlog.map(e => e.n)).toEqual([1, 2, 3, 4, 5]);
  sub.unsubscribe();
  s.push(done("complete")); s.end();
  await mgr.waitDone(r.runId);
});

test("eventsResponse: SSE id/event/data lines, Last-Event-ID replay, ends after done", async () => {
  const r = begin("s1", "hello");
  await tick();
  const s = hermes.last;
  s.push(delta("a")); s.push(delta("b")); s.push(done("complete")); s.end();
  await mgr.waitDone(r.runId);
  const res = mgr.eventsResponse(r.runId, null);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const text = await readAll(res);
  expect(text).toContain("id: 1\nevent: run.started\ndata: ");
  expect(text).toContain("event: done\n");
  expect(sseIds(text)).toEqual([1, 2, 3, 4]);
  const replay = await readAll(mgr.eventsResponse(r.runId, "2"));
  expect(sseIds(replay)).toEqual([3, 4]);
  expect(replay).not.toContain("event: run.started");
});

test("eventsResponse sends keepalive comments while the run is open and stops on client cancel", async () => {
  const r = begin("s1", "hello");
  await tick();
  const res = mgr.eventsResponse(r.runId, null);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let seen = "";
  const deadline = Date.now() + 2000;
  while (!seen.includes(": keepalive") && Date.now() < deadline) {
    const { value } = await reader.read();
    seen += dec.decode(value);
  }
  expect(seen).toContain(": keepalive");
  await reader.cancel();
  hermes.last.push(done("complete")); hermes.last.end();
  await mgr.waitDone(r.runId);
});

test("eventsResponse for an unknown run is 404", () => {
  expect(() => mgr.eventsResponse("nope", null)).toThrow(ChatError);
});

test("stop after the Hermes run id is known calls stopRun and ends interrupted", async () => {
  const r = begin("s1", "hello");
  await tick();
  await mgr.stop(r.runId);
  expect(hermes.stopped).toEqual(["hr-1"]);
  hermes.last.push(delta("partial"));
  hermes.last.push(done("complete")); hermes.last.end();
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)).toMatchObject({ status: "interrupted", text: "partial" });
  expect(S.getSession(db, "s1")!.runState).toBe("idle");
});

test("stop before the Hermes run id is known is forwarded once it arrives", async () => {
  let open!: () => void;
  hermes.gate = new Promise<void>(r => (open = r));
  const r = begin("s1", "hello");
  await mgr.stop(r.runId);
  expect(hermes.stopped).toEqual([]);
  open();
  await tick();
  expect(hermes.stopped).toEqual(["hr-1"]);
  hermes.last.push(done("complete")); hermes.last.end();
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)!.status).toBe("interrupted");
});

test("stop on an unknown run is 404; on a finished run it is a no-op", async () => {
  await expect(mgr.stop("nope")).rejects.toMatchObject({ status: 404 });
  const r = begin("s1", "hello");
  await tick();
  hermes.last.push(done("complete")); hermes.last.end();
  await mgr.waitDone(r.runId);
  await mgr.stop(r.runId);
  expect(hermes.stopped).toEqual([]);
});

test("steer forwards to Hermes; 409 'run finished' when Hermes or the manager says finished", async () => {
  const r = begin("s1", "hello");
  await tick();
  await mgr.steer(r.runId, "use pineapple");
  expect(hermes.steered).toEqual([{ runId: "hr-1", message: "use pineapple" }]);
  hermes.steerConflict = true;
  await expect(mgr.steer(r.runId, "again")).rejects.toMatchObject({ status: 409, message: "run finished" });
  hermes.steerConflict = false;
  hermes.last.push(done("complete")); hermes.last.end();
  await mgr.waitDone(r.runId);
  await expect(mgr.steer(r.runId, "late")).rejects.toMatchObject({ status: 409, message: "run finished" });
  expect(hermes.steered.length).toBe(1);
});

test("Hermes start error (non-2xx / unreachable) -> message failed, done failed with error", async () => {
  hermes.startError = new ChatError(502, "hermes stream failed (500)");
  const r = begin("s1", "hello");
  await mgr.waitDone(r.runId);
  expect(S.getMessage(db, r.assistantMessage.id)).toMatchObject({ status: "failed", error: "hermes stream failed (500)" });
  expect(S.getSession(db, "s1")!.runState).toBe("idle");
  expect(JSON.parse(dbEvents(r.runId).at(-1)!.data)).toMatchObject({ status: "failed", error: "hermes stream failed (500)" });
});

test("mid-stream connection error -> done failed; stream ending without done -> failed", async () => {
  const a = begin("s1", "one");
  await tick();
  hermes.last.fail(new Error("ECONNRESET"));
  await mgr.waitDone(a.runId);
  expect(S.getMessage(db, a.assistantMessage.id)).toMatchObject({ status: "failed", error: "hermes connection lost" });

  S.createSession(db, { id: "s2", model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
  mgr.reserve("s2");
  const b = mgr.begin("s2", { text: "two", message: "two", attachments: [], model: "claude-sonnet-5-5", effort: null });
  await tick();
  hermes.last.push(delta("x")); hermes.last.end();
  await mgr.waitDone(b.runId);
  expect(S.getMessage(db, b.assistantMessage.id)).toMatchObject({ status: "failed", error: "stream ended unexpectedly" });
});

test("one active run per session (409 run active) and global cap of 3 (429)", async () => {
  mgr.reserve("s1");
  try { mgr.reserve("s1"); } catch (e) { expect(e).toMatchObject({ status: 409, message: "run active" }); }
  for (const id of ["s2", "s3", "s4"]) S.createSession(db, { id, model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: 1 });
  mgr.reserve("s2");
  mgr.reserve("s3");
  try { mgr.reserve("s4"); throw new Error("expected 429"); } catch (e) { expect(e).toMatchObject({ status: 429, message: "too many active runs" }); }
  mgr.release("s1");
  mgr.reserve("s4");
  expect(mgr.activeCount()).toBe(3);
  mgr.release("s2"); mgr.release("s3"); mgr.release("s4");
  expect(mgr.activeCount()).toBe(0);
});

test("ensureModel locks only when the stored locked model differs", async () => {
  await mgr.ensureModel("s1", "claude-sonnet-5-5", "anthropic");
  await mgr.ensureModel("s1", "claude-sonnet-5-5", "anthropic");
  expect(hermes.locks).toEqual([{ id: "s1", model: "claude-sonnet-5-5", provider: "anthropic" }]);
  await mgr.ensureModel("s1", "deepseek-v4-pro", "deepseek");
  expect(hermes.locks.length).toBe(2);
  expect(S.getLockedModel(db, "s1")).toBe("deepseek-v4-pro");
});

test("ensureModel: a Hermes lock failure is a 502 and the locked model is not updated", async () => {
  hermes.lockModel = async () => { throw new ChatError(502, "hermes model lock failed (500)"); };
  await expect(mgr.ensureModel("s1", "deepseek-v4-pro", "deepseek")).rejects.toMatchObject({ status: 502 });
  expect(S.getLockedModel(db, "s1")).toBeNull();
});

test("restart recovery: running rows become interrupted with a closing done event", () => {
  S.insertMessage(db, { id: "u1", sessionId: "s1", seq: 1, role: "user", text: "q", createdAt: 1, status: "complete", attachments: [] });
  S.insertMessage(db, { id: "a1", sessionId: "s1", seq: 2, role: "assistant", text: "half", createdAt: 2, status: "running", runId: "old-run", attachments: [] });
  db.query("UPDATE chat_sessions SET run_state='running', run_id='old-run' WHERE id='s1'").run();
  recoverRuns(db, 5000);
  expect(S.getMessage(db, "a1")).toMatchObject({ status: "interrupted", text: "half" });
  expect(S.getSession(db, "s1")).toMatchObject({ runState: "idle", runId: null });
  expect(dbEvents("old-run").map(e => [e.n, e.type])).toEqual([[1, "done"]]);
  expect(JSON.parse(dbEvents("old-run")[0].data)).toMatchObject({ status: "interrupted" });
  recoverRuns(db, 6000);
  expect(dbEvents("old-run").length).toBe(1);
  const res = new RunManager({ db, hermes, now: () => 1 }).eventsResponse("old-run", null);
  return readAll(res).then(t => expect(t).toContain("event: done"));
});

test("createChatContext runs restart recovery at construction", () => {
  S.insertMessage(db, { id: "a9", sessionId: "s1", seq: 1, role: "assistant", text: "", createdAt: 2, status: "running", runId: "boot-run", attachments: [] });
  db.query("UPDATE chat_sessions SET run_state='running', run_id='boot-run' WHERE id='s1'").run();
  createChatContext(db, { env: { CHAT_FAKE_HERMES: "1", CHAT_UPLOAD_DIR: "/tmp/cu" } });
  expect(S.getMessage(db, "a9")!.status).toBe("interrupted");
  expect(S.getSession(db, "s1")!.runState).toBe("idle");
});
