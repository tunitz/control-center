import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Unit } from "./api";

/** Last good response per path. A remounted page paints this instantly instead of
 *  blanking and refetching, which is what made tab/unit navigation flicker. */
const cache = new Map<string, unknown>();
export const cached = <T,>(path: string) => cache.get(path) as T | undefined;
export const remember = (path: string, v: unknown) => { cache.set(path, v); };
export const clearCache = () => cache.clear();

/** One shared EventSource for all live hooks, ref-counted: opened by the first
 *  subscriber, closed when the last one unsubscribes. Each subscriber gets its own "sample" listener. */
let sharedES: EventSource | null = null;
let sharedRefs = 0;
function subscribeSample(onSample: () => void): () => void {
  if (!sharedES) sharedES = new EventSource("/api/events");
  const es = sharedES;
  sharedRefs++;
  const handler = () => onSample();
  es.addEventListener("sample", handler);
  return () => {
    es.removeEventListener("sample", handler);
    if (--sharedRefs === 0) {
      es.close();
      if (sharedES === es) sharedES = null;
    }
  };
}

/** Loads a resource (stale-while-revalidate), refetches on SSE "sample" events (throttled) and on a slow timer as fallback.
 *  State is only replaced when the response content actually changed, so unchanged polls cause no re-render. */
export function useLive<T>(path: string, everyMs = 15000) {
  const init = cache.get(path) as T | undefined;
  const [data, setData] = useState<T | null>(() => init ?? null), [err, setErr] = useState("");
  // JSON of what is currently shown by this instance (not the shared cache, which other instances may have advanced)
  const shown = useRef<string | null>(init === undefined ? null : JSON.stringify(init));
  const last = useRef(0);
  // path changed (e.g. range switch): show that path's cached value, never the previous path's
  const [seen, setSeen] = useState(path);
  if (seen !== path) {
    setSeen(path);
    const c = cache.get(path) as T | undefined;
    shown.current = c === undefined ? null : JSON.stringify(c);
    setData(c ?? null);
  }
  const load = useCallback(() => {
    last.current = Date.now();
    api<T>(path).then(d => {
      cache.set(path, d);
      const s = JSON.stringify(d);
      if (s !== shown.current) { shown.current = s; setData(d); }
      setErr("");
    }).catch(e => setErr(e.message));
  }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, everyMs);
    const off = subscribeSample(() => { if (Date.now() - last.current > 2000) load(); });
    return () => { clearInterval(t); off(); };
  }, [load, everyMs]);
  return { data, err, reload: load };
}
export type { Unit };
