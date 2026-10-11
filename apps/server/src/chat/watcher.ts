/**
 * Background-subagent watcher. Hermes never pushes a finished subagent to an API client: it writes
 * a transcript row and waits for the next user turn. While a session has dispatched subagents
 * (chat_await), this polls that transcript (plain HTTP, no model tokens). When a result row appears
 * and the session is idle, it starts one internal turn so the agent reports the result by itself.
 * The internal prompt is not stored in the chat; Hermes already holds the result row.
 */
import type { Database } from "bun:sqlite";
import type { HermesClient } from "./hermes";
import { ChatError } from "./http";
import { getModelDef } from "./models";
import { AWAIT_TIMEOUT_MS, type RunManager } from "./runs";
import * as S from "./store";

export const POLL_MS = 5_000;
export const FOLLOW_UP_PROMPT = "[Control Center] A background subagent you dispatched has finished. Its result is in your transcript. Report it to the user now.";
/** Hermes timestamps are seconds; allow a little clock skew against our run start. */
const SKEW_MS = 2_000;
/** Hermes records a dispatch the moment it happens; no dispatch row this long after the turn means there is nothing to wait for. */
const NO_DISPATCH_GRACE_MS = 30_000;

export type WatcherOptions = {
  db: Database;
  hermes: HermesClient;
  runs: RunManager;
  now: () => number;
  pollMs?: number;
};

export class DelegationWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private readonly pollMs: number;

  constructor(private readonly o: WatcherOptions) {
    this.pollMs = o.pollMs ?? POLL_MS;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, this.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every session that is waiting. Safe to call concurrently (extra calls are skipped). */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const row of S.listAwaiting(this.o.db)) await this.check(row);
    } finally {
      this.busy = false;
    }
  }

  private async check(row: S.AwaitRow): Promise<void> {
    const { db, hermes, runs, now } = this.o;
    const s = S.getSession(db, row.sessionId);
    if (!s) { S.clearAwaiting(db, row.sessionId); return; }
    if (now() > row.deadlineMs) {
      S.clearAwaiting(db, row.sessionId);
      runs.emitRun(row.sessionId, s.runId, s.runState);
      return;
    }
    if (!hermes.delegations) return;
    let d;
    try {
      d = await hermes.delegations(row.sessionId);
    } catch {
      return; // Hermes unreachable: try again next tick.
    }
    const since = row.sinceMs - SKEW_MS;
    const dispatched = new Set(d.dispatched.filter(x => x.ts * 1000 >= since).map(x => x.delegationId));
    const recent = d.done.filter(c => c.ts * 1000 >= since);
    const doneIds = new Set(recent.map(c => c.delegationId).filter((x): x is string => !!x));
    const seen = S.seenIds(db, row.sessionId);
    const found = recent.filter(c => !seen.has(c.id));

    // Pending = batches Hermes accepted that have not completed. One batch is one report, whatever its task count,
    // so this is exact; the count taken from the run's tool calls is only a first guess.
    let pending = row.expected - found.length;
    if (dispatched.size > 0) pending = [...dispatched].filter(x => !doneIds.has(x)).length;
    else if (found.length === 0 && now() > row.deadlineMs - AWAIT_TIMEOUT_MS + NO_DISPATCH_GRACE_MS) pending = 0;

    if (found.length === 0) {
      if (pending !== row.expected) {
        S.setAwaiting(db, row.sessionId, pending);
        runs.emitRun(row.sessionId, s.runId, s.runState);
      }
      return;
    }

    // Report only when the session is free; otherwise the next tick retries (nothing consumed yet).
    try { runs.reserve(row.sessionId); } catch (e) { if (e instanceof ChatError) return; throw e; }
    let started = false;
    try {
      S.consumeAwaiting(db, row.sessionId, found.map(c => c.id), pending);
      const reasoning = getModelDef(db, s.model)?.reasoning ? s.effort : null;
      runs.begin(row.sessionId, {
        text: FOLLOW_UP_PROMPT, message: FOLLOW_UP_PROMPT, attachments: [], model: s.model, effort: reasoning, internal: true,
      });
      started = true;
    } finally {
      if (!started) runs.release(row.sessionId);
    }
  }
}
