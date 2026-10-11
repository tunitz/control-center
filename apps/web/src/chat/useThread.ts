import { useCallback, useEffect, useRef, useState } from "react";
import { chat } from "./api";
import { applyEvent, newRunView, type RunView, showReasoning } from "./reduce";
import { openRunStream, type RunStream } from "./sse";
import type { ChatMessage, ChatSession, CommandNote, Effort } from "./types";

type Thread = {
  loading: boolean;
  error: string;
  messages: ChatMessage[];
  /** Persistent local command rows (`/help`, `/model`, …), anchored by seq. */
  commands: CommandNote[];
  hasMore: boolean;
  /** The run this thread is attached to, if any. */
  runId: string | null;
  /** True when the server says this session does not exist (404). */
  missing: boolean;
};

const EMPTY: Thread = { loading: true, error: "", messages: [], commands: [], hasMore: false, runId: null, missing: false };

/** Messages for one session plus the live stream of its active run (if any).
 *  Closing the app mid-run: on return we refetch, then re-attach from the last event we saw. */
export function useThread(sid: string | null, onRunEnd: (sid: string) => void) {
  const [st, setSt] = useState<Thread>(EMPTY);
  const views = useRef(new Map<string, RunView>()); // runId -> view
  const streams = useRef(new Map<string, RunStream>());
  const sidRef = useRef(sid);
  sidRef.current = sid;
  const onEnd = useRef(onRunEnd);
  onEnd.current = onRunEnd;

  const closeAll = useCallback(() => {
    for (const s of streams.current.values()) s.close();
    streams.current.clear();
  }, []);

  const attach = useCallback((runId: string, base: ChatMessage) => {
    const current = streams.current.get(runId);
    if (current) return;
    let view = views.current.get(runId);
    if (!view) { view = newRunView(base); views.current.set(runId, view); }
    if (view.done) return;
    const after = view.lastId;
    const owner = sidRef.current;
    const stream = openRunStream(
      runId,
      after,
      ev => {
        const v = views.current.get(runId);
        if (!v) return;
        const nv = applyEvent(v, ev);
        views.current.set(runId, nv);
        if (sidRef.current !== owner) return;
        setSt(s => ({ ...s, runId, messages: s.messages.map(m => (m.id === nv.message.id ? nv.message : m)) }));
      },
      reason => {
        streams.current.delete(runId);
        if (reason === "done" && owner) onEnd.current(owner);
        // Canonical state after the run: the server copy wins over our reconstruction.
        if (owner && sidRef.current === owner) void reload(owner);
      },
    );
    streams.current.set(runId, stream);
    setSt(s => ({ ...s, runId }));
  }, []);

  const reload = useCallback(async (id: string) => {
    try {
      const page = await chat.messages(id);
      if (sidRef.current !== id) return;
      const running = [...page.messages].reverse().find(m => m.role === "assistant" && m.status === "running" && m.runId);
      // Keep runId while a run is still in progress, so Stop and Steer stay available after a reload.
      setSt(s => ({ ...s, loading: false, error: "", missing: false, messages: page.messages, commands: page.commands, hasMore: page.hasMore, runId: running?.runId ?? null }));
      if (running && running.runId) attach(running.runId, running);
    } catch (e) {
      if (sidRef.current === id) setSt(s => ({ ...s, loading: false, error: (e as Error).message, missing: (e as { status?: number }).status === 404 }));
    }
  }, [attach]);

  // Session switch: drop the old thread and its streams, load the new one.
  useEffect(() => {
    closeAll();
    views.current.clear();
    setSt({ ...EMPTY });
    if (sid) void reload(sid);
    else setSt({ ...EMPTY, loading: false });
    return closeAll;
  }, [sid, closeAll, reload]);

  // Reconnect when the page comes back (bfcache, tab switch, network).
  useEffect(() => {
    const back = () => {
      if (document.visibilityState === "hidden") return;
      const id = sidRef.current;
      if (!id) return;
      void reload(id);
    };
    const hide = () => closeAll();
    window.addEventListener("pageshow", back);
    window.addEventListener("online", back);
    document.addEventListener("visibilitychange", back);
    window.addEventListener("pagehide", hide);
    return () => {
      window.removeEventListener("pageshow", back);
      window.removeEventListener("online", back);
      document.removeEventListener("visibilitychange", back);
      window.removeEventListener("pagehide", hide);
    };
  }, [closeAll, reload]);

  const loadOlder = useCallback(async () => {
    const id = sidRef.current;
    if (!id) return;
    const first = st.messages[0];
    if (!first) return;
    const page = await chat.messages(id, first.seq);
    if (sidRef.current !== id) return;
    setSt(s => ({ ...s, messages: [...page.messages, ...s.messages], hasMore: page.hasMore }));
  }, [st.messages]);

  const send = useCallback(async (args: { sid?: string; text: string; files: File[]; model: string; effort: Effort | null }) => {
    const id = args.sid ?? sidRef.current;
    if (!id) throw new Error("No chat selected");
    const res = await chat.send(id, { text: args.text, model: args.model, effort: args.effort, files: args.files });
    // Another chat was opened while the send was in flight: the reload on switch picks up the running turn.
    if (sidRef.current !== id) return res;
    setSt(s => ({ ...s, messages: [...s.messages, res.userMessage, res.assistantMessage], runId: res.runId }));
    views.current.set(res.runId, newRunView(res.assistantMessage));
    attach(res.runId, res.assistantMessage);
    return res;
  }, [attach]);

  const stop = useCallback(async () => {
    const runId = st.runId;
    if (runId) await chat.stopRun(runId);
  }, [st.runId]);

  /** Rebranch: the server drops this user message and everything after it, then runs it again. */
  const retry = useCallback(async (messageId: string) => {
    const id = sidRef.current;
    if (!id) throw new Error("No chat selected");
    const res = await chat.retryMessage(id, messageId);
    if (sidRef.current !== id) return res;
    // Everything from the new user message's seq on is replaced by the fresh turn.
    setSt(s => ({ ...s, messages: [...s.messages.filter(m => m.seq < res.userMessage.seq), res.userMessage, res.assistantMessage], runId: res.runId }));
    views.current.set(res.runId, newRunView(res.assistantMessage));
    attach(res.runId, res.assistantMessage);
    return res;
  }, [attach]);

  /** Removes one message from the thread (the server drops the mirror row and its files). */
  const remove = useCallback(async (messageId: string) => {
    const id = sidRef.current;
    if (!id) throw new Error("No chat selected");
    await chat.deleteMessage(id, messageId);
    if (sidRef.current !== id) return;
    setSt(s => ({ ...s, messages: s.messages.filter(m => m.id !== messageId) }));
  }, []);

  /** Records a slash-command row on the server and appends it to the thread. */
  const addCommand = useCallback(async (name: string, body: string) => {
    const id = sidRef.current;
    if (!id) throw new Error("No chat selected");
    const cmd = await chat.addCommand(id, name, body);
    if (sidRef.current !== id) return cmd;
    setSt(s => ({ ...s, commands: [...s.commands, cmd] }));
    return cmd;
  }, []);

  return { ...st, loadOlder, send, stop, retry, remove, addCommand, reload: () => sid && reload(sid), runId: st.runId, showReasoning };
}
