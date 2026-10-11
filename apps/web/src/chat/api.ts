import type { ChatConfig, ChatMessage, ChatModel, ChatSession, Effort, SessionHit } from "./types";

export class ChatError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** Every chat call goes through here. Non-GET requests carry x-cc: 1 (server enforces it). */
export async function chatReq<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["x-cc"] = "1";
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers["content-type"] = "application/json"; payload = JSON.stringify(body); }
  const r = await fetch("/api/chat" + path, { method, credentials: "same-origin", headers, body: payload });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ChatError(r.status, (j as { error?: string }).error ?? r.statusText);
  return j as T;
}

export const chat = {
  models: () => chatReq<ChatModel[]>("GET", "/models"),
  config: () => chatReq<ChatConfig>("GET", "/config"),
  sessions: (q: string, archived: boolean) => {
    const p = new URLSearchParams({ archived: archived ? "1" : "0" });
    if (q.trim()) p.set("q", q.trim());
    return chatReq<(ChatSession | SessionHit)[]>("GET", `/sessions?${p}`);
  },
  createSession: (o: { model?: string; effort?: Effort | null }) => chatReq<ChatSession>("POST", "/sessions", o),
  patchSession: (id: string, patch: Partial<Pick<ChatSession, "title" | "pinned" | "archived" | "model" | "effort">>) =>
    chatReq<ChatSession>("PATCH", `/sessions/${encodeURIComponent(id)}`, patch),
  deleteSession: (id: string) => chatReq<{ ok: true }>("DELETE", `/sessions/${encodeURIComponent(id)}`),
  messages: (id: string, before?: number) => {
    const p = new URLSearchParams({ limit: "40" });
    if (before != null) p.set("before", String(before));
    return chatReq<{ messages: ChatMessage[]; hasMore: boolean }>("GET", `/sessions/${encodeURIComponent(id)}/messages?${p}`);
  },
  send: (id: string, o: { text: string; model?: string; effort?: Effort | null; files: File[] }) => {
    const fd = new FormData();
    fd.append("text", o.text);
    if (o.model) fd.append("model", o.model);
    if (o.effort) fd.append("effort", o.effort);
    for (const f of o.files) fd.append("files", f, f.name);
    return chatReq<{ runId: string; userMessage: ChatMessage; assistantMessage: ChatMessage }>("POST", `/sessions/${encodeURIComponent(id)}/send`, fd);
  },
  stopRun: (runId: string) => chatReq<{ ok: true }>("POST", `/runs/${encodeURIComponent(runId)}/stop`),
  steerRun: (runId: string, message: string) => chatReq<{ ok: true }>("POST", `/runs/${encodeURIComponent(runId)}/steer`, { message }),
  credits: () => chatReq<{ text: string }>("GET", "/credits"),
  exportUrl: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/export`,
};
