import { useCallback, useEffect, useRef, useState } from "react";
import { chat } from "./api";
import type { GlobalRun } from "./sse";
import type { ChatSession, SessionHit } from "./types";

/** Sidebar list for one view (active or archived, optional search). Patches runState from the global chat.run feed. */
export function useSessions(q: string, archived: boolean) {
  const [list, setList] = useState<(ChatSession | SessionHit)[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const reqId = useRef(0);

  const refresh = useCallback(async () => {
    const id = ++reqId.current;
    try {
      const rows = await chat.sessions(q, archived);
      if (id !== reqId.current) return;
      setList(rows);
      setError("");
    } catch (e) {
      if (id === reqId.current) setError((e as Error).message);
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [q, archived]);

  useEffect(() => { setLoading(true); void refresh(); }, [refresh]);

  /** Fed by the page's single chat.run subscription (one /api/events stream for the whole chat view). */
  const onRun = useCallback((r: GlobalRun) => {
    setList(prev => prev.map(s => (s.id === r.sessionId ? { ...s, runState: r.state, runId: r.state === "idle" ? null : r.runId, awaiting: r.awaiting ?? s.awaiting, unread: r.state === "idle" ? true : s.unread } : s)));
    if (r.state === "idle") void refresh();
  }, [refresh]);

  const patch = useCallback((id: string, p: Partial<ChatSession>) => {
    setList(prev => prev.map(s => (s.id === id ? { ...s, ...p } : s)));
  }, []);

  return { list, error, loading, refresh, patch, setList, onRun };
}
