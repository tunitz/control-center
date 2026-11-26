import { useState } from "react";
import { api } from "../api";
import InstallPanel from "./InstallPanel";
import Modal from "./Modal";
export default function AddUnit({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: "", host: "", mac: "" }), [res, setRes] = useState<{ id: number; public_key: string; fingerprint: string } | null>(null), [err, setErr] = useState("");
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal label="Add unit" onClose={onClose}>
      {!res ? (
        <form onSubmit={async e => { e.preventDefault(); try { setRes(await api("/units", { method: "POST", body: f })); } catch (x: any) { setErr(x.message); } }}>
          <h3 style={{ marginTop: 0 }}>Add unit</h3>
          <label htmlFor="n">Name</label><input id="n" required value={f.name} onChange={set("name")} autoFocus />
          <label htmlFor="h">Host / IP (reachable from the Control Center)</label><input id="h" required value={f.host} onChange={set("host")} />
          <label htmlFor="m">MAC address (for Wake-on-LAN, optional)</label><input id="m" value={f.mac} onChange={set("mac")} placeholder="aa:bb:cc:dd:ee:ff" />
          {err && <div className="err" role="alert">{err}</div>}
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}><button className="btn pri">Create</button><button type="button" className="btn" onClick={onClose}>Cancel</button></div>
        </form>
      ) : (
        <>
          <InstallPanel id={res.id} name={f.name} publicKey={res.public_key} fingerprint={res.fingerprint} />
          <button className="btn" style={{ marginTop: 12 }} onClick={onClose}>Done</button>
        </>
      )}
    </Modal>
  );
}
