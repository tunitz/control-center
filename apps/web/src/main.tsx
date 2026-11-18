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
import { initSwipeBack } from "./swipe";

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
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [needsToken, setNeedsToken] = useState(false);
  const hash = useHash();
  useEffect(() => {
    api<{ setupNeeded: boolean; needsBootstrapToken?: boolean; authed: boolean }>("/auth/status")
      .then(s => { setSetupNeeded(s.setupNeeded); setNeedsToken(!!s.needsBootstrapToken); writeAuthed(s.authed); setAuthed(s.authed); if (!s.authed) clearCache(); })
      .catch(() => { writeAuthed(false); clearCache(); setAuthed(false); });
  }, []);
  const done = () => { writeAuthed(true); setSetupNeeded(false); setAuthed(true); };
  if (authed === null) return null;
  if (setupNeeded) return <Login mode="setup" needsToken={needsToken} onDone={done} />;
  if (!authed) return <Login onDone={done} />;
  const unit = /^#\/unit\/(\d+)/.exec(hash), settings = hash.startsWith("#/settings");
  const signOut = async () => { await api("/auth/logout", { method: "POST" }); clearCache(); writeAuthed(false); setAuthed(false); };
  useEffect(() => {
    const path = unit ? `Unit ${unit[1]}` : settings ? "Settings" : "Dashboard";
    document.title = `${path} · Control Center`;
  }, [hash]);
  return (
    <div className="app">
      <a className="skip" href="#main">Skip to content</a>
      <header className="top">
        <div className="brand"><img className="logo" src="/favicon.svg" alt="" width="26" height="26" />Control Center</div>
        <nav className="tabs" aria-label="Main"><a href="#/" aria-current={!settings ? "page" : undefined} className={!settings ? "on" : ""}>Dashboard</a><a href="#/settings" aria-current={settings ? "page" : undefined} className={settings ? "on" : ""}>Settings</a></nav>
        <div className="spacer" />
      </header>
      <main id="main">{unit ? <UnitDetail id={Number(unit[1])} /> : settings ? <Settings onSignOut={signOut} /> : <Dashboard />}</main>
      <nav className="tabbar" aria-label="Main"><a href="#/" aria-current={!settings ? "page" : undefined} className={!settings ? "on" : ""}>Dashboard</a><a href="#/settings" aria-current={settings ? "page" : undefined} className={settings ? "on" : ""}>Settings</a></nav>
    </div>
  );
}
initTheme();
initSwipeBack();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
