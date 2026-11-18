import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmt, gb, RANGES, type Metrics, type Unit } from "../api";
import type { DiskSnapshot } from "../lib/disks";
import { cached, useLive } from "../hooks";
import { Chart, type Series } from "../components/Chart";
import EditUnit from "../components/EditUnit";
import Services from "../components/Services";
import { navigate } from "../route";
import Modal from "../components/Modal";
import ActionMenu from "../components/ActionMenu";
import { DiskList } from "../components/DiskList";
import { hasSeries, rateUnit } from "../lib/disks";
import { sampleLabel } from "../lib/format";
import EnergyHistory from "../components/EnergyHistory";
import Diagnostics from "../components/Diagnostics";

const S = {
  cpu: [{ key: "cpu_pct", label: "CPU %", color: "var(--s1)" }] as Series[],
  clk: [{ key: "cpu_mhz", label: "CPU MHz", color: "var(--s2)" }] as Series[],
  gpu: [{ key: "gpu_pct", label: "GPU %", color: "var(--s3)" }] as Series[],
  gclk: [{ key: "gpu_mhz", label: "GPU MHz", color: "var(--s4)" }] as Series[],
  vram: [{ key: "vram_used_mb", label: "VRAM MB", color: "var(--s5)" }] as Series[],
  mem: [{ key: "ram_used_mb", label: "Used MB", color: "var(--s4)" }, { key: "ram_cached_mb", label: "Cached MB", color: "var(--s1)", fill: false }, { key: "swap_used_mb", label: "Swap MB", color: "var(--s5)", fill: false }] as Series[],
  pow: [{ key: "cpu_w", label: "CPU W", color: "var(--s1)" }, { key: "gpu_w", label: "GPU W", color: "var(--s3)" }] as Series[],
  diskIo: [{ key: "disk_read_kbs", label: "Read", color: "var(--s1)" }, { key: "disk_write_kbs", label: "Write", color: "var(--s4)" }] as Series[],
  diskUse: [{ key: "disk_used_pct", label: "Used %", color: "var(--s3)" }] as Series[],
  diskTemp: [{ key: "disk_temp_c", label: "Temp C", color: "var(--s5)" }] as Series[],
};
function Block({ title, m, keys, series, unit, max, labels, scale = 1 }: { title: string; m: Metrics; keys: string[]; series: Series[]; unit: string; max?: number; labels?: Record<string, string>; scale?: number }) {
  const has = keys.some(k => m.summary[k]?.avg != null);
  const sc = (v: number | null | undefined) => (v == null ? null : v * scale);
  return (
    <div className="card"><h4>{title}</h4>
      {has ? <>
        <div className="strip">{keys.map(k => <span key={k}>{labels?.[k] ?? k.replace(/_(pct|mhz|mb|w)$/, "")}: min <b>{fmt(sc(m.summary[k]?.min), 1)}</b> · avg <b>{fmt(sc(m.summary[k]?.avg), 1)}</b> · max <b>{fmt(sc(m.summary[k]?.max), 1)}</b></span>)}</div>
        <Chart points={m.points} series={series} unit={unit} syncKey="cc" max={max} />
      </> : <div className="muted" style={{ padding: "40px 0" }}>Not available on this unit</div>}
    </div>
  );
}
function DiskIO({ m }: { m: Metrics }) {
  const peak = Math.max(m.summary.disk_read_kbs?.max ?? 0, m.summary.disk_write_kbs?.max ?? 0);
  const { scale, unit } = rateUnit(peak);
  const series = S.diskIo.map(s => ({ ...s, scale }));
  return <Block title="Disk IO" m={m} keys={["disk_read_kbs", "disk_write_kbs"]} series={series} unit={unit} labels={{ disk_read_kbs: "Read", disk_write_kbs: "Write" }} scale={scale} />;
}
export default function UnitDetail({ id }: { id: number }) {
  const [range, setRange] = useState<(typeof RANGES)[number]>("1h");
  const { data: live, reload } = useLive<Unit>(`/units/${id}`, 5000);
  const listed = cached<Unit[]>("/units")?.find(x => x.id === id);
  const u = live ?? listed;
  const [editing, setEditing] = useState(false);
  const { data: m } = useLive<Metrics>(`/units/${id}/metrics?range=${range}`, range === "1h" ? 10000 : 60000);
  const [confirm, setConfirm] = useState<null | "shutdown" | "restart" | "remove">(null), [toast, setToast] = useState("");
  useEffect(() => { setConfirm(null); setEditing(false); }, [id]);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(""), 3500); return () => clearTimeout(t); } }, [toast]);
  const remove = async () => {
    try { await api(`/units/${id}`, { method: "DELETE" }); navigate("#/"); } catch (e: any) { setToast(e.message); setConfirm(null); }
  };
  const act = async (action: string) => {
    try {
      const r = await api<{ status?: string; delivery?: string }>(`/units/${id}/power`, { method: "POST", body: { action, confirm: action !== "wake" } });
      const verb = action === "wake" ? "Wake packet" : action;
      setToast(r.status === "accepted" ? `${verb} ${r.delivery === "broadcast" ? "broadcast" : "sent"}` : `${verb}: delivery unconfirmed`);
    } catch (e: any) {
      setToast(e?.status === "delivery_unknown" ? `${action}: delivery unconfirmed` : e.message);
    }
    setConfirm(null);
  };
  const s = u?.static, l = u?.latest;
  const needsMigration = u?.migration_pending_port != null;
  const energy = useMemo(() => (m ? m.energy_wh : null), [m]);
  if (!u) return (
    <>
      <div className="uhead"><a href="#/" className="btn" aria-label="Back">←</a><span className="dot" /><div><h3 style={{ fontSize: 22 }}>&nbsp;</h3><div className="host">&nbsp;</div></div></div>
      <div className="charts" />
    </>
  );
  return (
    <>
      <div className="uhead"><a href="#/" className="btn" aria-label="Back">←</a><span className={"dot" + (u.online ? " on" : "")} /><div><h3 style={{ fontSize: 22 }}>{u.name}</h3><div className="host">{u.host} · {u.online ? "online" : "offline"}</div><div className={"sample" + (u.sample_fresh === false ? " stale" : "")}>{sampleLabel(u.last_sample_ts, u.sample_fresh)}</div></div><div className="spacer" />
        <ActionMenu label="Power" actions={[
          { label: "Edit IP / MAC", onSelect: () => setEditing(true) },
          { label: "Wake (WoL)", onSelect: () => act("wake") },
          { label: "Restart", onSelect: () => setConfirm("restart") },
          { label: "Shut down", onSelect: () => setConfirm("shutdown"), danger: true },
          { label: "Remove unit", onSelect: () => setConfirm("remove"), danger: true },
        ]} />
      </div>
      {needsMigration && <div className="err" role="alert" style={{ marginBottom: 14 }}>Agent SSH port migration required: reinstall the agent on this unit, then clear the pending port in Settings. It stays offline until verified.</div>}
      <div className="card specs" style={{ marginBottom: 14 }}>
        <div><div className="k">CPU</div><div className="v">{s?.cpu_model ?? "—"}</div><div className="k">{s ? `${s.cores}C/${s.threads}T · ${s.base_mhz ?? "?"}–${s.boost_mhz ?? "?"} MHz · now ${fmt(l?.cpu_mhz, 0, " MHz")}` : ""}</div></div>
        <div><div className="k">GPU</div><div className="v">{s?.gpu_model ?? "none detected"}</div><div className="k">{s?.vram_total_mb ? `VRAM ${gb(l?.vram_used_mb)} / ${gb(s.vram_total_mb)}` : ""}</div></div>
        <div><div className="k">Memory</div><div className="v">{s ? `${gb(l?.ram_used_mb)} / ${gb(s.ram_total_mb)}` : "—"}</div><div className="k">cached {gb(l?.ram_cached_mb)} · swap {gb(l?.swap_used_mb)}{s ? ` / ${gb(s.swap_total_mb)}` : ""}</div></div>
        <div><div className="k">Measured wall power</div><div className="v">{u.wall_w != null ? fmt(u.wall_w, 1, " W") : "—"}</div><div className="k">{u.wall_ts ? `at ${new Date(u.wall_ts * 1000).toLocaleTimeString()}` : "no wall meter configured"}</div></div>
        <div><div className="k">Energy this range</div><div className="v">{energy == null ? "—" : energy >= 1000 ? (energy / 1000).toFixed(3) + " kWh" : energy.toFixed(2) + " Wh"}</div><div className="k">Month {u.month ? `${u.month.kwh.toFixed(3)} kWh · ₱${u.month.php.toFixed(2)}` : ""}</div></div>
      </div>
      <div className="sticky"><div className="chips" role="group" aria-label="Time range">{RANGES.map(r => <button key={r} aria-pressed={r === range} className={"chip" + (r === range ? " on" : "")} onClick={() => setRange(r)}>{r}</button>)}</div></div>
      <div className="charts">{!m && <div className="card muted" role="status">Loading history. If this persists, check the unit connection.</div>}{m && <>
        <Block title="CPU usage" m={m} keys={["cpu_pct"]} series={S.cpu} unit="%" max={100} />
        <Block title="CPU clock" m={m} keys={["cpu_mhz"]} series={S.clk} unit="" />
        <Block title="GPU usage" m={m} keys={["gpu_pct"]} series={S.gpu} unit="%" max={100} />
        <Block title="GPU clock" m={m} keys={["gpu_mhz"]} series={S.gclk} unit="" />
        <Block title="VRAM" m={m} keys={["vram_used_mb"]} series={S.vram} unit="" />
        <Block title="Memory (MB)" m={m} keys={["ram_used_mb", "ram_cached_mb", "swap_used_mb"]} series={S.mem} unit="" />
        <Block title="Power (W) · estimated CPU+GPU" m={m} keys={["cpu_w", "gpu_w"]} series={S.pow} unit=" W" />
      </>}</div>
      {(u.disks?.mounts.length || m) && <section aria-label="Disks" className="disks">
        <h3 style={{ fontSize: 18, margin: "8px 0 12px" }}>Disks</h3>
        {u.disks && u.disks.mounts.length > 0 && <div style={{ marginBottom: 16 }}><DiskList mounts={u.disks.mounts} /></div>}
        {m && <div className="charts">
          <DiskIO m={m} />
          <Block title="Disk usage" m={m} keys={["disk_used_pct"]} series={S.diskUse} unit="%" max={100} labels={{ disk_used_pct: "Used" }} />
          {hasSeries(m.points, "disk_temp_c") && <Block title="Disk temperature" m={m} keys={["disk_temp_c"]} series={S.diskTemp} unit=" °C" labels={{ disk_temp_c: "Temp" }} />}
        </div>}
      </section>}
      <EnergyHistory unitId={id} />
      <Diagnostics unitId={id} />
      {u.online && <Services unitId={id} />}
      {confirm && <Modal label={`Confirm ${confirm} ${u.name}`} onClose={() => setConfirm(null)}>
        {confirm === "remove" ? <>
          <h3 style={{ marginTop: 0 }}>Remove {u.name}?</h3><p className="muted">Deletes the unit and all of its history and energy data from the Control Center. This cannot be undone. The agent stays on the unit: run <code>sudo /opt/ccagent/uninstall.sh</code> there to remove it.</p>
          <div style={{ display: "flex", gap: 8 }}><button className="btn dng" onClick={remove}>Remove unit</button><button className="btn" onClick={() => setConfirm(null)} data-safe>Cancel</button></div>
        </> : <>
          <h3 style={{ marginTop: 0 }}>{confirm === "shutdown" ? "Shut down" : "Restart"} {u.name}?</h3><p className="muted">This takes the unit offline{confirm === "shutdown" ? ". Use Wake (WoL) to bring it back." : " briefly."} The action is audit-logged.</p>
          <div style={{ display: "flex", gap: 8 }}><button className="btn dng" onClick={() => act(confirm)}>{confirm === "shutdown" ? "Shut down" : "Restart"}</button><button className="btn" onClick={() => setConfirm(null)} data-safe>Cancel</button></div>
        </>}
      </Modal>}
      {editing && <EditUnit unit={u} onClose={() => setEditing(false)} onSaved={() => { reload(); setToast("Saved"); }} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
