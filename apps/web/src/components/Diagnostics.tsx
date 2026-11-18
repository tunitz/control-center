import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

type Check = { id: string; ok: boolean; label: string; detail: string; fix?: string };
type Report = { status: "ok" | "warn" | "error"; checks: Check[] };

export default function Diagnostics({ unitId }: { unitId: number }) {
  const [report, setReport] = useState<Report | null>(null);
  const [msg, setMsg] = useState("");
  const load = useCallback(() => api<Report>(`/units/${unitId}/diagnostic`).then(setReport).catch(e => setMsg(e.message)), [unitId]);
  useEffect(() => { load(); }, [load]);
  const probe = async () => {
    setMsg("Probing the agent");
    try {
      const r = await api<{ ok: boolean; detail: string }>(`/units/${unitId}/diagnostic/probe`, { method: "POST" });
      setMsg(r.ok ? r.detail : `Probe failed: ${r.detail}`);
    } catch (e: any) { setMsg(`Probe failed: ${e.message}`); }
    load();
  };
  const reconnect = async () => {
    try { const r = await api<{ detail: string }>(`/units/${unitId}/reconnect`, { method: "POST" }); setMsg(r.detail); }
    catch (e: any) { setMsg(e.message); }
    load();
  };
  const tone = report?.status === "ok" ? "var(--ok)" : report?.status === "warn" ? "var(--warn)" : "var(--err)";
  return (
    <section className="card" aria-labelledby="diag-h" style={{ marginTop: 14 }}>
      <div className="svc-top"><h4 id="diag-h">Diagnostics</h4><div className="spacer" />
        <span style={{ color: tone, fontWeight: 600 }}>{report?.status ?? "checking"}</span>
      </div>
      {!report && <div className="muted" role="status">Loading diagnostics</div>}
      {report?.checks.map(c => <div key={c.id} className="chk" style={{ alignItems: "flex-start" }}>
        <span className={"dot sm " + (c.ok ? "on" : "off")} style={{ marginTop: 6 }} />
        <div style={{ minWidth: 0 }}>
          <div>{c.label}</div><div className="muted" style={{ fontSize: "0.8125rem" }}>{c.detail}</div>
          {c.fix && <div className="muted" style={{ fontSize: "0.8125rem" }}>Fix: {c.fix}</div>}
        </div>
      </div>)}
      <div className="chips" style={{ marginTop: 10 }}>
        <button className="btn sm" onClick={probe}>Probe agent</button>
        <button className="btn sm" onClick={reconnect}>Reconnect</button>
        <a className="btn sm" href={`/api/units/${unitId}/installer`} download={`install-ccagent-${unitId}.sh`}>Download installer</a>
      </div>
      {msg && <div className="toast" role="status" onAnimationEnd={() => setMsg("")}>{msg}</div>}
    </section>
  );
}
