import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Unit } from "./api";

/** Last good response per path. A remounted page paints this instantly instead of
 *  blanking and refetching, which is what made tab/unit navigation flicker.
 *  Persisted to localStorage so a cold load (iOS standalone has no bfcache) also paints last-known data. */
const STORE_KEY = "cc:cache:v1";
const hasLS = () => typeof localStorage !== "undefined";
function hydrate(): Map<string, unknown> {
  try {
    if (!hasLS()) return new Map();
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? new Map(JSON.parse(raw)) : new Map();
  } catch { return new Map(); }
}
const cache = hydrate();
let persistTimer: ReturnType<typeof setTimeout> | null = null;
/** Single debounced writer: one pending timer, writes whatever the cache holds when it fires. */
function schedulePersist() {
  if (!hasLS() || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    try { localStorage.setItem(STORE_KEY, JSON.stringify([...cache])); } catch { /* quota: ignore */ }
  }, 500);
}
export const cached = <T,>(path: string) => cache.get(path) as T | undefined;
export const remember = (path: string, v: unknown) => { cache.set(path, v); schedulePersist(); };
export const clearCache = () => {
  cache.clear();
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  if (hasLS()) { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } }
};

/** One shared EventSource for all live hooks, ref-counted: opened by the first
 *  subscriber, closed when the last one unsubscribes. Each subscriber gets its own "sample" listener. */
let sharedES: EventSource | null = null;
let sharedRefs = 0;
/** Every live "sample" handler, so a re-opened EventSource can re-attach them. */
const sampleHandlers = new Set<() => void>();

function openShared(): EventSource {
  const es = new EventSource("/api/events");
  for (const h of sampleHandlers) es.addEventListener("sample", h);
  sharedES = es;
  return es;
}

function subscribeSample(onSample: () => void): () => void {
  const handler = () => onSample();
  sampleHandlers.add(handler);
  sharedRefs++;
  if (sharedES) sharedES.addEventListener("sample", handler);
  else openShared();
  return () => {
    sampleHandlers.delete(handler);
    sharedES?.removeEventListener("sample", handler);
    if (--sharedRefs === 0) {
      sharedES?.close();
      sharedES = null;
    }
  };
}

// bfcache: close the stream on pagehide so the page is eligible for back/forward cache,
// re-open it on pageshow, and refresh subscribers after a bfcache restore.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (sharedES) { sharedES.close(); sharedES = null; }
  });
  window.addEventListener("pageshow", (e: PageTransitionEvent) => {
    if (sharedRefs > 0 && !sharedES) openShared();
    if (e.persisted) for (const h of [...sampleHandlers]) h();
  });
}

/** Loads a resource (stale-while-revalidate), refetches on SSE "sample" events (throttled) and on a slow timer as fallback.
 *  State is only replaced when the response content actually changed, so unchanged polls cause no re-render. */
export function useLive<T>(path: string, everyMs = 15000) {
  const init = cache.get(path) as T | undefined;
  const [data, setData] = useState<T | null>(() => init ?? null), [err, setErr] = useState("");
  // JSON of what is currently shown by this instance (not the shared cache, which other instances may have advanced)
  const shown = useRef<string | null>(init === undefined ? null : JSON.stringify(init));
  const last = useRef(0);
  const loadGeneration = useRef(0);
  // path changed (e.g. range switch): show that path's cached value, never the previous path's
  const [seen, setSeen] = useState(path);
  if (seen !== path) {
    loadGeneration.current++;
    setSeen(path);
    const c = cache.get(path) as T | undefined;
    shown.current = c === undefined ? null : JSON.stringify(c);
    setData(c ?? null);
  }
  const load = useCallback(() => {
    last.current = Date.now();
    const generation = ++loadGeneration.current;
    api<T>(path).then(d => {
      if (generation !== loadGeneration.current) return; // stale path/view response
      cache.set(path, d);
      schedulePersist();
      const s = JSON.stringify(d);
      if (s !== shown.current) { shown.current = s; setData(d); }
      setErr("");
    }).catch(e => { if (generation === loadGeneration.current) setErr(e.message); });
  }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, everyMs);
    const off = subscribeSample(() => {
      const since = Date.now() - last.current;
      if (since < Math.max(2000, everyMs / 2)) return;
      if (document.visibilityState !== "visible") return;
      load();
    });
    return () => { clearInterval(t); off(); };
  }, [load, everyMs]);
  return { data, err, reload: load };
}
export type { Unit };
