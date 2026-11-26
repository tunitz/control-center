import { useState } from "react";
import { api } from "../api";

/** One auth form for both states: first-run setup (no hash yet) and normal login. */
export default function Login({ onDone, mode = "login", needsToken = false }: { onDone: () => void; mode?: "login" | "setup"; needsToken?: boolean }) {
  const setup = mode === "setup";
  const [pw, setPw] = useState(""), [confirm, setConfirm] = useState(""), [token, setToken] = useState(""), [err, setErr] = useState(""), [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    if (setup && pw !== confirm) { setErr("Passwords do not match"); return; }
    setBusy(true);
    try {
      await api(setup ? "/auth/setup" : "/auth/login", { method: "POST", body: setup ? { password: pw, bootstrap_token: token } : { password: pw } });
      onDone();
    } catch (x: any) { setErr(x.message); setBusy(false); }
  };
  return (
    <div className="login"><form className="card" onSubmit={submit}>
      <div className="brand"><img className="logo" src="/favicon.svg" alt="" width="26" height="26" />Control Center</div>
      <label htmlFor="pw">{setup ? "Set admin password" : "Admin password"}</label>
      <input id="pw" type="password" autoFocus autoComplete={setup ? "new-password" : "current-password"} minLength={setup ? 8 : undefined} value={pw} onChange={e => setPw(e.target.value)} />
      {setup && <>
        <label htmlFor="cf">Confirm password</label>
        <input id="cf" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} />
        {needsToken && <><label htmlFor="bt">Bootstrap token</label><input id="bt" type="password" autoComplete="off" value={token} onChange={e => setToken(e.target.value)} required /></>}
      </>}
      {err && <div className="err" role="alert">{err}</div>}
      <button className="btn pri" disabled={busy}>{setup ? "Set password" : "Sign in"}</button>
      {setup && <p className="muted" style={{ fontSize: 13 }}>First run: choose a password of at least 8 characters. You can change it later in Settings.</p>}
    </form></div>
  );
}
