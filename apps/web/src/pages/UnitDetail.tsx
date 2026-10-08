import { useEffect, useMemo, useState } from "react";
import { api, fmt, gb, RANGES, type Metrics, type Unit } from "../api";
import { cached, useLive } from "../hooks";
import { Chart, type Series } from "../components/Chart";
import EditUnit from "../components/EditUnit";
import Services from "../components/Services";

const S = {
  cpu: [{ key: "cpu_pct", label: "CPU %", color: "#38e1ff" }] as Series[],
  clk: [{ key: "cpu_mhz", label: "CPU MHz", color: "#34d399" }] as Series[],
  gpu: [{ key: "gpu_pct", label: "GPU %", color: "#a78bfa" }] as Series[],
  gclk: [{ key: "gpu_mhz", label: "GPU MHz", color: "#f472b6" }] as Series[],
  vram: [{ key: "vram_used_mb", label: "VRAM MB", color: "#fbbf24" }] as Series[],
  mem: [{ key: "ram_used_mb", label: "Used MB", color: "#f472b6" }, { key: "ram_cached_mb", label: "Cached MB", color: "#38e1ff", fill: false }, { key: "swap_used_mb", label: "Swap MB", color: "#fbbf24", fill: false }] as Series[],
  pow: [{ key: "cpu_w", label: "CPU W", color: "#38e1ff" }, { key: "gpu_w", label: "GPU W", color: "#a78bfa" }] as Series[],
};
function Block({ title, m, keys, series, unit, max }: { title: string; m: Metrics; keys: string[]; series: Series[]; unit: string; max?: number }) {
  const has = keys.some(k => m.summary[k]?.avg != null);
  return (
    <div className="card"><h4>{title}</h4>
      {has ? <>
        <div className="strip">{keys.map(k => <span key={k}>{k.replace(/_(pct|mhz|mb|w)$/, "")}: min <b>{fmt(m.summary[k]?.min, 1)}</b> · avg <b>{fmt(m.summary[k]?.avg, 1)}</b> · max <b>{fmt(m.summary[k]?.max, 1)}</b></span>)}</div>
        <Chart points={m.points} series={series} unit={unit} syncKey="cc" max={max} />
      </> : <div className="muted" style={{ padding: "40px 0" }}>Not available on this unit</div>}
    </div>
  );
}
export default function UnitDetail({ id }: { id: number }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("1h");
  const { data: live, reload } = useLive<Unit>(`/units/${id}`, 5000);
  const listed = cached<Unit[]>("/units")?.find(x => x.id === id);
  const u = live ?? listed;
  const [editing, setEditing] = useState(false);
  const { data: m } = useLive<Metrics>(`/units/${id}/metrics?range=${range}`, range === "1h" ? 10000 : 60000);
  const [menu, setMenu] = useState(false), [confirm, setConfirm] = useState<null | "shutdown" | "restart" | "remove">(null), [toast, setToast] = useState("");
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); } }, [toast]);
  const remove = async () => {
    try { await api(`/units/${id}`, { method: "DELETE" }); location.hash = "#/"; } catch (e: any) { setToast(e.message); setConfirm(null); }
  };
  const act = async (action: string) => {
    try { await api(`/units/${id}/power`, { method: "POST", body: { action, confirm: action !== "wake" } }); setToast(`${action} sent`); } catch (e: any) { setToast(e.message); }
    setConfirm(null); setMenu(false);
  };
  const s = u?.static, l = u?.latest;
  const energy = useMemo(() => (m ? m.energy_wh : null), [m]);
  if (!u) return (
    <>
      <div className="uhead"><a href="#/" className="btn" aria-label="Back">←</a><span className="dot" /><div><h3 style={{ fontSize: 22 }}>&nbsp;</h3><div className="host">&nbsp;</div></div></div>
      <div className="charts" />
    </>
  );
  return (
    <>
      <div className="uhead"><a href="#/" className="btn" aria-label="Back">←</a><span className={"dot" + (u.online ? " on" : "")} /><div><h3 style={{ fontSize: 22 }}>{u.name}</h3><div className="host">{u.host} · {u.online ? "online" : "offline"}</div></div><div className="spacer" />
        <div className="menu"><button className="btn pri" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Power ▾</button>
          {menu && <div className="card pop" role="menu"><button role="menuitem" onClick={() => { setEditing(true); setMenu(false); }}>Edit IP / MAC</button><button role="menuitem" onClick={() => act("wake")}>Wake (WoL)</button><button role="menuitem" onClick={() => { setConfirm("restart"); setMenu(false); }}>Restart</button><button role="menuitem" onClick={() => { setConfirm("shutdown"); setMenu(false); }}>Shut down</button><button role="menuitem" onClick={() => { setConfirm("remove"); setMenu(false); }} style={{ color: "#fecaca" }}>Remove unit</button></div>}
        </div>
      </div>
      <div className="card specs" style={{ marginBottom: 14 }}>
        <div><div className="k">CPU</div><div className="v">{s?.cpu_model ?? "—"}</div><div className="k">{s ? `${s.cores}C/${s.threads}T · ${s.base_mhz ?? "?"}–${s.boost_mhz ?? "?"} MHz · now ${fmt(l?.cpu_mhz, 0, " MHz")}` : ""}</div></div>
        <div><div className="k">GPU</div><div className="v">{s?.gpu_model ?? "none detected"}</div><div className="k">{s?.vram_total_mb ? `VRAM ${gb(l?.vram_used_mb)} / ${gb(s.vram_total_mb)}` : ""}</div></div>
        <div><div className="k">Memory</div><div className="v">{s ? `${gb(l?.ram_used_mb)} / ${gb(s.ram_total_mb)}` : "—"}</div><div className="k">cached {gb(l?.ram_cached_mb)} · swap {gb(l?.swap_used_mb)}{s ? ` / ${gb(s.swap_total_mb)}` : ""}</div></div>
        <div><div className="k">Energy this range</div><div className="v">{energy == null ? "—" : energy >= 1000 ? (energy / 1000).toFixed(3) + " kWh" : energy.toFixed(2) + " Wh"}</div><div className="k">Month {u.month ? `${u.month.kwh.toFixed(3)} kWh · ₱${u.month.php.toFixed(2)}` : ""}</div></div>
      </div>
      <div className="sticky"><div className="chips" role="tablist" aria-label="Time range">{RANGES.map(r => <button key={r} role="tab" aria-selected={r === range} className={"chip" + (r === range ? " on" : "")} onClick={() => setRange(r)}>{r}</button>)}</div></div>
      <div className="charts">{m && <>
        <Block title="CPU usage" m={m} keys={["cpu_pct"]} series={S.cpu} unit="%" max={100} />
        <Block title="CPU clock" m={m} keys={["cpu_mhz"]} series={S.clk} unit="" />
        <Block title="GPU usage" m={m} keys={["gpu_pct"]} series={S.gpu} unit="%" max={100} />
        <Block title="GPU clock" m={m} keys={["gpu_mhz"]} series={S.gclk} unit="" />
        <Block title="VRAM" m={m} keys={["vram_used_mb"]} series={S.vram} unit="" />
        <Block title="Memory (MB)" m={m} keys={["ram_used_mb", "ram_cached_mb", "swap_used_mb"]} series={S.mem} unit="" />
        <Block title="Power (W)" m={m} keys={["cpu_w", "gpu_w"]} series={S.pow} unit=" W" />
      </>}</div>
      {u.online && <Services unitId={id} />}
      {confirm && <div className="modal" role="alertdialog" aria-modal="true" onClick={() => setConfirm(null)}><div className="card" onClick={e => e.stopPropagation()}>
        {confirm === "remove" ? <>
          <h3 style={{ marginTop: 0 }}>Remove {u.name}?</h3><p className="muted">Deletes the unit and all of its history and energy data from the Control Center. This cannot be undone. The agent stays on the unit: run <code>sudo /opt/ccagent/uninstall.sh</code> there to remove it.</p>
          <div style={{ display: "flex", gap: 8 }}><button className="btn dng" onClick={remove}>Remove unit</button><button className="btn" onClick={() => setConfirm(null)} autoFocus>Cancel</button></div>
        </> : <>
          <h3 style={{ marginTop: 0 }}>{confirm === "shutdown" ? "Shut down" : "Restart"} {u.name}?</h3><p className="muted">This takes the unit offline{confirm === "shutdown" ? ". Use Wake (WoL) to bring it back." : " briefly."} The action is audit-logged.</p>
          <div style={{ display: "flex", gap: 8 }}><button className="btn dng" onClick={() => act(confirm)}>{confirm === "shutdown" ? "Shut down" : "Restart"}</button><button className="btn" onClick={() => setConfirm(null)} autoFocus>Cancel</button></div>
        </>}
      </div></div>}
      {editing && <EditUnit unit={u} onClose={() => setEditing(false)} onSaved={() => { reload(); setToast("Saved"); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
