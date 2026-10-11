import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { chat } from "../../chat/api";
import { sheetErrorText, tokenNote } from "../../chat/pi";
import type { PiConfig, PiSettings } from "../../chat/types";

type Props = { sid: string; running: boolean; onClose: () => void };

const QUEUE: { value: PiSettings["steeringMode"]; label: string }[] = [
  { value: "one-at-a-time", label: "One at a time" },
  { value: "all", label: "All at once" },
];

/** Per-chat Pi options. Rarely used, so it opens from the chat menu and never sits on the composer. */
export function PiSheet({ sid, running, onClose }: Props) {
  const [s, setS] = useState<PiSettings | null>(null);
  const [cfg, setCfg] = useState<PiConfig | null>(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([chat.piSettings(sid), chat.piConfig()])
      .then(([a, b]) => { if (live) { setS(a.settings); setCfg(b); } })
      .catch(e => { if (live) setErr(sheetErrorText(e)); });
    return () => { live = false; };
  }, [sid]);

  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", f);
    return () => document.removeEventListener("keydown", f);
  }, [onClose]);

  const save = async (patch: Partial<PiSettings>) => {
    setErr(""); setMsg("");
    try { setS((await chat.patchPiSettings(sid, patch)).settings); }
    catch (e) { setErr(sheetErrorText(e)); }
  };

  const compact = async () => {
    setBusy(true); setErr(""); setMsg("");
    try { setMsg(tokenNote(await chat.piCompact(sid))); }
    catch (e) { setErr(sheetErrorText(e)); }
    finally { setBusy(false); }
  };

  const tools = cfg?.knownTools ?? [];
  const usingDefault = s ? s.tools === null : true;
  const effective = s?.tools ?? cfg?.defaultTools ?? tools;
  const toggleTool = (t: string) => {
    const next = effective.includes(t) ? effective.filter(x => x !== t) : [...effective, t];
    if (next.length === 0) return;
    void save({ tools: tools.filter(x => next.includes(x)) });
  };
  const locked = running;

  return (
    <>
      <button className="sheet-scrim" type="button" aria-label="Close Pi options" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Pi options">
        <div className="sheet-head">
          <h2>Pi options</h2>
          <button className="ib" type="button" aria-label="Close Pi options" onClick={onClose}><Icon name="x" /></button>
        </div>
        <div className="sheet-body">
          {!s && !err && <p className="meta" role="status">Loading</p>}
          {err && <p className="err-row" role="alert">{err}</p>}
          {s && cfg && (
            <>
              {locked && <p className="meta" role="note">A run is active. Changes unlock when it finishes.</p>}

              <section aria-labelledby="pi-tools">
                <h3 id="pi-tools">Tools for this chat</h3>
                <label className="chk"><input type="checkbox" checked={usingDefault} disabled={locked} onChange={e => void save({ tools: e.target.checked ? null : effective })} />Use the default tools</label>
                <div className="chk-grid" role="group" aria-label="Tools">
                  {tools.map(t => (
                    <label className="chk" key={t}>
                      <input type="checkbox" checked={effective.includes(t)} disabled={locked || usingDefault || (effective.length === 1 && effective.includes(t))} onChange={() => toggleTool(t)} />
                      <code>{t}</code>
                    </label>
                  ))}
                </div>
                <p className="meta">Tool changes apply on the next message.</p>
              </section>

              <section aria-labelledby="pi-queue">
                <h3 id="pi-queue">Messages sent while Pi works</h3>
                <p className="meta">Steering notes</p>
                <div className="segmented" role="group" aria-label="Steering notes">
                  {QUEUE.map(q => <button key={q.value} type="button" disabled={locked} aria-pressed={s.steeringMode === q.value} onClick={() => void save({ steeringMode: q.value })}>{q.label}</button>)}
                </div>
                <p className="meta">Follow-ups</p>
                <div className="segmented" role="group" aria-label="Follow-ups">
                  {QUEUE.map(q => <button key={q.value} type="button" disabled={locked} aria-pressed={s.followUpMode === q.value} onClick={() => void save({ followUpMode: q.value })}>{q.label}</button>)}
                </div>
              </section>

              <section aria-labelledby="pi-ctx">
                <h3 id="pi-ctx">Context</h3>
                <label className="chk"><input type="checkbox" checked={s.autoCompaction} disabled={locked} onChange={e => void save({ autoCompaction: e.target.checked })} />Compact automatically when the context fills</label>
                <label className="chk"><input type="checkbox" checked={s.autoRetry} disabled={locked} onChange={e => void save({ autoRetry: e.target.checked })} />Retry after temporary errors</label>
                <div><button className="btn" type="button" disabled={locked || busy} onClick={() => void compact()}>Compact now</button></div>
                {msg && <p className="meta" role="status">{msg}</p>}
              </section>
            </>
          )}
        </div>
      </div>
    </>
  );
}
