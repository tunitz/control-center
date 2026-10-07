import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Unit } from "./api";

/** Loads a resource, refetches on SSE "sample" events (throttled) and on a slow timer as fallback. */
export function useLive<T>(path: string, everyMs = 15000) {
  const [data, setData] = useState<T | null>(null), [err, setErr] = useState("");
  const last = useRef(0);
  const load = useCallback(() => { last.current = Date.now(); api<T>(path).then(d => { setData(d); setErr(""); }).catch(e => setErr(e.message)); }, [path]);
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
