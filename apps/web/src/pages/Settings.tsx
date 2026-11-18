import { useEffect, useState } from "react";
import { api, type Unit } from "../api";
import { cached, remember, useLive } from "../hooks";
import InstallPanel from "../components/InstallPanel";
import EditUnit from "../components/EditUnit";
import Accordion, { type AccordionItem } from "../components/Accordion";
import { getThemeMode, setThemeMode, type ThemeMode } from "../theme";

const THEME_OPTIONS: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: "System" },
  { mode: "light", label: "Light" },
  { mode: "dark", label: "Dark" },
];

export default function Settings({ onSignOut }: { onSignOut: () => void }) {
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode);
  const pickTheme = (mode: ThemeMode) => { setThemeMode(mode); setTheme(mode); };
  const { data: rates, reload: rr } = useLive<{ month: string; php_per_kwh: number }[]>("/rates", 60000);
  const { data: units, reload: ru } = useLive<Unit[]>("/units", 20000);
  const { data: audit } = useLive<any[]>("/audit?limit=30", 15000);
  const DEFAULT_SETTINGS = { poll_interval_s: 5, sample_interval_s: 5, retention_days: 90 };
  const [s, setS] = useState<typeof DEFAULT_SETTINGS>(() => cached<typeof DEFAULT_SETTINGS>("/settings") ?? DEFAULT_SETTINGS), [rate, setRate] = useState(""), [msg, setMsg] = useState(""), [pw, setPw] = useState({ current: "", next: "", confirm: "" }), [edit, setEdit] = useState<Unit | null>(null), [key, setKey] = useState<null | { id: number; name: string; public_key: string; fingerprint: string }>(null);
  useEffect(() => { api<any>("/settings").then(v => { remember("/settings", v); setS(v); }); }, []);
  useEffect(() => { if (rates?.[0] && !rate) setRate(String(rates[0].php_per_kwh)); }, [rates]);
  const run = async (f: () => Promise<any>, ok: string) => { try { await f(); setMsg(ok); } catch (e: any) { setMsg(e.message); } };
  const month = rates?.[0]?.month;
  const groups: AccordionItem[] = [
    {
      id: "appearance", title: "Appearance", hint: "Light, dark or follow the device",
      body: (
        <>
            <div className="acc-sub">
              <p className="muted">Follow the device setting, or pick light or dark for this browser.</p>
              <div className="segmented" role="group" aria-label="Theme">
                {THEME_OPTIONS.map(o => <button key={o.mode} type="button" aria-pressed={theme === o.mode} onClick={() => pickTheme(o.mode)}>{o.label}</button>)}
              </div>
            </div>
        </>
      ),
    },
    {
      id: "monitoring", title: "Monitoring", hint: "Electricity rate, collection and units",
      body: (
        <>
            <div className="acc-sub"><h3 className="acc-subtitle">Electricity rate</h3>
              <p className="muted">Applies to the current month ({month}) only. Past months keep the rate they had.</p>
              <label htmlFor="rate">PHP per kWh</label><input id="rate" type="number" step="0.01" min="0" value={rate} onChange={e => setRate(e.target.value)} style={{ maxWidth: 200 }} />
              <div style={{ marginTop: 12 }}><button className="btn pri" onClick={() => run(async () => { await api(`/rates/${month}`, { method: "PUT", body: { php_per_kwh: Number(rate) } }); rr(); }, "Rate saved")}>Save rate</button></div>
              <div className="scroll" role="region" aria-label="Rate history" tabIndex={0} style={{ marginTop: 12 }}><table className="rtable"><thead><tr><th>Month</th><th>₱ / kWh</th></tr></thead><tbody>{rates?.map(r => <tr key={r.month}><td data-label="Month">{r.month}</td><td data-label="₱ / kWh">{r.php_per_kwh}</td></tr>)}</tbody></table></div>
            </div>
            <div className="acc-sub"><h3 className="acc-subtitle">Collection</h3>
              <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 12 }}>
                <div><label htmlFor="p">Poll interval (s)</label><input id="p" type="number" min="1" value={s.poll_interval_s} onChange={e => setS({ ...s, poll_interval_s: Number(e.target.value) })} /></div>
                <div><label htmlFor="sm">Default agent sampling (s)</label><input id="sm" type="number" min="1" value={s.sample_interval_s} onChange={e => setS({ ...s, sample_interval_s: Number(e.target.value) })} /></div>
                <div><label htmlFor="rt">Retention (days, max 90)</label><input id="rt" type="number" min="1" max="90" value={s.retention_days} onChange={e => setS({ ...s, retention_days: Number(e.target.value) })} /></div>
              </div>
              <div style={{ marginTop: 12 }}><button className="btn pri" onClick={() => run(() => api("/settings", { method: "PUT", body: s }), "Settings saved")}>Save</button></div>
            </div>
            <div className="acc-sub"><h3 className="acc-subtitle">Units</h3>
              <div className="scroll" role="region" aria-label="Units" tabIndex={0}><table className="rtable"><thead><tr><th>Name</th><th>Host</th><th>MAC</th><th>Key</th><th></th></tr></thead><tbody>{units?.map(u => <tr key={u.id}><td data-label="Name">{u.name}</td><td data-label="Host">{u.host}</td><td data-label="MAC">{u.mac ?? "—"}</td><td data-label="Key" title={u.fingerprint ?? ""}>{u.fingerprint?.slice(0, 18)}</td>
                <td data-label="Actions" style={{ whiteSpace: "nowrap" }}><button className="btn" onClick={() => setEdit(u)}>Edit</button>{" "}<button className="btn" onClick={() => run(async () => { const r = await api<any>(`/units/${u.id}/rekey`, { method: "POST" }); setKey({ id: u.id, name: u.name, public_key: r.public_key, fingerprint: r.fingerprint }); ru(); }, "New key issued: re-run the installer on the unit")}>Rotate key</button>{" "}
                  <button className="btn dng" onClick={() => { if (confirm(`Remove ${u.name} and delete all its history? The agent on the unit is not touched (run /opt/ccagent/uninstall.sh there).`)) run(async () => { await api(`/units/${u.id}`, { method: "DELETE" }); ru(); }, "Unit removed"); }}>Remove</button></td></tr>)}</tbody></table></div>
              {key && <div style={{ marginTop: 12 }}><InstallPanel id={key.id} name={key.name} publicKey={key.public_key} fingerprint={key.fingerprint} /></div>}
            </div>
        </>
      ),
    },
    {
      id: "security", title: "Security", hint: "Password and audit log",
      body: (
        <>
            <div className="acc-sub"><h3 className="acc-subtitle">Reset password</h3>
              <label htmlFor="cp">Current</label><input id="cp" type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} style={{ maxWidth: 300 }} />
              <label htmlFor="np">New (min 8)</label><input id="np" type="password" autoComplete="new-password" minLength={8} value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} style={{ maxWidth: 300 }} />
              <label htmlFor="cf">Confirm new</label><input id="cf" type="password" autoComplete="new-password" minLength={8} value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} style={{ maxWidth: 300 }} />
              <div style={{ marginTop: 12 }}><button className="btn" onClick={() => run(async () => { if (pw.next !== pw.confirm) throw new Error("Passwords do not match"); await api("/auth/password", { method: "POST", body: { current: pw.current, next: pw.next } }); setPw({ current: "", next: "", confirm: "" }); }, "Password changed")}>Reset password</button></div>
            </div>
            <div className="acc-sub"><h3 className="acc-subtitle">Audit log</h3>
              <div className="scroll" role="region" aria-label="Audit log" tabIndex={0}><table className="rtable"><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Unit</th><th>Detail</th></tr></thead><tbody>{audit?.map(a => <tr key={a.id}><td data-label="Time">{new Date(a.ts * 1000).toLocaleString()}</td><td data-label="Actor">{a.actor}</td><td data-label="Action">{a.action}</td><td data-label="Unit">{a.unit ?? ""}</td><td data-label="Detail" className="muted">{a.detail}</td></tr>)}</tbody></table></div>
            </div>
        </>
      ),
    },
  ];

  return (
    <div className="grid" style={{ gap: 14 }}>
      {msg && <div className="toast" role="status" onAnimationEnd={() => setTimeout(() => setMsg(""), 3000)}>{msg}</div>}
      <Accordion items={groups} storageKey="cc:settings-open" defaultOpen="appearance" />
      {edit && <EditUnit unit={edit} onClose={() => setEdit(null)} onSaved={() => { ru(); setMsg("Unit saved"); }} />}
      <button className="btn dng" style={{ width: "100%", minHeight: 44 }} onClick={onSignOut}>Sign out</button>
    </div>
  );
}
