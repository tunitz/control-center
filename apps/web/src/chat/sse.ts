import type { RunEvent } from "./types";

const TYPES = ["run.started", "delta", "reasoning", "tool.started", "tool.completed", "approval", "usage", "done"] as const;

export type RunStream = { close(): void };

/** Opens a run's SSE from after `afterId`. The browser's own reconnect sends Last-Event-ID; `?last=` covers manual re-attach. */
export function openRunStream(
  runId: string,
  afterId: number,
  onEvent: (ev: RunEvent) => void,
  onEnd: (reason: "done" | "gone") => void,
): RunStream {
  const es = new EventSource(`/api/chat/runs/${encodeURIComponent(runId)}/events?last=${afterId}`);
  let closed = false;
  const close = () => { if (!closed) { closed = true; es.close(); } };
  for (const type of TYPES) {
    es.addEventListener(type, (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      let data: unknown = {};
      try { data = JSON.parse(String(me.data)); } catch { /* keep {} */ }
      onEvent({ id: Number(me.lastEventId) || 0, type, data });
      if (type === "done") { close(); onEnd("done"); }
    });
  }
  es.onerror = () => {
    // CLOSED means the server refused or the run is gone. CONNECTING means the browser retries on its own.
    if (!closed && es.readyState === EventSource.CLOSED) { close(); onEnd("gone"); }
  };
  return { close };
}

export type GlobalRun = { sessionId: string; runId: string | null; state: "running" | "idle" | "needs_approval"; awaiting?: number };

/** Global /api/events, chat.run only. Separate from hooks.ts's shared sample stream (that module is not ours to edit). */
export function openChatRunEvents(onRun: (r: GlobalRun) => void): () => void {
  const es = new EventSource("/api/events");
  es.addEventListener("chat.run", (e: Event) => {
    try { onRun(JSON.parse(String((e as MessageEvent).data))); } catch { /* ignore malformed */ }
  });
  return () => es.close();
}
