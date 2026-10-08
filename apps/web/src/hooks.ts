import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Unit } from "./api";

/** Last good response per path. A remounted page paints this instantly instead of
 *  blanking and refetching, which is what made tab/unit navigation flicker. */
const cache = new Map<string, unknown>();
export const cached = <T,>(path: string) => cache.get(path) as T | undefined;
export const remember = (path: string, v: unknown) => { cache.set(path, v); };
export const clearCache = () => cache.clear();

/** Loads a resource (stale-while-revalidate), refetches on SSE "sample" events (throttled) and on a slow timer as fallback. */
export function useLive<T>(path: string, everyMs = 15000) {
  const [data, setData] = useState<T | null>(() => (cache.get(path) as T | undefined) ?? null), [err, setErr] = useState("");
  const last = useRef(0);
  // path changed (e.g. range switch): show that path's cached value, never the previous path's
  const [seen, setSeen] = useState(path);
  if (seen !== path) { setSeen(path); setData((cache.get(path) as T | undefined) ?? null); }
  const load = useCallback(() => { last.current = Date.now(); api<T>(path).then(d => { cache.set(path, d); setData(d); setErr(""); }).catch(e => setErr(e.message)); }, [path]);
  useEffect(() => {
    load();
    const t = setInterval(load, everyMs);
    const es = new EventSource("/api/events");
    es.addEventListener("sample", () => { if (Date.now() - last.current > 2000) load(); });
    return () => { clearInterval(t); es.close(); };
  }, [load, everyMs]);
  return { data, err, reload: load };
}
export type { Unit };
