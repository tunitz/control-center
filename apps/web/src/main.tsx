import { lazy, StrictMode, Suspense, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "uplot/dist/uPlot.min.css";
import "./styles.css";
import { api } from "./api";
import { navigate, subscribeHash } from "./route";
import { lastChatHash } from "./chat/last";
import { clearCache } from "./hooks";
import Login from "./pages/Login";
import Dashboard from "./pages/Dashboard";
import UnitDetail from "./pages/UnitDetail";
import Settings from "./pages/Settings";
// Chat is its own lazy chunk (markdown, highlighting, chat CSS load only when opened).
const Chat = lazy(() => import("./pages/Chat"));
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
  const hash = useHash();
  useEffect(() => {
    api("/me")
      .then(() => { writeAuthed(true); setAuthed(true); })
      .catch(() => { writeAuthed(false); clearCache(); setAuthed(false); });
  }, []);
  if (authed === null) return null;
  if (!authed) return <Login onDone={() => setAuthed(true)} />;
  const unit = /^#\/unit\/(\d+)/.exec(hash), settings = hash.startsWith("#/settings");
  const chatOn = hash === "#/chat" || hash.startsWith("#/chat/");
  // Tapping Chat from outside chat reopens the last session; inside chat it keeps the normal link (list).
  const onChatTab = (e: { preventDefault(): void }) => {
    if (chatOn) return;
    e.preventDefault();
    navigate(lastChatHash(localStorage));
  };
  const signOut = async () => { await api("/auth/logout", { method: "POST" }); clearCache(); writeAuthed(false); setAuthed(false); };
  return (
    <div className="app">
      <header className="top">
        <div className="brand"><img className="logo" src="/favicon.svg" alt="" width="26" height="26" />Control Center</div>
        <nav className="tabs"><a href="#/" className={!settings && !chatOn ? "on" : ""}>Dashboard</a><a href="#/chat" onClick={onChatTab} className={chatOn ? "on" : ""}>Chat</a><a href="#/settings" className={settings ? "on" : ""}>Settings</a></nav>
        <div className="spacer" />
      </header>
      <main>{unit ? <UnitDetail id={Number(unit[1])} /> : settings ? <Settings onSignOut={signOut} /> : chatOn ? <Suspense fallback={null}><Chat hash={hash} /></Suspense> : <Dashboard />}</main>
      <nav className="tabbar"><a href="#/" className={!settings && !chatOn ? "on" : ""}>Dashboard</a><a href="#/chat" onClick={onChatTab} className={chatOn ? "on" : ""}>Chat</a><a href="#/settings" className={settings ? "on" : ""}>Settings</a></nav>
    </div>
  );
}
initTheme();
initSwipeBack();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
