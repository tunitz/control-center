import { useEffect, useState } from "react";
import { api, fmt, type Unit, type Metrics } from "../api";
import { useLive, cached, remember } from "../hooks";
import { Gauge } from "../components/Gauge";
import { Sparkline } from "../components/Sparkline";
import AddUnit from "../components/AddUnit";
import { sampleLabel } from "../lib/format";

type Cost = { month: string; rate: number; total_php: number; total_kwh: number; wall_kwh?: number; cost_include_wall?: boolean; cost_basis?: string };
function UnitCard({ u }: { u: Unit }) {
  const [spark, setSpark] = useState<(number | null)[]>(() => cached<(number | null)[]>(`spark:${u.id}`) ?? []);
  useEffect(() => { let on = true; const f = () => api<Metrics>(`/units/${u.id}/metrics?range=1h`).then(m => { if (!on) return; const v = m.points.filter((_, i) => i % 4 === 0).map(p => p.cpu_pct); remember(`spark:${u.id}`, v); setSpark(v); }).catch(() => {}); f(); const t = setInterval(f, 30000); return () => { on = false; clearInterval(t); }; }, [u.id]);
  const l = u.latest, w = u.live_w;
  return (
    <a className="card" href={`#/unit/${u.id}`} aria-label={`Open ${u.name}`}>
      <div className="uhead"><span className={"dot" + (u.online ? " on" : "")} title={u.online ? "online" : "offline"} /><div><h3>{u.name}</h3><div className="host">{u.host}{u.online ? "" : u.last_error ? ` · ${u.last_error}` : " · offline"}</div><div className={"sample" + (u.sample_fresh === false ? " stale" : "")}>{sampleLabel(u.last_sample_ts, u.sample_fresh)}</div></div></div>
      <div className="gauges">
        <Gauge label="CPU" value={l?.cpu_pct ?? null} color="var(--s1)" sub={l?.cpu_mhz ? (l.cpu_mhz / 1000).toFixed(1) + " GHz" : undefined} />
        <Gauge label="GPU" value={l?.gpu_pct ?? null} color="var(--s2)" />
        <Gauge label="RAM" value={u.ram_pct} color="var(--s3)" />
      </div>
      <Sparkline values={spark} color="var(--s1)" />
      <div className="row"><span>Power <b>{w != null ? fmt(w, 1, " W") : "—"}</b></span><span>Wall <b>{u.wall_w != null ? fmt(u.wall_w, 1, " W") : "—"}</b></span><span>Month <b>{u.month ? `${u.month.kwh.toFixed(3)} kWh · ₱${u.month.php.toFixed(2)}` : "—"}</b></span></div>
    </a>
  );
}
export default function Dashboard() {
  const { data: units, err } = useLive<Unit[]>("/units", 5000);
  const { data: cost } = useLive<Cost>("/cost", 15000);
  const { data: alerts } = useLive<{ unit_id: number; kind: string; message: string; name: string }[]>("/alerts", 15000);
  const [adding, setAdding] = useState(false);
  const online = units?.filter(u => u.online).length ?? 0;
  const watts = units?.reduce((a, u) => a + (u.live_w ?? 0), 0) ?? 0;
  return (
    <>
      <div className="grid g-hero">
        <div className="card hero"><div className="lab">Cost this month · {cost?.month ?? ""}</div><div className="val">{cost ? `₱${cost.total_php.toFixed(2)}` : "—"}</div><div className="sub">{cost ? `${cost.total_kwh.toFixed(3)} kWh at ₱${cost.rate}/kWh` : ""}{cost?.cost_basis ? ` · ${cost.cost_basis}` : ""}</div></div>
        <div className="card hero"><div className="lab">Live power</div><div className="val">{fmt(watts, 1, " W")}</div><div className="sub">all units, CPU + GPU</div></div>
        <div className="card hero"><div className="lab">Units online</div><div className="val">{online} / {units?.length ?? 0}</div><div className="sub">&nbsp;</div></div>
      </div>
      {!!alerts?.length && <div className="card" role="alert" style={{ marginBottom: 14, borderColor: "var(--err-line)" }}>
        <h4 style={{ marginTop: 0 }}>{alerts.length} active alert{alerts.length === 1 ? "" : "s"}</h4>
        <ul className="muted" style={{ margin: 0, paddingLeft: 18 }}>{alerts.map((a, i) => <li key={`${a.unit_id}:${a.kind}:${i}`}>{a.name ?? `#${a.unit_id}`}: {a.kind} — {a.message}</li>)}</ul>
      </div>}
      <div className="uhead" style={{ margin: "18px 0 10px" }}><h3 style={{ margin: 0 }}>Units</h3><div className="spacer" /><button className="btn pri" onClick={() => setAdding(true)}>+ Add unit</button></div>
      {err && <div className="err" role="alert">{err}</div>}
      {units && units.length === 0 && <div className="card muted">No units yet. Add one to get an install command.</div>}
      <div className="grid g-units">{units?.map(u => <UnitCard key={u.id} u={u} />)}</div>
      {adding && <AddUnit onClose={() => setAdding(false)} />}
    </>
  );
}
