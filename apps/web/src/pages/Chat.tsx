import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../chat.css";
import { chat } from "../chat/api";
import { PickCancelled, folderTag, sessionCreatePayload } from "../chat/dirs";
import { navigate } from "../route";
import { sendEffort } from "../chat/effort";
import { backendOfKey, effortChoices, keyOf, modelUsable, splitKey, swapBackend, viewModels } from "../chat/pi";
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
import { PiSheet } from "../components/chat/PiSheet";
import { FolderSheet } from "../components/chat/FolderSheet";
import { LoginSheet } from "../components/chat/LoginSheet";
import { Icon } from "../components/chat/Icon";
import type { Attachment, Backend, ChatConfig, ChatModel, ChatSession, Effort } from "../chat/types";

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
  const [rawModels, setModels] = useState<ChatModel[]>([]);
  const models = useMemo(() => viewModels(rawModels), [rawModels]);
  const [piSheet, setPiSheet] = useState(false);
  /** `/login [provider]`: null = closed, string (may be empty) = the provider ref to preselect. */
  const [loginAsk, setLoginAsk] = useState<string | null>(null);
  // Pi chats ask for a working folder before they are created. Resolves with the folder, or null for the default workspace.
  const [folderAsk, setFolderAsk] = useState<{ resolve: (cwd: string | null) => void; reject: (e: Error) => void } | null>(null);
  const askFolder = () => new Promise<string | null>((resolve, reject) => setFolderAsk({ resolve, reject }));
  const closeFolderAsk = () => { folderAsk?.reject(new PickCancelled()); setFolderAsk(null); };
  const [piLevels, setPiLevels] = useState<string[] | null>(null);
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

  useEffect(() => { setLiveModel(null); setLiveEffort(null); setMenu(false); setDrawer(false); setPiSheet(false); setLoginAsk(null); }, [activeId]);

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

  const chatBackend: Backend | null = active ? (active.backend ?? "hermes") : null;
  const modelId = liveModel ?? (active ? keyOf(active.backend, active.model) : config?.defaultModel ?? models[0]?.id ?? "");
  const effort = liveEffort ?? active?.effort ?? config?.defaultEffort ?? null;
  const modelRec = models.find(m => m.id === modelId);
  const ctxInput = estimateContextTokens(thread.messages);
  const ctxWindow = backendOfKey(modelId) === "pi" ? undefined : config?.contextWindow[modelId];

  // Pi reports which thinking levels the current model supports; ask while the chat is idle.
  useEffect(() => {
    setPiLevels(null);
    if (!activeId || chatBackend !== "pi" || thread.runId) return;
    let live = true;
    chat.piSettings(activeId).then(r => { if (live) setPiLevels(r.thinkingLevels); }).catch(() => {});
    return () => { live = false; };
  }, [activeId, chatBackend, active?.model, thread.runId]);
  // An effort the model cannot take is dropped rather than sent.
  const effortFor = (): Effort | null => {
    const sent = sendEffort(modelRec, effort);
    return sent && effortChoices(modelRec, piLevels).includes(sent) ? sent : null;
  };

  // Scroll anchoring: follow the bottom unless the user scrolled up.
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(false);
  const lastHeight = useRef(0);
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
  // Follow the bottom only while we are already there. Scrolling up stops it; new content then
  // raises the jump button. Height (not message count) is what grows while a reply streams.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const height = el.scrollHeight;
    const grew = height > lastHeight.current + 1;
    lastHeight.current = height;
    if (!grew && !thread.loading) return;
    if (atBottom) scrollToEnd();
    else if (grew) setUnseen(true);
  }, [thread.messages, thread.loading]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { lastHeight.current = 0; setAtBottom(true); setUnseen(false); }, [activeId]);

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

  /** A new chat takes the backend of the selected model; Hermes is the default. Pi asks for a working folder first. */
  const createChat = async (): Promise<ChatSession> => {
    const { backend, id } = splitKey(modelId);
    const cwd = backend === "pi" ? await askFolder() : null;
    return chat.createSession(sessionCreatePayload({ model: id || undefined, effort: effortFor(), backend, cwd }));
  };

  const newChat = async () => {
    setDrawer(false);
    try {
      const s: ChatSession = await createChat();
      sessions.setList(prev => [s, ...prev]);
      navigate(`#/chat/${encodeURIComponent(s.id)}`);
    } catch (e) { if (!(e instanceof PickCancelled)) setPageErr((e as Error).message); }
  };

  const onSend = async (text: string, files: File[]) => {
    let id = activeId;
    const effortToSend = effortFor();
    if (!id) {
      const s: ChatSession = await createChat(); // a cancelled folder step throws PickCancelled; the composer keeps the text
      sessions.setList(prev => [s, ...prev]);
      navigate(`#/chat/${encodeURIComponent(s.id)}`);
      id = s.id;
    }
    // Pass the id explicitly: on a brand-new chat the thread hook has not seen the new route yet.
    await thread.send({ sid: id, text, files, model: splitKey(modelId).id, effort: effortToSend });
    scrollToEnd();
    void sessions.refresh();
  };

  /** Retries the last user message by rebranching: its old reply is replaced. Shared by `/retry` and the retry button. */
  const retryLast = useCallback(async (): Promise<string> => {
    if (thread.runId) return "Wait for the running task or stop it first.";
    const last = [...thread.messages].reverse().find(m => m.role === "user");
    if (!last || !last.text.trim()) return "No earlier message with text to retry.";
    await thread.retry(last.id);
    return "Retried. The reply that followed was replaced.";
  }, [thread.runId, thread.messages, thread.retry]);

  const onSteer = async (text: string): Promise<"ok" | "finished"> => {
    if (!thread.runId) return "finished";
    try { await chat.steerRun(thread.runId, text); return "ok"; }
    catch (e) { if ((e as { status?: number }).status === 409) return "finished"; throw e; }
  };

  /** Persistent command rows live on the server (`thread.commands`); this only tracks which one is expanded. */
  const [noteOpen, setNoteOpen] = useState<number | null>(null);
  useEffect(() => { setNoteOpen(null); }, [activeId]);
  /** Records a command row on the server so it survives a reload, then reveals it in the thread. */
  const addNote = async (name: string, body: string) => {
    try {
      const cmd = await thread.addCommand(name, body);
      setNoteOpen(cmd.id);
      requestAnimationFrame(() => scrollToEnd());
    } catch (e) {
      setPageErr((e as Error).message);
    }
  };

  /** Runs a page command and returns the text to record in the thread. "" means nothing to show. */
  const runAction = async (name: string, arg: string): Promise<string> => {
    if (name === "credits") return (await chat.credits()).text.split(" | ").join("\n");
    if (name === "steer") {
      if (!arg) return "Usage: /steer <note for the running task>";
      return (await onSteer(arg)) === "ok" ? "Steer sent to the running task." : "Nothing is running.";
    }
    if (!activeId || !active) return "Open a chat first.";
    if (name === "login") {
      if (active.backend !== "pi") return "Only Pi chats can sign in to a provider.";
      setLoginAsk(arg);
      return "";
    }
    if (name === "yolo") {
      if (active.backend !== "pi") return "Only Pi chats ask for approvals.";
      const next = !active.yolo;
      await chat.patchSession(activeId!, { yolo: next });
      sessions.patch(activeId!, { yolo: next });
      return next
        ? "YOLO is on. Pi runs risky commands in this chat without asking, even while the app is closed. Run /yolo again to turn it off."
        : "YOLO is off. Pi asks before risky commands again.";
    }
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
    if (name === "retry") return retryLast();
    return "Unknown command.";
  };

  /** Every command leaves its own row in the thread, so the chat records what ran and what it did. */
  const onAction = async (name: string, arg: string): Promise<string> => {
    const result = await runAction(name, arg);
    if (result.trim() !== "") void addNote(name, result);
    return result;
  };

  const onModel = async (id: string) => {
    const picked = models.find(m => m.id === id);
    if (picked && activeId && swapBackend(picked, chatBackend, { empty: thread.messages.length === 0, loading: thread.loading })) {
      // "New chat" already created a chat on the old backend. Nothing is in it yet, so replace it.
      const old = activeId;
      try {
        const { backend, id: modelId } = splitKey(id);
        const cwd = backend === "pi" ? await askFolder() : null;
        const s: ChatSession = await chat.createSession(sessionCreatePayload({ model: modelId, effort: null, backend, cwd }));
        sessions.setList(prev => [s, ...prev.filter(x => x.id !== old)]);
        navigate(`#/chat/${encodeURIComponent(s.id)}`);
        void chat.deleteSession(old).catch(() => {});
        setLiveModel(id);
      } catch (e) { if (!(e instanceof PickCancelled)) setPageErr((e as Error).message); }
      return;
    }
    if (picked && !modelUsable(picked, chatBackend)) return; // a chat keeps its backend
    setLiveModel(id);
    if (activeId) {
      try { await chat.patchSession(activeId, { model: splitKey(id).id }); } catch (e) { setPageErr((e as Error).message); }
    }
  };
  const onEffort = async (e: Effort) => {
    setLiveEffort(e);
    if (activeId) {
      try { await chat.patchSession(activeId, { effort: e }); } catch (err) { setPageErr((err as Error).message); }
    }
  };

  const onApprove = async (runId: string, approvalId: string, choice: "approve" | "deny") => {
    await chat.approve(runId, approvalId, choice);
  };

  const emptyView = !activeId || (!thread.loading && thread.messages.length === 0);

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

  /** Persistent command rows, grouped like the tool folds so they read as part of the thread. */
  const noteRows = (list: { id: number; name: string; body: string }[]) =>
    list.length === 0 ? null : (
      <div className="fgroup">
        {list.map(n => (
          <div className="fold-wrap" key={n.id}>
            <button type="button" className="fold" aria-expanded={noteOpen === n.id} aria-controls={`note-${n.id}`} onClick={() => setNoteOpen(noteOpen === n.id ? null : n.id)}>
              <Icon name="chevr" className="chev" />
              <Icon name="term" className="i sm" />
              <span className="tname">/{n.name}</span>
              <span className="stat-ok">local</span>
            </button>
            {noteOpen === n.id && <pre className="out" id={`note-${n.id}`} style={{ whiteSpace: "pre-wrap" }}>{n.body}</pre>}
          </div>
        ))}
      </div>
    );

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
            <h1 className="ttl"><span className="ttl-text">{activeId ? title : "New chat"}</span>{active && folderTag(active.cwd) && <span className="ftag" title={folderTag(active.cwd)!.title}>{folderTag(active.cwd)!.label}</span>}</h1>
            <div className="head-right">
              {active?.yolo && <span className="yolo-badge" title="Pi runs risky commands in this chat without asking, even while the app is closed">YOLO</span>}
              {!phone && <div className="pop-wrap">
                <select className="pill" aria-label="Model" value={modelId} disabled={!models.length} onChange={e => void onModel(e.target.value)}
                  style={{ appearance: "none", paddingRight: 12 }}>
                  {models.map(m => (
                    <option key={m.id} value={m.id} disabled={!m.online || !modelUsable(m, chatBackend)}>{m.backend === "pi" ? "Pi · " : ""}{m.provider} · {m.label}{m.online ? "" : " (offline)"}</option>
                  ))}
                </select>
              </div>}
              <div className="pop-wrap">
                <button className="ib" type="button" aria-haspopup="menu" aria-expanded={menu} aria-label="Chat menu" onClick={() => setMenu(m => !m)}>
                  <Icon name="dots" />
                </button>
                {menu && (
                  <div className="pop menu" role="menu">
                    {activeId && active?.backend === "pi" && (
                      <button className="menu-item" role="menuitem" type="button" onClick={() => { setMenu(false); setPiSheet(true); }}><Icon name="gear" className="i sm" />Pi options</button>
                    )}
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
                    <p className="meta" role="note">{backendOfKey(modelId) === "pi" ? "Pi can run commands on this machine and asks before risky ones." : "Hermes can run commands on this machine."}</p>
                  </div>
                </div>
              )}

              {thread.hasMore && !thread.loading && (
                <button className="btn ghost" type="button" style={{ alignSelf: "center" }} onClick={() => void older()}>Load older messages</button>
              )}

              {thread.messages.map(m => (
                <Fragment key={m.id}>
                  {m.role === "user" ? (
                    <UserMessage m={m} onOpenImage={setLightbox}
                      onRetry={!thread.runId ? () => { void thread.retry(m.id).catch(e => setPageErr((e as Error).message)); } : undefined}
                      onDelete={!thread.runId ? () => {
                        if (!window.confirm("Delete this message?")) return;
                        void thread.remove(m.id).catch(e => setPageErr((e as Error).message));
                      } : undefined} />
                  ) : (
                    <AssistantMessage m={m} agent={chatBackend === "pi" ? "Pi" : "Hermes"} onApprove={onApprove} />
                  )}
                  {noteRows(thread.commands.filter(n => n.afterSeq === m.seq))}
                </Fragment>
              ))}

              {/* Command rows whose anchor message is not loaded (paged out) still render, at the end. */}
              {noteRows(thread.commands.filter(n => !thread.messages.some(m => m.seq === n.afterSeq)))}

              {!thread.runId && (active?.awaiting ?? 0) > 0 && (
                <div className="fold static" role="status" aria-live="polite">
                  <span className="spin" aria-hidden="true" />
                  <span className="lbl">{active!.awaiting === 1 ? "1 subagent working" : `${active!.awaiting} subagents working`}. The result will be reported here.</span>
                </div>
              )}
            </div>
          </div>

          <Composer
            phone={phone}
            running={!!thread.runId}
            runId={thread.runId}
            models={models}
            chatBackend={emptyView && !thread.loading ? null : chatBackend}
            piLevels={piLevels}
            model={modelId}
            effort={effort}
            ctxInput={ctxInput}
            ctxWindow={ctxWindow}
            maxUploadMb={config?.maxUploadMb ?? 25}
            onSend={onSend}
            onSteer={onSteer}
            onAction={onAction}
            onNote={addNote}
            jump={{ show: !atBottom, unseen, onJump: scrollToEnd }}
            onStop={() => { thread.stop().catch(e => setPageErr((e as Error).message)); }}
            onNew={() => void newChat()}
            onModel={id => void onModel(id)}
            onEffort={e => void onEffort(e)}
          />
        </section>
      </div>

      {folderAsk && <FolderSheet onPick={cwd => { folderAsk.resolve(cwd); setFolderAsk(null); }} onCancel={closeFolderAsk} />}

      {piSheet && activeId && <PiSheet sid={activeId} running={!!thread.runId} onClose={() => setPiSheet(false)} />}
      {loginAsk !== null && <LoginSheet initial={loginAsk} onClose={() => setLoginAsk(null)} />}

      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label={lightbox.name} onClick={() => setLightbox(null)}
          style={{ position: "fixed", inset: 0, background: "var(--scrim)", display: "grid", placeItems: "center", zIndex: 60, padding: 16 }}>
          <img src={lightbox.url} alt={lightbox.name} style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 12 }} />
        </div>
      )}
    </div>
  );
}
