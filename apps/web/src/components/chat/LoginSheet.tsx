import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { chat } from "../../chat/api";
import { sheetErrorText } from "../../chat/pi";
import { openAuthStream, type AuthStreamEvent } from "../../chat/sse";
import type { PiAuthEvent, PiAuthPrompt, PiAuthProvider, PiAuthType } from "../../chat/types";

type Props = {
  /** `/login <provider>`: a provider id or name to preselect. Empty opens the picker. */
  initial?: string;
  onClose: () => void;
};

const methodLabel = (type: PiAuthType, p: PiAuthProvider): string =>
  type === "oauth" ? p.oauthLabel ?? "Sign in with an account" : "Sign in with an API key";

/** Sign-in errors are not run errors: a 409 means another sign-in is in flight, not a chat task. */
function authErrorText(e: unknown): string {
  const err = e as { status?: number };
  if (err.status === 409) return "Another sign-in is already in progress. Close this panel and try again.";
  if (err.status === 503) return "Pi is not configured on the server.";
  return sheetErrorText(e);
}

/**
 * Pi provider sign-in. The bridge drives the flow (OAuth or API key); this sheet shows what it
 * asks for and forwards the answers. It never sees a stored credential back from the server.
 */
export function LoginSheet({ initial, onClose }: Props) {
  const [providers, setProviders] = useState<PiAuthProvider[] | null>(null);
  const [err, setErr] = useState("");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PiAuthProvider | null>(null);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [notices, setNotices] = useState<PiAuthEvent[]>([]);
  const [prompt, setPrompt] = useState<PiAuthPrompt | null>(null);
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ ok: boolean; error: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const streamRef = useRef<{ close(): void } | null>(null);
  const autoRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    chat.piAuthProviders()
      .then(r => { if (live) setProviders(r.providers); })
      .catch(e => { if (live) setErr(authErrorText(e)); });
    return () => { live = false; };
  }, []);

  useEffect(() => () => streamRef.current?.close(), []);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    dialogRef.current?.focus();
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") closeRef.current(); };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = providers ?? [];
    return q ? list.filter(p => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)) : list;
  }, [providers, query]);

  const finish = (data: any) => {
    setResult({ ok: data?.ok === true, error: typeof data?.error === "string" && data.error !== "" && data.error !== "cancelled" ? data.error : null });
    setPrompt(null);
    setBusy(false);
  };

  const onEvent = (e: AuthStreamEvent) => {
    if (e.event === "auth") setNotices(prev => [...prev, e.data as PiAuthEvent]);
    // A question means the bridge is waiting on us, never on a request of ours.
    else if (e.event === "prompt") { setBusy(false); setPrompt(e.data as PiAuthPrompt); setInput(""); }
    else if (e.event === "prompt_end") setPrompt(p => (p && p.id === e.data?.id ? null : p));
    else if (e.event === "done") finish(e.data);
  };

  const start = async (provider: PiAuthProvider, authType: PiAuthType) => {
    setBusy(true); setErr(""); setNotices([]); setResult(null); setPrompt(null); setPicked(provider);
    try {
      const s = await chat.piAuthStart(provider.id, authType);
      setLoginId(s.id);
      streamRef.current?.close();
      streamRef.current = openAuthStream(s.id, onEvent, reason => {
        // The server closes after `done`; a drop before that means the flow is gone.
        if (reason === "gone") { setPrompt(null); setBusy(false); setErr("The sign-in connection dropped. Try again."); }
      });
      // The start request is done. From here the bridge waits on us, so the buttons must be live.
      setBusy(false);
    } catch (e) {
      setBusy(false); setErr(authErrorText(e));
    }
  };

  // `/login <provider>` (or a chat started from a configured provider) jumps straight in.
  useEffect(() => {
    if (autoRef.current || !providers || providers.length === 0) return;
    autoRef.current = true;
    const ref = (initial ?? "").trim().toLowerCase();
    if (!ref) return;
    const hit = providers.find(p => p.id.toLowerCase() === ref || p.name.toLowerCase() === ref);
    if (!hit) return;
    if (hit.authTypes.length === 1) void start(hit, hit.authTypes[0]);
    else setPicked(hit); // offer both methods instead of guessing
  }, [providers, initial]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = async (value: string) => {
    if (!loginId || !prompt || busy) return;
    setBusy(true); setErr("");
    try {
      await chat.piAuthRespond(loginId, value, prompt.id);
      setInput("");
      setPrompt(null);
    } catch (e) {
      setErr(authErrorText(e));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (loginId) { try { await chat.piAuthCancel(loginId); } catch { /* the flow is gone anyway */ } }
    streamRef.current?.close();
    setLoginId(null); setPrompt(null); setResult(null); setNotices([]); setPicked(null); setBusy(false); setErr("");
    setQuery("");
  };

  const running = loginId !== null && result === null;

  return (
    <>
      <button className="sheet-scrim" type="button" aria-label="Close sign in" onClick={onClose} />
      <div className="sheet login-sheet" role="dialog" aria-modal="true" aria-label="Sign in to Pi" tabIndex={-1} ref={dialogRef}>
        <div className="sheet-head">
          <h2>Sign in to Pi</h2>
          <button className="ib tap" type="button" aria-label="Close sign in" onClick={onClose}><Icon name="x" /></button>
        </div>

        <div className="sheet-body">
          {!providers && !err && <p className="meta" role="status">Loading providers</p>}
          {err && <p className="err-row" role="alert">{err}</p>}

          {providers && !picked && (
            <>
              <p className="meta">Choose a provider. Credentials are saved in Pi's agent folder, never in the Control Center.</p>
              <label className="auth-search">
                <Icon name="search" className="i sm" />
                <input type="search" value={query} aria-label="Search providers" placeholder="Search providers" autoComplete="off"
                  onChange={e => setQuery(e.target.value)} />
              </label>
              <div className="dir-list" role="list" aria-label="Providers">
                {matches.map(p => (
                  <button className="dir-row" type="button" role="listitem" key={p.id}
                    onClick={() => (p.authTypes.length === 1 ? void start(p, p.authTypes[0]) : setPicked(p))}>
                    <span className="name">{p.name}</span>
                    {p.configured && <span className="tag" title={p.source ? `Signed in via ${p.source}` : "Signed in"}>Signed in</span>}
                  </button>
                ))}
              </div>
              {matches.length === 0 && <p className="meta" role="status">No provider matches "{query.trim()}".</p>}
            </>
          )}

          {providers && picked && !running && result === null && picked.authTypes.length > 1 && (
            <div className="auth-methods" role="group" aria-label={`Sign-in method for ${picked.name}`}>
              <p className="meta">How do you want to sign in to {picked.name}?</p>
              <button className="btn primary lg" type="button" disabled={busy} onClick={() => void start(picked, "oauth")}>{methodLabel("oauth", picked)}</button>
              <button className="btn lg" type="button" disabled={busy} onClick={() => void start(picked, "api_key")}>{methodLabel("api_key", picked)}</button>
              <button className="btn ghost" type="button" onClick={() => setPicked(null)}>Back</button>
            </div>
          )}

          {running && (
            <>
              <p className="meta" role="status">{picked ? `Signing in to ${picked.name}` : "Signing in"}</p>
              {notices.map((n, i) => <AuthNotice key={i} n={n} />)}
              {prompt && (
                <form className="auth-prompt" onSubmit={e => { e.preventDefault(); if (prompt.type !== "select") void answer(input); }}>
                  <p className="auth-question">{prompt.message}</p>
                  {prompt.type === "select" ? (
                    <div className="auth-methods">
                      {(prompt.options ?? []).map(o => (
                        <button className="btn" type="button" key={o.id} disabled={busy} onClick={() => void answer(o.id)} title={o.description}>{o.label}</button>
                      ))}
                    </div>
                  ) : (
                    <div className="dir-new">
                      <input type={prompt.type === "secret" ? "password" : "text"} value={input} autoComplete="off"
                        aria-label={prompt.message} placeholder={prompt.placeholder ?? ""} disabled={busy} autoFocus
                        onChange={e => setInput(e.target.value)} />
                      <button className="btn primary" type="submit" disabled={busy || input.trim() === ""}>Send</button>
                    </div>
                  )}
                </form>
              )}
              {!prompt && notices.length === 0 && <p className="meta">Waiting for the provider</p>}
            </>
          )}

          {result && (
            <div className="auth-result" role="status">
              <p className={result.ok ? "stat-ok" : "err-row"}>
                {result.ok ? "Signed in. The provider is ready to use." : result.error ?? "Sign-in cancelled."}
              </p>
            </div>
          )}
        </div>

        <div className="sheet-foot">
          {running && <button className="btn danger-o lg" type="button" onClick={() => void cancel()}>Cancel sign-in</button>}
          {!running && <button className="btn primary lg" type="button" onClick={result && !result.ok ? () => void cancel() : onClose}>
            {result && !result.ok ? "Try again" : "Done"}
          </button>}
        </div>
      </div>
    </>
  );
}

/** One notice from the flow: a link to open, a device code to type, or a line of progress. */
function AuthNotice({ n }: { n: PiAuthEvent }) {
  if (n.type === "auth_url") {
    return (
      <div className="auth-card">
        <a className="btn" href={n.url} target="_blank" rel="noreferrer noopener">Open sign-in page</a>
        {n.instructions && <p className="meta">{n.instructions}</p>}
        <pre className="cmdblk auth-url">{n.url}</pre>
      </div>
    );
  }
  if (n.type === "device_code") {
    return (
      <div className="auth-card">
        <p className="auth-question">Enter this code on the provider's page:</p>
        <pre className="cmdblk auth-code">{n.userCode}</pre>
        <a className="btn" href={n.verificationUri} target="_blank" rel="noreferrer noopener">Open sign-in page</a>
      </div>
    );
  }
  if (n.type === "info") {
    return (
      <div className="auth-card">
        <p className="meta">{n.message}</p>
        {(n.links ?? []).map(l => <a className="meta" key={l.url} href={l.url} target="_blank" rel="noreferrer noopener">{l.label ?? l.url}</a>)}
      </div>
    );
  }
  return <p className="meta">{n.message}</p>;
}
