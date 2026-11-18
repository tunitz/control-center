import { useState } from "react";
import { api, type Unit } from "../api";

export default function EditUnit({ unit, onClose, onSaved }: { unit: Unit; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({ name: unit.name, host: unit.host, ssh_port: String(unit.ssh_port ?? 62478), mac: unit.mac ?? "", broadcast: unit.broadcast ?? "255.255.255.255" });
  const [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Edit unit" onClick={onClose}><div className="card" onClick={e => e.stopPropagation()}>
      <form onSubmit={async e => { e.preventDefault(); setBusy(true); try { await api(`/units/${unit.id}`, { method: "PATCH", body: { ...f, ssh_port: Number(f.ssh_port) } }); onSaved(); onClose(); } catch (x: any) { setErr(x.message); setBusy(false); } }}>
        <h3 style={{ marginTop: 0 }}>Edit {unit.name}</h3>
        <label htmlFor="en">Name</label><input id="en" required value={f.name} onChange={set("name")} />
        <label htmlFor="eh">Host / IP</label><input id="eh" required value={f.host} onChange={set("host")} inputMode="url" autoCapitalize="none" />
        <label htmlFor="ep">SSH port</label><input id="ep" required type="number" min="1" max="65535" value={f.ssh_port} onChange={set("ssh_port")} />
        <label htmlFor="em">MAC address (Wake-on-LAN)</label><input id="em" value={f.mac} onChange={set("mac")} placeholder="aa:bb:cc:dd:ee:ff" autoCapitalize="none" />
        <label htmlFor="eb">Broadcast address</label><input id="eb" value={f.broadcast} onChange={set("broadcast")} inputMode="decimal" />
        <p className="muted" style={{ fontSize: 12 }}>Changing the IP or port reconnects the unit right away. History and the SSH key are kept, so the agent does not need reinstalling.</p>
        {err && <div className="err" role="alert">{err}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}><button className="btn pri" disabled={busy}>Save</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
      </form>
    </div></div>
  );
}
