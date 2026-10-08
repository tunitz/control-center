import { useState } from "react";
import { api } from "../api";
export default function Login({ onDone }: { onDone: () => void }) {
  const [pw, setPw] = useState(""), [err, setErr] = useState("");
  return (
    <div className="login"><form className="card" onSubmit={async e => { e.preventDefault(); try { await api("/auth/login", { method: "POST", body: { password: pw } }); onDone(); } catch (x: any) { setErr(x.message); } }}>
      <div className="brand"><div className="logo" />Control Center</div>
      <label htmlFor="pw">Admin password</label>
      <input id="pw" type="password" autoFocus autoComplete="current-password" value={pw} onChange={e => setPw(e.target.value)} />
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn pri" style={{ width: "100%" }}>Sign in</button>
    </form></div>
  );
}
