import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { parseSse, applyEvent, initialStream, toViewMessages, sessionLabel, type StreamState, type ViewMessage } from "../chatStream";

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
  const bottom = useRef<HTMLDivElement | null>(null);

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
      setActive(id); setMessages([]); setErr("");
    } catch (e: any) { setErr(e.message); }
  };

  const select = (id: string) => { if (!abort.current) { setActive(id); setErr(""); setRenaming(false); } };

  const send = async () => {
    const text = draft.trim();
    if (!text || abort.current) return;
    let id = active;
    if (!id) {
      try { const s = await api<any>("/chat/sessions", { method: "POST", body: {} }); id = s.id ?? s.session?.id; setActive(id); }
      catch (e: any) { setErr(e.message); return; }
    }
    setDraft(""); setErr(""); setPending(text);
    setMessages(m => [...m, { role: "user", content: text }]);
    setStream({ ...initialStream, status: "streaming" });
    const ac = new AbortController(); abort.current = ac; setBusy(true);
    try {
      const r = await fetch(`/api/chat/sessions/${id}/stream`, {
        method: "POST", credentials: "same-origin", signal: ac.signal,
        headers: { "content-type": "application/json", accept: "text/event-stream", "x-cc": "1" },
        body: JSON.stringify({ input: text }),
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
      if (s.status === "done" && s.text) setMessages(m => [...m, { role: "assistant", content: s.text }]);
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
      <aside className="chat-side card">
        <button className="btn pri" onClick={newChat} disabled={busy}>New chat</button>
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
          {renaming ? (
            <form className="chat-rename" onSubmit={e => { e.preventDefault(); rename(); }}>
              <input aria-label="Chat title" value={title} onChange={e => setTitle(e.target.value)} autoFocus />
              <button className="btn pri" type="submit">Save title</button>
              <button className="btn" type="button" onClick={() => setRenaming(false)}>Cancel</button>
            </form>
          ) : (
            <>
              <strong className="chat-head-title">{current ? sessionLabel(current) : "New chat"}</strong>
              {active && <>
                <button className="btn" onClick={() => { setTitle(current ? sessionLabel(current) : ""); setRenaming(true); }}>Rename</button>
                <button className="btn dng" onClick={remove}>Delete</button>
              </>}
            </>
          )}
        </header>

        <div className="chat-log" role="log" aria-live="polite">
          {!messages.length && !stream.text && <p className="muted chat-empty">Ask Hermes anything. Each chat keeps its own history.</p>}
          {messages.map((m, i) => <Bubble key={i} role={m.role} text={m.content} />)}
          {pending && busy && (
            stream.text ? <Bubble role="assistant" text={stream.text} streaming /> : <Bubble role="assistant" text="" thinking />
          )}
          <div ref={bottom} />
        </div>

        {err && <div className="chat-err" role="alert">{err}</div>}

        <form className="chat-compose" onSubmit={e => { e.preventDefault(); send(); }}>
          <textarea
            aria-label="Message"
            rows={2}
            value={draft}
            placeholder="Message Hermes"
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            maxLength={20000}
          />
          {busy
            ? <button className="btn dng" type="button" onClick={stop}>Stop</button>
            : <button className="btn pri" type="submit" disabled={!draft.trim()}>Send</button>}
        </form>
      </section>
    </div>
  );
}

function Bubble({ role, text, streaming, thinking }: { role: "user" | "assistant"; text: string; streaming?: boolean; thinking?: boolean }) {
  return (
    <div className={`bubble ${role}`}>
      <div className="bubble-role muted">{role === "user" ? "You" : "Hermes"}</div>
      <div className="bubble-text">{thinking ? <span className="muted">Thinking</span> : text}{streaming && <span className="caret" aria-hidden="true" />}</div>
    </div>
  );
}
