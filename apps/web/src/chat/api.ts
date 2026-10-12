import type { Backend, ChatConfig, ChatMessage, ChatModel, ChatSession, CommandNote, Effort, PiAuthProvider, PiAuthType, PiConfig, PiSettings, PiSkill, SessionHit, UsageReport } from "./types";

/** GET /api/chat/pi/dirs: subfolders of `path` (root is the home folder, parent null there). */
export type PiDirList = { path: string; parent: string | null; entries: { name: string; path: string }[] };

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

/** A started turn, or `queued` when the chat was busy with subagents or a compaction and the message waits its turn. */
export type SendResult = { runId: string; userMessage: ChatMessage; assistantMessage: ChatMessage; queued?: undefined } | { queued: true; position: number };

export const chat = {
  models: () => chatReq<ChatModel[]>("GET", "/models"),
  config: () => chatReq<ChatConfig>("GET", "/config"),
  sessions: (q: string, archived: boolean) => {
    const p = new URLSearchParams({ archived: archived ? "1" : "0" });
    if (q.trim()) p.set("q", q.trim());
    return chatReq<(ChatSession | SessionHit)[]>("GET", `/sessions?${p}`);
  },
  createSession: (o: { model?: string; effort?: Effort | null; backend?: Backend; cwd?: string }) => chatReq<ChatSession>("POST", "/sessions", o),
  piDirs: (path?: string) => chatReq<PiDirList>("GET", `/pi/dirs${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  piMkdir: (parent: string, name: string) => chatReq<{ path: string; name: string }>("POST", "/pi/dirs", { parent, name }),
  patchSession: (id: string, patch: Partial<Pick<ChatSession, "title" | "pinned" | "archived" | "model" | "effort" | "yolo">>) =>
    chatReq<ChatSession>("PATCH", `/sessions/${encodeURIComponent(id)}`, patch),
  deleteSession: (id: string) => chatReq<{ ok: true }>("DELETE", `/sessions/${encodeURIComponent(id)}`),
  messages: (id: string, before?: number) => {
    const p = new URLSearchParams({ limit: "40" });
    if (before != null) p.set("before", String(before));
    return chatReq<{ messages: ChatMessage[]; hasMore: boolean; commands: CommandNote[] }>("GET", `/sessions/${encodeURIComponent(id)}/messages?${p}`);
  },
  /** Records a local command row so it survives a reload. Returns the stored row. */
  addCommand: (id: string, name: string, body: string, block: number | null = null) =>
    chatReq<CommandNote>("POST", `/sessions/${encodeURIComponent(id)}/commands`, { name, body, block }),
  deleteMessage: (id: string, messageId: string) =>
    chatReq<{ ok: true }>("DELETE", `/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}`),
  /** Drops the message and everything after it, then runs it again. Returns the new turn. */
  retryMessage: (id: string, messageId: string) =>
    chatReq<{ runId: string; userMessage: ChatMessage; assistantMessage: ChatMessage }>(
      "POST", `/sessions/${encodeURIComponent(id)}/messages/${encodeURIComponent(messageId)}/retry`, {}),
  send: (id: string, o: { text: string; model?: string; effort?: Effort | null; files: File[] }) => {
    const fd = new FormData();
    fd.append("text", o.text);
    if (o.model) fd.append("model", o.model);
    if (o.effort) fd.append("effort", o.effort);
    for (const f of o.files) fd.append("files", f, f.name);
    return chatReq<SendResult>("POST", `/sessions/${encodeURIComponent(id)}/send`, fd);
  },
  stopRun: (runId: string) => chatReq<{ ok: true }>("POST", `/runs/${encodeURIComponent(runId)}/stop`),
  steerRun: (runId: string, message: string) => chatReq<{ ok: true }>("POST", `/runs/${encodeURIComponent(runId)}/steer`, { message }),
  approve: (runId: string, id: string, choice: "approve" | "deny") =>
    chatReq<{ ok: true }>("POST", `/runs/${encodeURIComponent(runId)}/approval`, { id, choice }),
  piSettings: (sid: string) => chatReq<{ settings: PiSettings; thinkingLevels: string[] }>("GET", `/sessions/${encodeURIComponent(sid)}/pi-settings`),
  patchPiSettings: (sid: string, patch: Partial<PiSettings>) =>
    chatReq<{ settings: PiSettings }>("PATCH", `/sessions/${encodeURIComponent(sid)}/pi-settings`, patch),
  piCompact: (sid: string, instructions?: string) =>
    chatReq<{ tokensBefore: number; tokensAfter: number }>("POST", `/sessions/${encodeURIComponent(sid)}/pi-compact`, instructions ? { instructions } : {}),
  piConfig: () => chatReq<PiConfig>("GET", "/pi-config"),
  putPiConfig: (patch: Partial<Omit<PiConfig, "knownTools">>) => chatReq<PiConfig>("PUT", "/pi-config", patch),
  piSkills: () => chatReq<{ skills: PiSkill[] }>("GET", "/pi/skills"),
  putPiSkills: (disabled: string[]) => chatReq<{ skills: PiSkill[] }>("PUT", "/pi/skills", { disabled }),
  piAuthProviders: () => chatReq<{ providers: PiAuthProvider[] }>("GET", "/pi/auth/providers"),
  piAuthStart: (provider: string, authType: PiAuthType) =>
    chatReq<{ id: string; provider: string; providerName: string; authType: PiAuthType }>("POST", "/pi/auth/login", { provider, authType }),
  piAuthRespond: (id: string, value: string, promptId?: string) =>
    chatReq<{ ok: true }>("POST", `/pi/auth/login/${encodeURIComponent(id)}/respond`, promptId ? { value, promptId } : { value }),
  piAuthCancel: (id: string) => chatReq<{ ok: true }>("POST", `/pi/auth/login/${encodeURIComponent(id)}/cancel`, {}),
  piAuthEventsUrl: (id: string, after = 0) => `/api/chat/pi/auth/login/${encodeURIComponent(id)}/events?after=${after}`,
  sessionUsage: (id: string) => chatReq<UsageReport>("GET", `/sessions/${encodeURIComponent(id)}/usage`),
  credits: () => chatReq<{ text: string }>("GET", "/credits"),
  exportUrl: (id: string) => `/api/chat/sessions/${encodeURIComponent(id)}/export`,
};
