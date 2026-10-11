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
import type { RunManager } from "./runs";
import * as S from "./store";

export const POLL_MS = 5_000;
export const FOLLOW_UP_PROMPT = "[Control Center] A background subagent you dispatched has finished. Its result is in your transcript. Report it to the user now.";
/** Hermes timestamps are seconds; allow a little clock skew against our run start. */
const SKEW_MS = 2_000;

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
    if (!hermes.completions) return;
    let found;
    try {
      const seen = S.seenIds(db, row.sessionId);
      found = (await hermes.completions(row.sessionId)).filter(c => !seen.has(c.id) && c.ts * 1000 >= row.sinceMs - SKEW_MS);
    } catch {
      return; // Hermes unreachable: try again next tick.
    }
    if (found.length === 0) return;

    // Report only when the session is free; otherwise the next tick retries (nothing consumed yet).
    try { runs.reserve(row.sessionId); } catch (e) { if (e instanceof ChatError) return; throw e; }
    let started = false;
    try {
      S.consumeAwaiting(db, row.sessionId, found.map(c => c.id));
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
