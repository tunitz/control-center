import { useCallback, useEffect, useState } from "react";
import { api, type ServiceItem, type ServiceLogLine, type ServiceRef } from "../api";
import { AGENT_HINT, KIND_LABEL, canStart, canStop, filterItems, groupByKind, hintFor, isAgentMissing, relativeTime, stateTone } from "../services";

const keyOf = (r: ServiceRef) => JSON.stringify([r.kind, r.name]);
const basePath = (unitId: number, r: ServiceRef) => `/units/${unitId}/services/${r.kind}/${encodeURIComponent(r.name)}`;
const ACTION_LABEL = { start: "Starting", stop: "Stopping", restart: "Restarting" } as const;
type Action = keyof typeof ACTION_LABEL;
const LOG_STEPS = [100, 300, 500] as const;

export default function Services({ unitId }: { unitId: number }) {
  const [items, setItems] = useState<ServiceItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [picking, setPicking] = useState(false);

  const load = useCallback((): Promise<void> =>
    api<{ items: ServiceItem[]; error?: string }>(`/units/${unitId}/services`)
      .then(d => { setItems(d.items ?? []); setErr(d.error ?? ""); })
      .catch(e => setErr(e.message))
      .finally(() => setLoaded(true)), [unitId]);

  useEffect(() => { setLoaded(false); load(); }, [load]);

  const groups = groupByKind(items);
  const listHint = hintFor({ listErr: err, pickerOpen: picking, discoverCount: 0, pickerErr: "" });
  return (
    <section className="card svc" aria-labelledby="svc-h" style={{ marginTop: 14 }}>
      <div className="svc-top">
        <h4 id="svc-h">Services</h4>
        <div className="spacer" />
        <button className="btn sm" aria-expanded={picking} onClick={() => setPicking(!picking)}>Manage</button>
      </div>
      {picking && <Picker unitId={unitId} onClose={() => setPicking(false)} onSaved={() => { setPicking(false); load(); }} />}
      {listHint === "list" && <div className="muted" role="status">{AGENT_HINT}</div>}
      {err && !isAgentMissing(err) && <div className="err" role="alert">{err}</div>}
      {loaded && !err && items.length === 0 && <div className="muted">No services allowed. Use Manage to choose.</div>}
      {groups.map(g => (
        <div key={g.kind}>
          <div className="svc-kind">{KIND_LABEL[g.kind]}</div>
          {g.items.map(it => <Row key={keyOf(it)} unitId={unitId} item={it} onChanged={load} />)}
        </div>
      ))}
    </section>
  );
}

function Row({ unitId, item, onChanged }: { unitId: number; item: ServiceItem; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Action | null>(null);
  const [rowErr, setRowErr] = useState("");
  const tone = stateTone(item.state);
  const act = async (a: Action) => {
    setBusy(a); setRowErr("");
    try { await api(`${basePath(unitId, item)}/${a}`, { method: "POST" }); }
    catch (e: any) { setRowErr(e.message); }
    await onChanged();
    setBusy(null);
  };
  return (
    <div className="svc-row">
      <button className="svc-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={"dot sm " + (tone === "ok" ? "on" : tone === "off" ? "off" : "")} />
        <span className="svc-name">{item.name}</span>
        {item.detail && <span className="svc-detail muted">{item.detail}</span>}
        <span className="svc-state muted">{busy ? ACTION_LABEL[busy] : item.state}</span>
        <span className="chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      <div className="svc-actions">
        <button className="btn sm" disabled={!!busy || !canStart(item.state)} onClick={() => act("start")}>Start</button>
        <button className="btn sm" disabled={!!busy || !canStop(item.state)} onClick={() => act("stop")}>Stop</button>
        <button className="btn sm" disabled={!!busy} onClick={() => act("restart")}>Restart</button>
      </div>
      {rowErr && <div className="err" role="alert">{rowErr}</div>}
      {open && <Logs unitId={unitId} item={item} />}
    </div>
  );
}

function Logs({ unitId, item }: { unitId: number; item: ServiceItem }) {
  const [n, setN] = useState<number>(LOG_STEPS[0]);
  const [lines, setLines] = useState<ServiceLogLine[]>([]);
  const [err, setErr] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);

  const load = useCallback((want: number) =>
    api<{ lines: ServiceLogLine[]; error?: string }>(`${basePath(unitId, item)}/logs?n=${want}`)
      .then(d => { setLines(d.lines ?? []); setErr(d.error ?? ""); setNow(Date.now()); })
      .catch(e => setErr(e.message))
      .finally(() => setLoaded(true)), [unitId, item.kind, item.name]);

  useEffect(() => { load(n); }, [load, n]);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") load(n); };
    const t = setInterval(tick, 5000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(t); document.removeEventListener("visibilitychange", tick); };
  }, [load, n]);

  return (
    <div className="logs">
      <div className="logs-bar">
        <span className="muted">Showing {lines.length}</span>
        <div className="spacer" />
        <button className="btn sm" onClick={() => load(n)}>Refresh</button>
      </div>
      {err && <div className="err" role="alert">{err}</div>}
      <div className="logs-body" role="log">
        {loaded && !err && lines.length === 0 && <div className="muted">No logs</div>}
        {lines.map((l, i) => (
          <div key={l.ts + ":" + i} className="log-line">
            <span className="log-t" title={new Date(l.ts).toLocaleString()}>{relativeTime(l.ts, now)}</span>
            <span className={"lvl " + l.level}>{l.level}</span>
            <span className="log-msg">{l.msg}</span>
          </div>
        ))}
      </div>
      {lines.length >= n && n < LOG_STEPS[LOG_STEPS.length - 1] && (
        <button className="btn sm" onClick={() => setN(LOG_STEPS[LOG_STEPS.indexOf(n as (typeof LOG_STEPS)[number]) + 1])}>Load more</button>
      )}
    </div>
  );
}

