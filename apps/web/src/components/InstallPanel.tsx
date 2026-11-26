import { useEffect, useState } from "react";
import { copyText } from "../clipboard";

/** Shown after creating or re-keying a unit. The unit never needs to reach the Control Center. */
export default function InstallPanel({ id, name, publicKey, fingerprint }: { id: number; name: string; publicKey: string; fingerprint: string }) {
  const [tab, setTab] = useState<"curl" | "paste" | "download">("curl");
  const [paste, setPaste] = useState("");
  const [curl, setCurl] = useState("");
  const [sudo, setSudo] = useState(true);
  const [copied, setCopied] = useState<"paste" | "key" | "failed" | null>(null);
  const file = `install-ccagent-${name.replace(/[^\w.-]/g, "_")}.sh`;
  useEffect(() => {
    const q = sudo ? "" : "&sudo=0";
    fetch(`/api/units/${id}/installer?format=paste${q}`, { credentials: "same-origin" }).then(r => r.text()).then(setPaste).catch(() => {});
    fetch(`/api/units/${id}/installer?format=curl${q}`, { credentials: "same-origin" }).then(r => r.text()).then(setCurl).catch(() => {});
  }, [id, sudo]);
  const download = async () => {
    const r = await fetch(`/api/units/${id}/installer`, { credentials: "same-origin" });
    if (!r.ok) { setCopied("failed"); return; }
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url; a.download = file; a.style.display = "none";
    document.body.appendChild(a);
    try { a.click(); } finally {
      a.remove();
      // Revoking immediately can cancel the download in some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }
  };
  const copy = async (text: string, which: "paste" | "key") => {
    const ok = await copyText(text);
    setCopied(ok ? which : "failed"); setTimeout(() => setCopied(null), ok ? 2500 : 8000);
  };
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Install the agent</h3>
      <p className="muted">The unit does not need to reach the Control Center: only the Control Center connects out to it over SSH.</p>
      <div className="chips" style={{ marginBottom: 12 }}>
        <button className={"chip" + (tab === "curl" ? " on" : "")} onClick={() => setTab("curl")}>Short command</button>
        <button className={"chip" + (tab === "paste" ? " on" : "")} onClick={() => setTab("paste")}>Offline paste</button>
        <button className={"chip" + (tab === "download" ? " on" : "")} onClick={() => setTab("download")}>Download installer</button>
      </div>
      {tab !== "download" && <div className="chips" style={{ marginBottom: 10 }} role="group" aria-label="Run as">
        <button className={"chip" + (sudo ? " on" : "")} aria-pressed={sudo} onClick={() => setSudo(true)}>With sudo</button>
        <button className={"chip" + (!sudo ? " on" : "")} aria-pressed={!sudo} onClick={() => setSudo(false)}>No sudo (already root)</button>
      </div>}
      {tab === "curl" ? <>
        <div className="pre" style={{ userSelect: "all" }}>{curl || "Loading command"}</div>
        <button className="btn pri" style={{ marginTop: 8 }} disabled={!curl} onClick={() => copy(curl, "paste")}>{copied === "paste" ? "Copied to clipboard" : copied === "failed" ? "Copy blocked: long-press the command above" : "Copy command"}</button>
        <p className="muted" style={{ fontSize: 13 }}>Run it on the unit. It downloads the installer from the public ccagent release (no login, no secrets) and authorizes only this unit's public key. The unit needs internet, not access to the Control Center. No internet there? Use Offline paste. Proxmox hosts and root shells have no sudo: pick "No sudo".</p>
      </> : tab === "paste" ? <>
        <button className="btn pri" disabled={!paste} onClick={() => copy(paste, "paste")}>{copied === "paste" ? "Copied to clipboard" : copied === "failed" ? "Copy blocked: select the text below" : "Copy install command"}</button>
        <p className="muted" style={{ fontSize: 13 }}>Paste it into a terminal on the unit and it installs as root. Everything needed is inside the paste, so the unit needs no access to the Control Center. {paste ? `${Math.round(paste.length / 1024)} KB.` : ""}</p>
        <details open={copied === "failed"}><summary className="muted" style={{ cursor: "pointer" }}>{copied === "failed" ? "Tap the box, select all, copy" : "Preview"}</summary><textarea readOnly value={paste || "Loading command"} onFocus={e => e.currentTarget.select()} aria-label="Install command" style={{ width: "100%", height: 160, fontFamily: "ui-monospace,monospace", fontSize: 16, background: "var(--surface2)", border: "1px solid var(--line)", borderRadius: 10, color: "var(--text)", padding: 10 }} /></details>
      </> : <>
        <ol className="muted" style={{ paddingLeft: 18 }}>
          <li>Download the installer (it embeds the agent and this unit's key).</li>
          <li>Copy it to the unit, e.g. <span className="pre" style={{ display: "inline", padding: "2px 6px" }}>scp {file} user@{"<unit>"}:</span></li>
          <li>On the unit: <span className="pre" style={{ display: "inline", padding: "2px 6px" }}>sudo bash {file}</span></li>
        </ol>
        <button className="btn pri" onClick={download}>Download installer</button>
      </>}
      <details style={{ marginTop: 14 }}><summary className="muted" style={{ cursor: "pointer" }}>Public key</summary>
        <div className="pre" style={{ marginTop: 8 }}>{publicKey}</div>
      </details>
      <p className="muted" style={{ fontSize: 12 }}>Key fingerprint {fingerprint}</p>
    </>
  );
}
