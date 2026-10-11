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
import { lastInputTokens } from "../chat/context";
import { Composer } from "../components/chat/Composer";
import { AssistantMessage, UserMessage } from "../components/chat/Message";
import { Sessions } from "../components/chat/Sessions";
import { Icon } from "../components/chat/Icon";
import type { Attachment, ChatConfig, ChatModel, ChatSession, Effort } from "../chat/types";

// Dev mock: installs only when localStorage cc-chat-mock=1 or ?chatmock=1 (no-op otherwise).
installChatMock();

const PHONE_QUERY = "(max-width: 760px)";
const SUGGESTIONS: { title: string; sub: string; prompt: string }[] = [
  { title: "Check unit health", sub: "systemd services on tun-minipc", prompt: "Check the health of the systemd units on tun-minipc." },
  { title: "Summarise today's alerts", sub: "Alerts from the last 24 hours", prompt: "Summarise today's alerts from the last 24 hours." },
  { title: "Restart a service", sub: "Asks Hermes to restart it", prompt: "Restart the service I name, and ask me before running anything." },
  { title: "Explain this log", sub: "Attach a file or paste output", prompt: "Explain this log. I will attach it." },
];

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
  const [prefill, setPrefill] = useState<string | null>(null);
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
  useEffect(() => openChatRunEvents((r: GlobalRun) => onRunRef.current(r)), []);

  useEffect(() => { setLiveModel(null); setLiveEffort(null); setMenu(false); setDrawer(false); }, [activeId]);

  const modelId = liveModel ?? active?.model ?? config?.defaultModel ?? models[0]?.id ?? "";
  const effort = liveEffort ?? active?.effort ?? config?.defaultEffort ?? null;
  const modelRec = models.find(m => m.id === modelId);
  const ctxInput = lastInputTokens(thread.messages);
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
      setPrefill(null);
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
                  <div className="sugg-grid">
                    {SUGGESTIONS.map(s => (
                      <button key={s.title} className="sugg" type="button" onClick={() => setPrefill(s.prompt)}>
                        <span>{s.title}</span><small>{s.sub}</small>
                      </button>
                    ))}
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
            prefill={prefill}
            onPrefillUsed={() => setPrefill(null)}
            onSend={onSend}
            onSteer={onSteer}
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
