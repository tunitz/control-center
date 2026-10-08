import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { parseSse, applyEvent, initialStream, toViewMessages, sessionLabel, modelChoices, modelGroups, reasoningOptions, REASONING_CHOICES, type ModelChoice, type ModelGroup, type StreamState, type ViewMessage } from "../chatStream";

type Session = { id: string; title: string | null; preview: string | null; last_active: number | null; message_count: number };

export default function Chat() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [messages, setMessages] = useState<ViewMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [stream, setStream] = useState<StreamState>(initialStream);
  const [pending, setPending] = useState<string>("");
  const [err, setErr] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const abort = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [more, setMore] = useState(false);
  const [models, setModels] = useState<ModelChoice[]>([]);
  const [groups, setGroups] = useState<ModelGroup[]>([]);
  const [providerSlug, setProviderSlug] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [modelErr, setModelErr] = useState("");
  const bottom = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    api<any>("/chat/model-options").then(r => { setModels(modelChoices(r)); setGroups(modelGroups(r)); }).catch(() => { setModels([]); setGroups([]); });
  }, []);

  const pickModel = async (value: string) => {
    const c = models.find(m => m.value === value);
    if (!c) return;
    setModelValue(value); setModelErr("");
    if (!active) return; // applied when the first message creates the chat
    try {
      await api(`/chat/sessions/${active}/model`, { method: "POST", body: { provider: c.provider, model: c.model } });
    } catch (e: any) { setModelErr(e.message); }
  };

  const loadSessions = async () => {
    try { const r = await api<{ data: Session[] }>("/chat/sessions"); setSessions(r.data); setErr(""); }
    catch (e: any) { setErr(e.message); }
  };
  const loadMessages = async (id: string) => {
    try { const r = await api<{ data: { role: string; content: string | null }[] }>(`/chat/sessions/${id}/messages`); setMessages(toViewMessages(r.data)); }
    catch (e: any) { setErr(e.message); }
  };

  useEffect(() => { loadSessions(); }, []);
  useEffect(() => { if (active) loadMessages(active); else setMessages([]); }, [active]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: "end" }); }, [messages, stream.text]);

  const newChat = async () => {
    if (abort.current) return;
    try {
      const s = await api<any>("/chat/sessions", { method: "POST", body: {} });
      const id: string = s.id ?? s.session?.id;
      await loadSessions();
      setActive(id); setMessages([]); setErr(""); setDrawer(false);
    } catch (e: any) { setErr(e.message); }
  };

  const select = (id: string) => { if (!abort.current) { setActive(id); setErr(""); setRenaming(false); setDrawer(false); } };

  const send = async () => {
    const text = draft.trim();
    if (!text || abort.current) return;
    let id = active;
    if (!id) {
      try { const s = await api<any>("/chat/sessions", { method: "POST", body: {} }); id = s.id ?? s.session?.id; setActive(id); }
      catch (e: any) { setErr(e.message); return; }
    }
    const chosen = models.find(m => m.value === modelValue);
    if (chosen) {
      try { await api(`/chat/sessions/${id}/model`, { method: "POST", body: { provider: chosen.provider, model: chosen.model } }); }
      catch (e: any) { setModelErr(e.message); return; }
    }
    const options = reasoningOptions(reasoning);
    setDraft(""); setErr(""); setPending(text);
    setMessages(m => [...m, { role: "user", content: text }]);
    setStream({ ...initialStream, status: "streaming" });
    const ac = new AbortController(); abort.current = ac; setBusy(true);
    try {
      const r = await fetch(`/api/chat/sessions/${id}/stream`, {
        method: "POST", credentials: "same-origin", signal: ac.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream", "x-cc": "1" },
        body: JSON.stringify({ input: text, ...(options ? { model_options: options } : {}) }),
      });
      if (!r.ok || !r.body) { const j = await r.json().catch(() => ({})); throw new Error(j.error ?? `HTTP ${r.status}`); }
      const reader = r.body.getReader(), dec = new TextDecoder();
      let rest = "", s: StreamState = { ...initialStream, status: "streaming" };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const parsed = parseSse(rest, dec.decode(value, { stream: true }));
        rest = parsed.rest;
        for (const ev of parsed.events) { s = applyEvent(s, ev); setStream(s); }
      }
      if (s.status === "streaming") s = { ...s, status: "done" };
      if (s.status === "error") setErr(s.error);
      if (s.status === "done" && s.text) setMessages(m => [...m, { role: "assistant", content: s.text, thinking: s.thinking || undefined }]);
      if (s.status === "cancelled") setErr("The reply was cancelled.");
    } catch (e: any) {
      if (e.name !== "AbortError") setErr(e.message);
    } finally {
      abort.current = null; setBusy(false); setStream(initialStream); setPending("");
      loadSessions();
    }
  };

  const stop = () => abort.current?.abort();
  const current = sessions.find(s => s.id === active);

  const rename = async () => {
    if (!active || !title.trim()) return;
    try { await api(`/chat/sessions/${active}`, { method: "PATCH", body: { title: title.trim() } }); setRenaming(false); loadSessions(); }
    catch (e: any) { setErr(e.message); }
  };
  const remove = async () => {
    if (!active || !confirm("Delete this chat and its history?")) return;
    try { await api(`/chat/sessions/${active}`, { method: "DELETE" }); setActive(null); loadSessions(); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="chat">
      <aside className={`chat-side card${drawer ? " open" : ""}`}>
        <div className="chat-side-top">
          <button className="btn pri" onClick={newChat} disabled={busy}>New chat</button>
          <button className="btn chat-close" aria-label="Close chats" onClick={() => setDrawer(false)}>Close</button>
        </div>
        <ul className="chat-list" aria-label="Chats">
          {sessions.map(s => (
            <li key={s.id}>
              <button className={`chat-item${s.id === active ? " on" : ""}`} onClick={() => select(s.id)} aria-current={s.id === active ? "true" : undefined}>
                <span className="chat-item-title">{sessionLabel(s)}</span>
                <span className="muted chat-item-meta">{s.message_count} messages</span>
              </button>
            </li>
          ))}
          {!sessions.length && <li className="muted">No chats yet.</li>}
        </ul>
      </aside>

      <section className="chat-main card">
        <header className="chat-head">
          <button className="btn chat-menu" aria-label="Open chats" aria-expanded={drawer} onClick={() => setDrawer(true)}><svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M3 6h14M3 10h14M3 14h9" /></svg></button>
          {renaming ? (
            <form className="chat-rename" onSubmit={e => { e.preventDefault(); rename(); }}>
              <input aria-label="Chat title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
              <button className="btn pri" type="submit">Save title</button>
              <button className="btn" type="button" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          ) : (
            <>
              <strong className="chat-head-title">{current ? sessionLabel(current) : "New chat"}</strong>
              {active && <div className="chat-actions">
                <button className="btn chat-more" aria-label="Chat actions" aria-expanded={more} onClick={() => setMore(v => !v)}><svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><circle cx="4" cy="10" r="1.6" /><circle cx="10" cy="10" r="1.6" /><circle cx="16" cy="10" r="1.6" /></svg></button>
                <div className={`chat-more-pop${more ? " open" : ""}`}>
                  <button className="btn" onClick={() => { setMore(false); setTitle(current ? sessionLabel(current) : ""); setRenaming(true); }}>Rename</button>
                  <button className="btn dng" onClick={() => { setMore(false); remove(); }}>Delete</button>
                </div>
              </div>}
            </>
          )}
        </header>

        <div className="chat-log" role="log" aria-live="polite">
          {!messages.length && !stream.text && <p className="muted chat-empty">Ask Hermes anything. Each chat keeps its own history.</p>}
          {messages.map((m, i) => <Bubble key={i} role={m.role} text={m.content} thinking={m.thinking} />)}
          {pending && busy && (
            stream.text ? <Bubble role="assistant" text={stream.text} thinkingText={stream.thinking} streaming /> : <Bubble role="assistant" text="" thinkingText={stream.thinking} waiting />
          )}
          <div ref={bottom} />
        </div>

        {err && <div className="chat-err" role="alert">{err}</div>}

        <form className="chat-compose" onSubmit={e => { e.preventDefault(); send(); }}>
          <textarea
            aria-label="Message"
            rows={1}
            value={draft}
            placeholder="Message Hermes"
            onChange={e => { setDraft(e.target.value); const t = e.target; t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 160) + "px"; }}
            maxLength={20000}
          />
          {busy
            ? <button className="btn dng chat-send" type="button" aria-label="Stop" onClick={stop}><svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true"><rect x="2" y="2" width="10" height="10" rx="2" /></svg></button>
            : <button className="btn pri chat-send" type="submit" aria-label="Send" disabled={!draft.trim()}><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 14V4M4.5 8.5 9 4l4.5 4.5" /></svg></button>}
        </form>
        <div className="chat-model">
          <select aria-label="Provider" value={providerSlug} onChange={e => { setProviderSlug(e.target.value); setModelValue(""); }} disabled={busy || !groups.length}>
            <option value="">{groups.length ? "Default model" : "No models available"}</option>
            {groups.map(g => <option key={g.slug} value={g.slug}>{g.name}</option>)}
          </select>
          <select aria-label="Reasoning" value={reasoning} onChange={e => setReasoning(e.target.value)} disabled={busy}>
            <option value="">Reasoning: default</option>
            {REASONING_CHOICES.map(r => <option key={r.value} value={r.value}>Reasoning: {r.label.toLowerCase()}</option>)}
          </select>
          {providerSlug !== "" && (
            <select aria-label="Model" className="chat-model-pick" value={modelValue} onChange={e => pickModel(e.target.value)} disabled={busy}>
              <option value="">Choose a model</option>
              {(groups.find(g => g.slug === providerSlug)?.models ?? []).map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          )}
          {modelErr && <span className="chat-err-inline" role="alert">{modelErr}</span>}
        </div>
      </section>
      {drawer && <div className="chat-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />}
    </div>
  );
}

function Bubble({ role, text, streaming, thinkingText, waiting, thinking }: { role: "user" | "assistant"; text: string; streaming?: boolean; thinkingText?: string; waiting?: boolean; thinking?: string }) {
  return (
    <div className={`bubble ${role}`}>
      <div className="bubble-role muted">{role === "user" ? "You" : "Hermes"}</div>
      {role === "assistant" && (thinking || thinkingText) && (
        <details className="thinking">
          <summary>Thinking</summary>
          <div className="thinking-text">{thinking ?? thinkingText}</div>
        </details>
      )}
      <div className="bubble-text">{waiting ? <span className="muted">Thinking</span> : text}{streaming && <span className="caret" aria-hidden="true" />}</div>
    </div>
  );
}

