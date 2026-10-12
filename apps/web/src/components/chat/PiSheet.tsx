import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import { chat } from "../../chat/api";
import { sheetErrorText, tokenNote } from "../../chat/pi";
import { toolRows, toggleTool } from "../../chat/tools";
import type { PiConfig, PiSettings, PiTool } from "../../chat/types";
import { PiToolList, usePiTools } from "../PiToolList";

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
  const dyn = usePiTools();

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

  const offered: PiTool[] = dyn ?? (cfg?.knownTools ?? []).map(name => ({ name, description: "" }));
  const usingDefault = s ? s.tools === null : true;
  const effective = s?.tools ?? cfg?.defaultTools ?? offered.map(t => t.name);
  const rows = toolRows(offered, usingDefault ? null : effective);
  const toggleTool1 = (t: string) => {
    const next = toggleTool(offered, effective, t);
    if (next.length === effective.length && next.every((x, i) => x === effective[i])) return;
    void save({ tools: next });
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
                <PiToolList
                  label="Tools"
                  rows={rows}
                  disabled={locked || usingDefault}
                  isLocked={name => effective.length === 1 && effective.includes(name)}
                  onToggle={toggleTool1}
                />
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
