import { useEffect, useState } from "react";
import { chat, ChatError } from "../chat/api";
import type { PiConfig } from "../chat/types";

/** Global Pi configuration. Rarely changed, so it lives in Settings and not in the chat. */
export default function PiConfigCard({ onMsg }: { onMsg: (m: string) => void }) {
  const [cfg, setCfg] = useState<PiConfig | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "off" | "down">("loading");
  const [prompt, setPrompt] = useState("");
  const [notes, setNotes] = useState("");
  const [tools, setTools] = useState<string[] | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [risky, setRisky] = useState<string[]>([]);
  const [claudeBridge, setClaudeBridge] = useState(false);
  const [browser, setBrowser] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [newRisky, setNewRisky] = useState("");
  const [err, setErr] = useState("");

  const apply = (c: PiConfig) => {
    setCfg(c); setPrompt(c.appendSystemPrompt); setNotes(c.agentsMd); setTools(c.defaultTools);
    setPaths(c.gate.extraProtectedPaths); setRisky(c.gate.extraRisky); setClaudeBridge(c.claudeBridge); setBrowser(c.browser);
  };
  useEffect(() => {
    chat.piConfig().then(c => { apply(c); setState("ready"); })
      .catch(e => setState((e as ChatError).status === 503 && /not configured/i.test((e as Error).message) ? "off" : "down"));
  }, []);

  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const dirty = !!cfg && (prompt !== cfg.appendSystemPrompt || notes !== cfg.agentsMd || !same(tools, cfg.defaultTools) || !same(paths, cfg.gate.extraProtectedPaths) || !same(risky, cfg.gate.extraRisky) || claudeBridge !== cfg.claudeBridge || browser !== cfg.browser);

  const save = async () => {
    if (!cfg) return;
    setErr("");
    const patch: Record<string, unknown> = {};
    if (prompt !== cfg.appendSystemPrompt) patch.appendSystemPrompt = prompt;
    if (notes !== cfg.agentsMd) patch.agentsMd = notes;
    if (!same(tools, cfg.defaultTools)) patch.defaultTools = tools;
    if (!same(paths, cfg.gate.extraProtectedPaths) || !same(risky, cfg.gate.extraRisky)) patch.gate = { extraProtectedPaths: paths, extraRisky: risky };
    if (claudeBridge !== cfg.claudeBridge) patch.claudeBridge = claudeBridge;
    if (browser !== cfg.browser) patch.browser = browser;
    try { apply(await chat.putPiConfig(patch)); onMsg("Pi settings saved. They apply on the next message."); }
    catch (e) { setErr((e as Error).message); }
  };

  const known = cfg?.knownTools ?? [];
  const usingDefault = tools === null;
  const effective = tools ?? known;
  const flip = (t: string) => {
    const next = effective.includes(t) ? effective.filter(x => x !== t) : [...effective, t];
    if (next.length > 0) setTools(known.filter(x => next.includes(x)));
  };
  const addPath = () => { const v = newPath.trim(); if (v && !paths.includes(v)) setPaths([...paths, v]); setNewPath(""); };
  const addRisky = () => { const v = newRisky.trim(); if (v && !risky.includes(v)) setRisky([...risky, v]); setNewRisky(""); };

  return (
    <div className="acc-sub" id="pi-agent"><h3 className="acc-subtitle">Agent settings</h3>
      {state === "loading" && <p className="muted" role="status">Loading</p>}
      {state === "off" && <p className="muted">Pi is not set up on this server.</p>}
      {state === "down" && <p className="muted" role="alert">Pi is not reachable. Start the pi-bridge service, then reload this page.</p>}
      {state === "ready" && cfg && (
        <>
          <p className="muted">Applies to every Pi chat, on its next message.</p>

          <label htmlFor="pi-prompt">Extra instructions</label>
          <textarea id="pi-prompt" rows={4} value={prompt} maxLength={32000} onChange={e => setPrompt(e.target.value)} placeholder="Added to Pi's built-in instructions" style={{ width: "100%" }} />

          <label htmlFor="pi-notes" style={{ marginTop: 12, display: "block" }}>Notes for every chat</label>
          <textarea id="pi-notes" rows={4} value={notes} maxLength={32000} onChange={e => setNotes(e.target.value)} placeholder="Standing facts Pi should know, like which tools you use" style={{ width: "100%" }} />

          <fieldset style={{ marginTop: 14, border: 0, padding: 0 }}>
            <legend style={{ fontWeight: 600 }}>Default tools</legend>
            <label className="pi-chk"><input type="checkbox" checked={usingDefault} onChange={e => setTools(e.target.checked ? null : known)} />Use Pi's own defaults</label>
            <div className="pi-grid">
              {known.map(t => (
                <label className="pi-chk" key={t}>
                  <input type="checkbox" checked={effective.includes(t)} disabled={usingDefault || (effective.length === 1 && effective.includes(t))} onChange={() => flip(t)} />
                  <code>{t}</code>
                </label>
              ))}
            </div>
            <p className="muted">A chat can override this from its own Pi options.</p>
          </fieldset>

          <h4 style={{ margin: "16px 0 4px" }}>Claude subscription</h4>
          <label className="pi-chk"><input type="checkbox" checked={claudeBridge} onChange={e => setClaudeBridge(e.target.checked)} />Run Claude models through Claude Code</label>
          <p className="muted">
            Loads the pi-claude-bridge extension and keeps the Anthropic environment variables away from Pi, so Claude Code signs in with its own subscription login. Use the claude-bridge models in the picker.
            {claudeBridge && !cfg.claudeCode.extension && " The pi-claude-bridge extension was not found."}
            {claudeBridge && cfg.claudeCode.extension && !cfg.claudeCode.found && " Claude Code was not found. Install it and sign in once with the claude command."}
          </p>

          <h4 style={{ margin: "16px 0 4px" }}>Browser tools</h4>
          <label className="pi-chk"><input type="checkbox" checked={browser} onChange={e => setBrowser(e.target.checked)} />Give Pi browser tools</label>
          <p className="muted">
            Adds browser_navigate, browser_snapshot, browser_click, browser_type and friends to Pi chats, backed by the agent-browser CLI and a local Chromium.
            {browser && !cfg.browserStatus.extension && " The cc-browser extension was not found."}
            {browser && cfg.browserStatus.extension && !cfg.browserStatus.agent && " The agent-browser CLI was not found. Install agent-browser or point CC_BROWSER_BIN at it."}
            {browser && cfg.browserStatus.extension && cfg.browserStatus.agent && !cfg.browserStatus.chromium && " No bundled Chromium was found; agent-browser will auto-detect one (it may need system libraries)."}
          </p>

          <h4 style={{ margin: "16px 0 4px" }}>Extra approval rules</h4>
          <p className="muted">Pi already asks before risky commands and before touching secrets. Rules here make it ask more often, never less.</p>

          <label htmlFor="pi-path">Protected folder, relative to your home folder</label>
          <div className="pi-add"><input id="pi-path" value={newPath} onChange={e => setNewPath(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addPath(); }} placeholder="projects/private" /><button className="btn" type="button" onClick={addPath} disabled={!newPath.trim()}>Add folder</button></div>
          <ul className="pi-rules">{paths.map(p => <li key={p}><code>{p}</code><button className="btn" type="button" aria-label={`Remove ${p}`} onClick={() => setPaths(paths.filter(x => x !== p))}>Remove</button></li>)}</ul>

          <label htmlFor="pi-risky">Command pattern that needs approval</label>
          <div className="pi-add"><input id="pi-risky" value={newRisky} onChange={e => setNewRisky(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addRisky(); }} placeholder="git\s+push" /><button className="btn" type="button" onClick={addRisky} disabled={!newRisky.trim()}>Add pattern</button></div>
          <ul className="pi-rules">{risky.map(r => <li key={r}><code>{r}</code><button className="btn" type="button" aria-label={`Remove ${r}`} onClick={() => setRisky(risky.filter(x => x !== r))}>Remove</button></li>)}</ul>

          {err && <p role="alert" className="muted" style={{ color: "var(--err)" }}>{err}</p>}
          <div style={{ marginTop: 12 }}><button className="btn pri" type="button" disabled={!dirty} onClick={() => void save()}>Save changes</button></div>
        </>
      )}
    </div>
  );
}
