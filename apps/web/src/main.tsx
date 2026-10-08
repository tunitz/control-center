import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "uplot/dist/uPlot.min.css";
import "./styles.css";
import { api } from "./api";
import { subscribeHash } from "./route";
import { clearCache } from "./hooks";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import UnitDetail from "./pages/UnitDetail";
import Settings from "./pages/Settings";
import { initTheme } from "./theme";

function useHash() {
  const [h, setH] = useState(location.hash || "#/");
  const prev = useRef(h);
  useEffect(() => subscribeHash(setH), []);
  // scroll to top on navigation only (not on first render / StrictMode re-runs)
  useEffect(() => {
    if (prev.current === h) return;
    prev.current = h;
    window.scrollTo(0, 0);
  }, [h]);
  return h;
}
const AUTH_KEY = "cc:authed";
/** Previous-session hint: lets a cold load render immediately while /me validates in the background. */
const readAuthed = (): boolean | null => { try { return localStorage.getItem(AUTH_KEY) === "1" ? true : null; } catch { return null; } };
const writeAuthed = (on: boolean) => { try { if (on) localStorage.setItem(AUTH_KEY, "1"); else localStorage.removeItem(AUTH_KEY); } catch { /* ignore */ } };
function App() {
  const [authed, setAuthed] = useState<boolean | null>(readAuthed);
  const hash = useHash();
  useEffect(() => {
    api("/me")
      .then(() => { writeAuthed(true); setAuthed(true); })
      .catch(() => { writeAuthed(false); clearCache(); setAuthed(false); });
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  const unit = /^#\/unit\/(\d+)/.exec(hash), settings = hash.startsWith("#/settings");
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><div className="logo" />Control Center</div>
        <nav className="tabs"><a href="#/" className={!settings ? "on" : ""}>Dashboard</a><a href="#/settings" className={settings ? "on" : ""}>Settings</a></nav>
        <div className="spacer" />
        <button className="btn" onClick={async () => { await api("/auth/logout", { method: "POST" }); clearCache(); writeAuthed(false); setAuthed(false); }}>Sign out</button>
      </header>
      <main>{unit ? <UnitDetail id={Number(unit[1])} /> : settings ? <Settings /> : <Dashboard />}</main>
      <nav className="tabbar"><a href="#/" className={!settings ? "on" : ""}>Dashboard</a><a href="#/settings" className={settings ? "on" : ""}>Settings</a></nav>
    </div>
  );
}
initTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
