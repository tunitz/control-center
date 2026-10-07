import { useState } from "react";

/** Shown after creating or re-keying a unit. The unit never needs to reach the Control Center. */
export default function InstallPanel({ id, name, publicKey, fingerprint }: { id: number; name: string; publicKey: string; fingerprint: string }) {
  const [copied, setCopied] = useState(false);
  const file = `install-ccagent-${name.replace(/[^\w.-]/g, "_")}.sh`;
  const download = async () => {
    const r = await fetch(`/api/units/${id}/installer`, { credentials: "same-origin" });
    const url = URL.createObjectURL(await r.blob()), a = document.createElement("a");
    a.href = url; a.download = file; a.click(); URL.revokeObjectURL(url);
  };
  return (
    <>
      <h3 style={{ marginTop: 0 }}>Install the agent</h3>
      <p className="muted">The unit does not need to reach the Control Center: only the Control Center connects out to it over SSH.</p>
      <ol className="muted" style={{ paddingLeft: 18 }}>
        <li>Download the installer (it embeds the agent and this unit's key).</li>
        <li>Copy it to the unit, e.g. <span className="pre" style={{ display: "inline", padding: "2px 6px" }}>scp {file} user@{"<unit>"}:</span></li>
        <li>On the unit: <span className="pre" style={{ display: "inline", padding: "2px 6px" }}>sudo bash {file}</span></li>
      </ol>
      <button className="btn pri" onClick={download}>Download installer</button>
      <details style={{ marginTop: 14 }}><summary className="muted" style={{ cursor: "pointer" }}>Using the release installer instead</summary>
        <p className="muted" style={{ fontSize: 13 }}>Run the generic <code>install-ccagent.sh</code> from the private repo's latest release with this public key:</p>
        <div className="pre">sudo bash install-ccagent.sh '{publicKey}'</div>
        <button className="btn" style={{ marginTop: 8 }} onClick={async () => { await navigator.clipboard?.writeText(`sudo bash install-ccagent.sh '${publicKey}'`); setCopied(true); }}>{copied ? "Copied" : "Copy command"}</button>
      </details>
      <p className="muted" style={{ fontSize: 12 }}>Key fingerprint {fingerprint}</p>
    </>
  );
}
