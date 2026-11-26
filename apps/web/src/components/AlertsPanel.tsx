import { useCallback, useEffect, useState } from "react";
import { api, type Unit } from "../api";

type Rule = { unit_id: number; kind: string; enabled: number; threshold: number | null };
type Window = { id: number; unit_id: number | null; days: string; start_minute: number; end_minute: number };
type Active = { unit_id: number; kind: string; since_ts: number; message: string; name: string };
type Data = { active: Active[]; rules: Rule[]; windows: Window[] };

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minutes = (v: string) => { const [h, m] = v.split(":").map(Number); return h * 60 + m; };

export default function AlertsPanel({ units, timezone }: { units: Unit[]; timezone?: string }) {
  const [data, setData] = useState<Data | null>(null);
  const [msg, setMsg] = useState("");
  const [w, setW] = useState({ unit_id: "", days: "0,1,2,3,4,5,6", from: "22:00", to: "06:00" });
  const load = useCallback(() => api<Data>("/alerts").then(setData).catch(e => setMsg(e.message)), []);
  useEffect(() => { load(); }, [load]);

  const setRule = async (unitId: number, kind: string, patch: Record<string, unknown>) => {
    try { await api(`/alerts/${unitId}/${kind}`, { method: "PUT", body: patch }); setMsg("Alert saved"); await load(); }
    catch (e: any) { setMsg(e.message); }
  };
  const addWindow = async () => {
    try {
      await api("/alerts/maintenance", { method: "POST", body: {
        unit_id: w.unit_id === "" ? null : Number(w.unit_id),
        days: w.days, start_minute: minutes(w.from), end_minute: minutes(w.to),
      } });
      setMsg("Maintenance window added"); await load();
    } catch (e: any) { setMsg(e.message); }
  };
  const delWindow = async (id: number) => {
    try { await api(`/alerts/maintenance/${id}`, { method: "DELETE" }); await load(); }
    catch (e: any) { setMsg(e.message); }
  };
  const ruleFor = (unitId: number, kind: string) => data?.rules.find(r => r.unit_id === unitId && r.kind === kind);
  const activeFor = (unitId: number, kind: string) => data?.active.some(a => a.unit_id === unitId && a.kind === kind);

  return (
    <div className="acc-sub">
      <h3 className="acc-subtitle">Active alerts</h3>
      {!data?.active.length && <p className="muted">No active alerts.</p>}
      {!!data?.active.length && <div className="scroll" role="region" aria-label="Active alerts" tabIndex={0}><table className="rtable"><thead><tr><th>Unit</th><th>Alert</th><th>Detail</th></tr></thead><tbody>
        {data.active.map(a => <tr key={`${a.unit_id}:${a.kind}`}><td data-label="Unit">{a.name ?? `#${a.unit_id}`}</td><td data-label="Alert">{a.kind}</td><td data-label="Detail">{a.message}</td></tr>)}
      </tbody></table></div>}

      <h3 className="acc-subtitle">Rules</h3>
      {units.map(u => <div key={u.id} className="chk" style={{ flexWrap: "wrap" }}>
        <b style={{ minWidth: 120 }}>{u.name}</b>
        {(["offline", "stale", "disk"] as const).map(kind => {
          const r = ruleFor(u.id, kind);
          const on = r ? !!r.enabled : kind !== "disk";
          return <label key={kind} style={{ margin: 0 }}><input type="checkbox" checked={on}
            onChange={e => setRule(u.id, kind, { enabled: e.target.checked, threshold: kind === "disk" ? (r?.threshold ?? 90) : undefined })} /> {kind}{activeFor(u.id, kind) ? " (active)" : ""}</label>;
        })}
        <input type="number" min={1} max={100} aria-label={`${u.name} disk threshold`} style={{ width: 70 }}
          defaultValue={ruleFor(u.id, "disk")?.threshold ?? 90}
          onBlur={e => setRule(u.id, "disk", { enabled: true, threshold: Number(e.target.value) })} />
      </div>)}

      <h3 className="acc-subtitle">Maintenance windows</h3>
      {!data?.windows.length && <p className="muted">No maintenance windows. Alerts are always active.</p>}
      {data?.windows.map(w => <div key={w.id} className="chk" style={{ flexWrap: "wrap" }}>
        <span>{w.unit_id == null ? "All units" : (units.find(u => u.id === w.unit_id)?.name ?? `#${w.unit_id}`)} · days {w.days} · {hhmm(w.start_minute)}–{hhmm(w.end_minute)}</span>
        <button className="btn sm dng" onClick={() => delWindow(w.id)}>Remove</button>
      </div>)}
      <div className="chips" style={{ marginTop: 8 }}>
        <select aria-label="Window unit" value={w.unit_id} onChange={e => setW({ ...w, unit_id: e.target.value })} style={{ width: "auto" }}>
          <option value="">All units</option>{units.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input aria-label="Window days" value={w.days} onChange={e => setW({ ...w, days: e.target.value })} style={{ width: 120 }} />
        <input aria-label="Window start" type="time" value={w.from} onChange={e => setW({ ...w, from: e.target.value })} style={{ width: 110 }} />
        <input aria-label="Window end" type="time" value={w.to} onChange={e => setW({ ...w, to: e.target.value })} style={{ width: 110 }} />
        <button className="btn sm pri" onClick={addWindow}>Add window</button>
      </div>
      <p className="muted" style={{ fontSize: "0.75rem" }}>Times are device-local; alert evaluation uses {timezone || "UTC"} time. A window ending before it starts spans midnight.</p>
      {msg && <div className="toast" role="status" onAnimationEnd={() => setMsg("")}>{msg}</div>}
    </div>
  );
}
