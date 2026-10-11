import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../chat.css";
import { chat } from "../chat/api";
import { navigate } from "../route";
import { sendEffort } from "../chat/effort";
import { installChatMock } from "../chat/mock";
import { useThread } from "../chat/useThread";
import { useSessions } from "../chat/useSessions";
import { useVisualViewportHeight } from "../chat/viewport";
import { openChatRunEvents, type GlobalRun } from "../chat/sse";
import { estimateContextTokens } from "../chat/context";
import { forgetChat, rememberChat } from "../chat/last";
import { Composer } from "../components/chat/Composer";
import { AssistantMessage, UserMessage } from "../components/chat/Message";
import { Sessions } from "../components/chat/Sessions";
import { Icon } from "../components/chat/Icon";
import type { Attachment, ChatConfig, ChatModel, ChatSession, Effort } from "../chat/types";

// Dev mock: installs only when localStorage cc-chat-mock=1 or ?chatmock=1 (no-op otherwise).
installChatMock();

const PHONE_QUERY = "(max-width: 760px)";

function useIsPhone(): boolean {
  const [phone, setPhone] = useState(() => matchMedia(PHONE_QUERY).matches);
  useEffect(() => {
    const mq = matchMedia(PHONE_QUERY);
    const f = () => setPhone(mq.matches);
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);
  return phone;
}

function routeId(hash: string): string | null {
  const m = /^#\/chat\/([^/?#]+)/.exec(hash);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function Chat({ hash }: { hash: string }) {
  const phone = useIsPhone();
  const rootRef = useRef<HTMLDivElement>(null);
  useVisualViewportHeight(rootRef, true);
  const activeId = routeId(hash);

  const [query, setQuery] = useState("");
  const [archived, setArchived] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [config, setConfig] = useState<ChatConfig | null>(null);
  const [pageErr, setPageErr] = useState("");
  const [lightbox, setLightbox] = useState<Attachment | null>(null);
  const [menu, setMenu] = useState(false);

  const sessions = useSessions(query, archived);
  const active = sessions.list.find(s => s.id === activeId) ?? null;

  const onRunEnd = useCallback((sid: string) => {
    sessions.patch(sid, { runState: "idle", runId: null, unread: sid !== activeId });
    void sessions.refresh();
  }, [sessions, activeId]);
  const thread = useThread(activeId, onRunEnd);
  const [liveModel, setLiveModel] = useState<string | null>(null);
  const [liveEffort, setLiveEffort] = useState<Effort | null>(null);

  useEffect(() => {
    void Promise.all([chat.models(), chat.config()])
      .then(([m, c]) => { setModels(m); setConfig(c); })
      .catch(e => setPageErr((e as Error).message));
  }, []);

  // One chat.run feed for the whole page; sidebar badges come from it. The ref keeps the feed open across list changes.
  const onRunRef = useRef(sessions.onRun);
  onRunRef.current = sessions.onRun;
  const reloadRef = useRef<() => void>(() => {});
  reloadRef.current = () => { void thread.reload(); };
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const attachedRef = useRef<string | null>(null);
  attachedRef.current = thread.runId;
  useEffect(() => openChatRunEvents((r: GlobalRun) => {
    onRunRef.current(r);
    // A turn the server started on its own (reporting a finished subagent): attach to it.
    if (r.state === "running" && r.sessionId === activeRef.current && r.runId && r.runId !== attachedRef.current) reloadRef.current();
  }), []);

  useEffect(() => { setLiveModel(null); setLiveEffort(null); setMenu(false); setDrawer(false); }, [activeId]);

  // Remember the session on screen so the Chat tab can return to it; drop it if the server says it is gone.
  useEffect(() => {
    if (!activeId) return;
    if (thread.missing) {
      forgetChat(localStorage, activeId);
      navigate("#/chat");
    } else {
      rememberChat(localStorage, activeId);
    }
  }, [activeId, thread.missing]);

  const modelId = liveModel ?? active?.model ?? config?.defaultModel ?? models[0]?.id ?? "";
  const effort = liveEffort ?? active?.effort ?? config?.defaultEffort ?? null;
  const modelRec = models.find(m => m.id === modelId);
  const ctxInput = estimateContextTokens(thread.messages);
  const ctxWindow = config?.contextWindow[modelId];

  // Scroll anchoring: follow the bottom unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const lastCount = useRef(0);
  const scrollToEnd = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true); setUnseen(false);
  }, []);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAtBottom(near);
    if (near) setUnseen(false);
  };
  useLayoutEffect(() => {
    const n = thread.messages.length;
    const grew = n > lastCount.current;
    lastCount.current = n;
    if (!grew && !thread.loading) return;
    if (atBottom) scrollToEnd();
    else if (grew) setUnseen(true);
  }, [thread.messages, thread.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { lastCount.current = 0; setAtBottom(true); }, [activeId]);

  const older = async () => {
    const el = scrollRef.current;
    const before = el ? el.scrollHeight : 0;
    await thread.loadOlder();
    requestAnimationFrame(() => { if (el) el.scrollTop += el.scrollHeight - before; });
  };

  const openSession = (id: string) => {
    setDrawer(false);
    navigate(`#/chat/${encodeURIComponent(id)}`);
  };

  const newChat = async () => {
    setDrawer(false);
    try {
      const s: ChatSession = await chat.createSession({ model: modelId || undefined, effort: sendEffort(modelRec, effort) });
      sessions.setList(prev => [s, ...prev]);
      navigate(`#/chat/${encodeURIComponent(s.id)}`);
    } catch (e) { setPageErr((e as Error).message); }
  };

  const onSend = async (text: string, files: File[]) => {
    let id = activeId;
    const effortToSend = sendEffort(modelRec, effort);
    if (!id) {
      const s: ChatSession = await chat.createSession({ model: modelId || undefined, effort: effortToSend });
      sessions.setList(prev => [s, ...prev]);
      navigate(`#/chat/${encodeURIComponent(s.id)}`);
      id = s.id;
    }
    // Pass the id explicitly: on a brand-new chat the thread hook has not seen the new route yet.
    await thread.send({ sid: id, text, files, model: modelId, effort: effortToSend });
    scrollToEnd();
    void sessions.refresh();
  };

  const onSteer = async (text: string): Promise<"ok" | "finished"> => {
    if (!thread.runId) return "finished";
    try { await chat.steerRun(thread.runId, text); return "ok"; }
    catch (e) { if ((e as { status?: number }).status === 409) return "finished"; throw e; }
  };

  const onAction = async (name: string, arg: string): Promise<string> => {
    if (name === "steer") {
      if (!arg) return "Usage: /steer <note for the running task>";
      return (await onSteer(arg)) === "ok" ? "Steer sent to the running task." : "Nothing is running.";
    }
    if (!activeId || !active) return "Open a chat first.";
    if (name === "export") { window.location.href = chat.exportUrl(activeId); return "Downloading the chat."; }
    if (name === "title") {
      if (!arg) return "Usage: /title <new name>";
      await chat.patchSession(activeId, { title: arg }); sessions.patch(activeId, { title: arg, titleAuto: false }); return "Renamed.";
    }
    if (name === "pin") { await chat.patchSession(activeId, { pinned: !active.pinned }); sessions.patch(activeId, { pinned: !active.pinned }); return active.pinned ? "Unpinned." : "Pinned."; }
    if (name === "archive") {
      await chat.patchSession(activeId, { archived: !active.archived }); void sessions.refresh();
      if (!active.archived) navigate("#/chat");
      return active.archived ? "Restored." : "Archived.";
    }
    if (name === "delete") {
      if (thread.runId) return "Stop the running task first.";
      if (!window.confirm(`Delete "${active.title || "this chat"}"? This cannot be undone.`)) return "Not deleted.";
      await chat.deleteSession(activeId);
      sessions.setList(prev => prev.filter(s => s.id !== activeId)); forgetChat(localStorage, activeId); navigate("#/chat");
      return "Deleted.";
    }
    if (name === "retry") {
      if (thread.runId) return "Wait for the running task or stop it first.";
      const last = [...thread.messages].reverse().find(m => m.role === "user");
      if (!last || !last.text.trim()) return "No earlier message with text to resend.";
      await onSend(last.text, []);
      return "Sent again.";
    }
    return "Unknown command.";
  };

  const onModel = async (id: string) => {
    setLiveModel(id);
    if (activeId) {
      try { await chat.patchSession(activeId, { model: id }); } catch (e) { setPageErr((e as Error).message); }
    }
  };
  const onEffort = async (e: Effort) => {
    setLiveEffort(e);
    if (activeId) {
      try { await chat.patchSession(activeId, { effort: e }); } catch (err) { setPageErr((err as Error).message); }
    }
  };

  const emptyView = !activeId || (!thread.loading && thread.messages.length === 0);
  const approvalsFor = (id: string) => thread.approvals[id] ?? [];

  const sidebarProps = {
    list: sessions.list,
    activeId,
    query,
    archived,
    onQuery: setQuery,
    onToggleArchived: () => setArchived(a => !a),
    onOpen: openSession,
    onNew: newChat,
    onChanged: () => void sessions.refresh(),
    onPatch: sessions.patch,
    onDeleted: (id: string) => {
      sessions.setList(prev => prev.filter(s => s.id !== id));
      forgetChat(localStorage, id);
      if (id === activeId) navigate("#/chat");
    },
    onError: setPageErr,
    onClose: phone ? () => setDrawer(false) : undefined,
  };

  const title = active?.title || "New chat";

  return (
    <div ref={rootRef} className={`chatx${phone ? " phone" : ""}`}>
      <div className="shell">
        <aside className={`side${drawer ? " open" : ""}`} aria-label="Chat sessions">
          <Sessions {...sidebarProps} />
        </aside>
        {phone && drawer && <button className="scrim" type="button" aria-label="Close sessions" onClick={() => setDrawer(false)} />}

        <section className="main" aria-label="Chat thread">
          <div className="thread-head">
            <button className="ib sess-toggle" type="button" aria-label="Chats" aria-expanded={drawer} onClick={() => setDrawer(d => !d)}>
              <Icon name="menu" />
            </button>
            <h1 className="ttl"><span className="ttl-text">{activeId ? title : "New chat"}</span></h1>
            <div className="head-right">
              {!phone && <div className="pop-wrap">
                <select className="pill" aria-label="Model" value={modelId} disabled={!models.length} onChange={e => void onModel(e.target.value)}
                  style={{ appearance: "none", paddingRight: 12 }}>
                  {models.map(m => (
                    <option key={m.id} value={m.id} disabled={!m.online}>{m.provider} · {m.label}{m.online ? "" : " (offline)"}</option>
                  ))}
                </select>
              </div>}
              <div className="pop-wrap">
                <button className="ib" type="button" aria-haspopup="menu" aria-expanded={menu} aria-label="Chat menu" onClick={() => setMenu(m => !m)}>
                  <Icon name="dots" />
                </button>
                {menu && (
                  <div className="pop menu" role="menu">
                    {activeId && <a className="menu-item" role="menuitem" href={chat.exportUrl(activeId)}><Icon name="export" className="i sm" />Export (Markdown)</a>}
                    <div className="menu-sep" />
                    <p className="meta" style={{ padding: "6px 10px" }}>
                      Default model: {config?.defaultModel ?? "…"}
                      <br />Default thinking: {config?.defaultEffort ?? "off"}
                      <br />Set on the server. Changes here apply to this chat only.
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="thread-scroll" ref={scrollRef} onScroll={onScroll}>
            <div className="col">
              {pageErr && <p className="err-row" role="alert">{pageErr}</p>}
              {thread.error && <p className="err-row" role="alert">Could not load this chat: {thread.error}</p>}

              {emptyView && !thread.loading && (
                <div className="empty">
                  <div className="empty-head">
                    <h2>What can I help with?</h2>
                    <p className="meta" role="note">Hermes can run commands on this machine.</p>
                  </div>
                </div>
              )}

              {thread.hasMore && !thread.loading && (
                <button className="btn ghost" type="button" style={{ alignSelf: "center" }} onClick={() => void older()}>Load older messages</button>
              )}

              {thread.messages.map(m =>
                m.role === "user" ? (
                  <UserMessage key={m.id} m={m} onOpenImage={setLightbox} />
                ) : (
                  <AssistantMessage key={m.id} m={m} pending={approvalsFor(m.id)} />
                ),
              )}

              {!thread.runId && (active?.awaiting ?? 0) > 0 && (
                <div className="fold static" role="status" aria-live="polite">
                  <span className="spin" aria-hidden="true" />
                  <span className="lbl">{active!.awaiting === 1 ? "1 subagent working" : `${active!.awaiting} subagents working`}. The result will be reported here.</span>
                </div>
              )}
            </div>
          </div>

          {unseen && !atBottom && (
            <button className="jump" type="button" onClick={scrollToEnd}>Jump to latest</button>
          )}

          <Composer
            phone={phone}
            running={!!thread.runId}
            runId={thread.runId}
            models={models}
            model={modelId}
            effort={effort}
            ctxInput={ctxInput}
            ctxWindow={ctxWindow}
            maxUploadMb={config?.maxUploadMb ?? 25}
            onSend={onSend}
            onSteer={onSteer}
            onAction={onAction}
            onStop={() => { thread.stop().catch(e => setPageErr((e as Error).message)); }}
            onNew={() => void newChat()}
            onModel={id => void onModel(id)}
            onEffort={e => void onEffort(e)}
          />
        </section>
      </div>

      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label={lightbox.name} onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, background: "var(--scrim)", display: "grid", placeItems: "center", zIndex: 60, padding: 16 }}>
          <img src={lightbox.url} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}