function Picker({ unitId, onClose, onSaved }: { unitId: number; onClose: () => void; onSaved: () => void }) {
  const [found, setFound] = useState<ServiceItem[] | null>(null);
  const [allowed, setAllowed] = useState<ServiceRef[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([
      api<{ items: ServiceItem[] }>(`/units/${unitId}/services/discover`),
      api<{ items: ServiceRef[] }>(`/units/${unitId}/services/allow`),
    ])
      .then(([d, a]) => {
        setFound(d.items ?? []);
        setAllowed(a.items ?? []);
        setSel(new Set((a.items ?? []).map(keyOf)));
      })
      .catch(e => { setErr(e.message); setFound([]); });
  }, [unitId]);

  if (found === null) return <div className="svc-picker muted">Loading</div>;
  // Allowlisted items that discover no longer reports stay listed so they can be unchecked.
  const foundKeys = new Set(found.map(keyOf));
  const options: ServiceItem[] = [...found, ...allowed.filter(a => !foundKeys.has(keyOf(a))).map(a => ({ ...a, state: "" }))];
  const groups = groupByKind(filterItems(options, q));
  const hint = hintFor({ listErr: "", pickerOpen: true, discoverCount: found.length, pickerErr: err });
  const toggle = (r: ServiceRef) => setSel(prev => {
    const next = new Set(prev);
    const k = keyOf(r);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  });
  const save = async () => {
    setBusy(true); setErr("");
    const items = options.filter(o => sel.has(keyOf(o))).map(o => ({ kind: o.kind, name: o.name }));
    try { await api(`/units/${unitId}/services/allow`, { method: "PUT", body: { items } }); onSaved(); }
    catch (e: any) { setErr(e.message); setBusy(false); }
  };

  return (
    <div className="svc-picker">
      {hint === "picker" && <div className="muted" role="status">{AGENT_HINT}</div>}
      {options.length > 0 && (
        <>
          <input aria-label="Filter services" placeholder="Filter" value={q} onChange={e => setQ(e.target.value)} autoCapitalize="none" />
          {groups.map(g => (
            <div key={g.kind}>
              <div className="svc-kind">{KIND_LABEL[g.kind]}</div>
              {g.items.map(o => (
                <label key={keyOf(o)} className="chk">
                  <input type="checkbox" checked={sel.has(keyOf(o))} onChange={() => toggle(o)} />
                  <span className="svc-name">{o.name}</span>
                  {o.state && <span className="muted">{o.state}</span>}
                </label>
              ))}
            </div>
          ))}
        </>
      )}
      {err && !isAgentMissing(err) && <div className="err" role="alert">{err}</div>}
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <button className="btn pri sm" disabled={busy || options.length === 0} onClick={save}>Save</button>
        <button type="button" className="btn sm" onClick={onClose}>Cancel</button>
      </div>
    </div>
  );
}
