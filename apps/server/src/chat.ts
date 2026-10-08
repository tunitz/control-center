// Proxy from the Control Center to Hermes' Sessions API (API_SERVER_KEY stays server-side).
// Routes are mounted under /api/chat/* by index.ts; this module is pure so it can be tested
// with a fake fetch.

export const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_INPUT = 20000;
const PREFIX = "/api/chat/sessions";

export type SseEvent = { event: string; data: unknown };

/** Parses complete SSE events out of `prev + chunk`; returns the unfinished tail as `rest`. */
export function parseSse(prev: string, chunk: string): { events: SseEvent[]; rest: string } {
  const buf = prev + chunk;
  const parts = buf.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];
  for (const block of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const raw = data.join("\n");
    let parsed: unknown = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep raw text */ }
    events.push({ event, data: parsed });
  }
  return { events, rest };
}

export function createChat(opts: { baseUrl: string; key: string; fetch?: typeof fetch }) {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

  async function up(path: string, init: { method?: string; body?: string; accept?: string } = {}) {
    return f(base + path, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${opts.key}`,
        ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
        ...(init.accept ? { accept: init.accept } : {}),
      },
      body: init.body,
    });
  }

  /** Forwards one JSON call; upstream failures become 502 with the reason. */
  async function forward(path: string, init: Parameters<typeof up>[1]) {
    try {
      const r = await up(path, init);
      const text = await r.text();
      return new Response(text, { status: r.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    } catch (e: any) {
      return json({ error: `Hermes unreachable: ${e?.message ?? e}` }, 502);
    }
  }

  async function handle(req: Request, path: string): Promise<Response> {
    if (!opts.key) return json({ error: "HERMES_API_KEY is not set on the Control Center" }, 503);
    if (path === PREFIX) {
      if (req.method === "GET") return forward("/api/sessions?limit=100&include_children=false", {});
      if (req.method === "POST") {
        try {
          const r = await up("/api/sessions", { method: "POST", body: (await req.text()) || "{}" });
          const j: any = await r.json().catch(() => ({}));
          if (!r.ok) return json({ error: j?.error?.message ?? j?.error ?? `Hermes returned ${r.status}` }, r.status >= 500 ? 502 : r.status);
          return json({ ...(j.session ?? j), id: j.session?.id ?? j.id }, r.status);
        } catch (e: any) {
          return json({ error: `Hermes unreachable: ${e?.message ?? e}` }, 502);
        }
      }
      return json({ error: "method not allowed" }, 405);
    }
    if (!path.startsWith(PREFIX + "/")) return json({ error: "not found" }, 404);
    const [id, sub] = path.slice(PREFIX.length + 1).split("/");
    if (!SESSION_ID.test(id)) return json({ error: "bad session id" }, 400);
    if (!sub) {
      if (req.method === "PATCH") return forward(`/api/sessions/${id}`, { method: "PATCH", body: await req.text() });
      if (req.method === "DELETE") return forward(`/api/sessions/${id}`, { method: "DELETE" });
      return json({ error: "method not allowed" }, 405);
    }
    if (sub === "messages" && req.method === "GET") return forward(`/api/sessions/${id}/messages?inline_images=false`, {});
    if (sub === "stream" && req.method === "POST") {
      const body = await req.json().catch(() => null) as { input?: unknown } | null;
      const input = typeof body?.input === "string" ? body.input.trim() : "";
      if (!input) return json({ error: "message is empty" }, 400);
      if (input.length > MAX_INPUT) return json({ error: `message is over ${MAX_INPUT} characters` }, 400);
      try {
        const r = await up(`/api/sessions/${id}/chat/stream`, { method: "POST", body: JSON.stringify({ input }), accept: "text/event-stream" });
        if (!r.ok || !r.body) return json({ error: `Hermes returned ${r.status}`, detail: await r.text() }, 502);
        return new Response(r.body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      } catch (e: any) {
        return json({ error: `Hermes unreachable: ${e?.message ?? e}` }, 502);
      }
    }
    return json({ error: "not found" }, 404);
  }

  return { handle };
}
