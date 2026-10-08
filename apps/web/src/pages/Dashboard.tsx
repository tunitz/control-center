import { useEffect, useState } from "react";
import { api, fmt, type Unit, type Metrics } from "../api";
import { useLive, cached, remember } from "../hooks";
import { Gauge } from "../components/Gauge";
import { Sparkline } from "../components/Sparkline";
import AddUnit from "../components/AddUnit";

type Cost = { month: string; rate: number; total_php: number; total_kwh: number };
function UnitCard({ u }: { u: Unit }) {
  const [spark, setSpark] = useState<(number | null)[]>(() => cached<(number | null)[]>(`spark:${u.id}`) ?? []);
  useEffect(() => { let on = true; const f = () => api<Metrics>(`/units/${u.id}/metrics?range=1h`).then(m => { if (!on) return; const v = m.points.filter((_, i) => i % 4 === 0).map(p => p.cpu_pct); remember(`spark:${u.id}`, v); setSpark(v); }).catch(() => {}); f(); const t = setInterval(f, 30000); return () => { on = false; clearInterval(t); }; }, [u.id]);
  const l = u.latest, w = u.live_w;
  return (
    <a className="card" href={`#/unit/${u.id}`} aria-label={`Open ${u.name}`}>
      <div className="uhead"><span className={"dot" + (u.online ? " on" : "")} title={u.online ? "online" : "offline"} /><div><h3>{u.name}</h3><div className="host">{u.host}{u.online ? "" : u.last_error ? ` · ${u.last_error}` : " · offline"}</div></div></div>
      <div className="gauges">
        <Gauge label="CPU" value={l?.cpu_pct ?? null} color="#38e1ff" sub={l?.cpu_mhz ? (l.cpu_mhz / 1000).toFixed(1) + " GHz" : undefined} />
        <Gauge label="GPU" value={l?.gpu_pct ?? null} color="#a78bfa" />
        <Gauge label="RAM" value={u.ram_pct} color="#f472b6" />
      </div>
      <Sparkline values={spark} color="#38e1ff" />
      <div className="row"><span>Power <b>{w != null ? fmt(w, 1, " W") : "—"}</b></span><span>Month <b>{u.month ? `${u.month.kwh.toFixed(3)} kWh · ₱${u.month.php.toFixed(2)}` : "—"}</b></span></div>
    </a>
  );
}
export default function Dashboard() {
  const { data: units, err } = useLive<Unit[]>("/units", 5000);
  const { data: cost } = useLive<Cost>("/cost", 15000);
  const [adding, setAdding] = useState(false);
  const online = units?.filter(u => u.online).length ?? 0;
  const watts = units?.reduce((a, u) => a + (u.live_w ?? 0), 0) ?? 0;
  return (
    <>
      <div className="grid g-hero">
        <div className="card hero"><div className="lab">Cost this month · {cost?.month ?? ""}</div><div className="val">{cost ? `₱${cost.total_php.toFixed(2)}` : "—"}</div><div className="sub">{cost ? `${cost.total_kwh.toFixed(3)} kWh at ₱${cost.rate}/kWh` : ""}</div></div>
        <div className="card hero"><div className="lab">Live power</div><div className="val">{fmt(watts, 1, " W")}</div><div className="sub">all units, CPU + GPU</div></div>
        <div className="card hero"><div className="lab">Units online</div><div className="val">{online} / {units?.length ?? 0}</div><div className="sub">&nbsp;</div></div>
      </div>
      <div className="uhead" style={{ margin: "18px 0 10px" }}><h3 style={{ margin: 0 }}>Units</h3><div className="spacer" /><button className="btn pri" onClick={() => setAdding(true)}>+ Add unit</button></div>
      {err && <div className="err" role="alert">{err}</div>}
      {units && units.length === 0 && <div className="card muted">No units yet. Add one to get an install command.</div>}
      <div className="grid g-units">{units?.map(u => <UnitCard key={u.id} u={u} />)}</div>
      {adding && <AddUnit onClose={() => setAdding(false)} />}
    </>
  );
}
