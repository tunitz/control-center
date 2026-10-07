import { useEffect, useState } from "react";
import { copyText } from "../clipboard";

/** Shown after creating or re-keying a unit. The unit never needs to reach the Control Center. */
export default function InstallPanel({ id, name, publicKey, fingerprint }: { id: number; name: string; publicKey: string; fingerprint: string }) {
  const [tab, setTab] = useState<"paste" | "download">("paste");
  const [paste, setPaste] = useState("");
  const [copied, setCopied] = useState<"paste" | "key" | "failed" | null>(null);
  const file = `install-ccagent-${name.replace(/[^\w.-]/g, "_")}.sh`;
  useEffect(() => {
    fetch(`/api/units/${id}/installer?format=paste`, { credentials: "same-origin" }).then(r => r.text()).then(setPaste).catch(() => {});
  }, [id]);
  const download = async () => {
    const r = await fetch(`/api/units/${id}/installer`, { credentials: "same-origin" });
    const url = URL.createObjectURL(await r.blob()), a = document.createElement("a");
    a.href = url; a.download = file; a.click(); URL.revokeObjectURL(url);
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
        <button className={"chip" + (tab === "paste" ? " on" : "")} onClick={() => setTab("paste")}>Copy-paste command</button>
        <button className={"chip" + (tab === "download" ? " on" : "")} onClick={() => setTab("download")}>Download installer</button>
      </div>
      {tab === "paste" ? <>
        <button className="btn pri" disabled={!paste} onClick={() => copy(paste, "paste")}>{copied === "paste" ? "Copied to clipboard" : copied === "failed" ? "Copy blocked: select the text below" : "Copy install command"}</button>
        <p className="muted" style={{ fontSize: 13 }}>Paste it into a terminal on the unit and it installs as root. Everything needed is inside the paste, so the unit needs no access to the Control Center. {paste ? `${Math.round(paste.length / 1024)} KB.` : ""}</p>
        <details open={copied === "failed"}><summary className="muted" style={{ cursor: "pointer" }}>{copied === "failed" ? "Tap the box, select all, copy" : "Preview"}</summary><textarea readOnly value={paste || "loading…"} onFocus={e => e.currentTarget.select()} aria-label="Install command" style={{ width: "100%", height: 160, fontFamily: "ui-monospace,monospace", fontSize: 16, background: "#080b1c", border: "1px solid var(--line)", borderRadius: 10, color: "var(--text)", padding: 10 }} /></details>
      </> : <>
        <ol className="muted" style={{ paddingLeft: 18 }}>
          <li>Download the installer (it embeds the agent and this unit's key).</li>
          <li>Copy it to the unit, e.g. <span className="pre" style={{ display: "inline", padding: "2px 6px" }}>scp {file} user@{"<unit>"}:</span></li>
          <li>On the unit: <span className="pre" style={{ display: "inline", padding: "2px 6px" }}>sudo bash {file}</span></li>
        </ol>
        <button className="btn pri" onClick={download}>Download installer</button>
      </>}
      <details style={{ marginTop: 14 }}><summary className="muted" style={{ cursor: "pointer" }}>Release installer (private repo)</summary>
        <p className="muted" style={{ fontSize: 13 }}>If the unit can fetch from GitHub with your token: download <code>install-ccagent.sh</code> from the latest release, then pass this unit's public key:</p>
        <div className="pre">sudo bash install-ccagent.sh '{publicKey}'</div>
        <button className="btn" style={{ marginTop: 8 }} onClick={() => copy(`sudo bash install-ccagent.sh '${publicKey}'`, "key")}>{copied === "key" ? "Copied" : copied === "failed" ? "Copy blocked: long-press the text above" : "Copy public key command"}</button>
      </details>
      <p className="muted" style={{ fontSize: 12 }}>Key fingerprint {fingerprint}</p>
    </>
  );
}
