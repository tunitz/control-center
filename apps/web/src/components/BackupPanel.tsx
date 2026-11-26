import { useEffect, useState } from "react";
import { api } from "../api";

export default function BackupPanel() {
  const [status, setStatus] = useState<{ masterKeyRequired: boolean; schemaVersion: string; note: string } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<typeof status>("/backup/status").then(setStatus).catch(e => setMsg(e.message)); }, []);
  const restore = async () => {
    if (!file) { setMsg("Choose a .db backup first"); return; }
    setBusy(true); setMsg("");
    try {
      const form = new FormData(); form.append("file", file);
      const r = await fetch("/api/restore", { method: "POST", credentials: "same-origin", headers: { "x-cc": "1" }, body: form });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      setMsg(`Restored ${j.tables} tables. Reload to see the data.`);
    } catch (e: any) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  return (
    <div className="acc-sub">
      <h3 className="acc-subtitle">Download a backup</h3>
      <p className="muted">A consistent SQLite snapshot of units, history, settings and alerts. Schema version {status?.schemaVersion ?? "loading"}.</p>
      <a className="btn pri" href="/api/backup" download>Download backup</a>

      <h3 className="acc-subtitle">Restore a backup</h3>
      <p className="err" role="note">Backups do not contain CC_MASTER_KEY. Restore on an instance using the same master key, or unit SSH keys cannot be decrypted. Restore replaces all current data in one transaction.</p>
      <div className="chips">
        <input type="file" accept=".db,application/octet-stream" aria-label="Backup file" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        <button className="btn dng" disabled={busy || !file} onClick={restore}>{busy ? "Restoring" : "Restore"}</button>
      </div>
      {msg && <div className="toast" role="status" onAnimationEnd={() => setMsg("")}>{msg}</div>}
    </div>
  );
}
