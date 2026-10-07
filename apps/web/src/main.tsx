import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "uplot/dist/uPlot.min.css";
import "./styles.css";
import { api } from "./api";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import UnitDetail from "./pages/UnitDetail";
import Settings from "./pages/Settings";

function useHash() {
  const [h, setH] = useState(location.hash || "#/");
  useEffect(() => { const f = () => setH(location.hash || "#/"); addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  return h;
}
function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const hash = useHash();
  useEffect(() => { api("/me").then(() => setAuthed(true)).catch(() => setAuthed(false)); }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  const unit = /^#\/unit\/(\d+)/.exec(hash), settings = hash.startsWith("#/settings");
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><div className="logo" />Control Center</div>
        <nav className="tabs"><a href="#/" className={!settings ? "on" : ""}>Dashboard</a><a href="#/settings" className={settings ? "on" : ""}>Settings</a></nav>
        <div className="spacer" />
        <button className="btn" onClick={async () => { await api("/auth/logout", { method: "POST" }); setAuthed(false); }}>Sign out</button>
      </header>
      <main>{unit ? <UnitDetail id={Number(unit[1])} /> : settings ? <Settings /> : <Dashboard />}</main>
      <nav className="tabbar"><a href="#/" className={!settings ? "on" : ""}>Dashboard</a><a href="#/settings" className={settings ? "on" : ""}>Settings</a></nav>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
