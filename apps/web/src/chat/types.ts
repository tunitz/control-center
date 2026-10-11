// Mirrors docs/chat-contract.md. Change only via the contract owner.
export type Effort = "off" | "low" | "medium" | "high";
export type Backend = "hermes" | "pi";
export type ChatModel = { id: string; provider: string; label: string; reasoning: boolean; canDisableReasoning: boolean; vision: boolean; local: boolean; online: boolean; backend?: Backend };
export type ChatSession = {
  id: string; title: string; titleAuto: boolean; model: string; provider: string; effort: Effort | null;
  pinned: boolean; archived: boolean; createdAt: number; updatedAt: number;
  runState: "idle" | "running" | "needs_approval"; runId: string | null; unread: boolean; preview: string; awaiting: number;
  backend?: Backend; cwd: string | null; yolo: boolean;
};
export type SessionHit = ChatSession & { snippet: string };
export type Attachment = { id: string; kind: "image" | "file"; name: string; mime: string; size: number; w: number | null; h: number | null; url: string };
export type TodoItem = { id: string; content: string; status: "pending" | "in_progress" | "completed" };
export type ToolRow = { id: string; name: string; args: Record<string, unknown> | null; preview: string | null; status: "running" | "ok" | "failed"; durationMs: number | null };
export type MessageStatus = "complete" | "failed" | "interrupted" | "running";
export type ApprovalStatus = "pending" | "approved" | "denied" | "ended";
/** A Hermes approval is a read-only notice (no id). A Pi approval has an id and can be answered. */
export type Approval = { command: string | null; note: string; id?: string; options?: string[]; status?: ApprovalStatus };
/** Ordered parts of an assistant turn, so text, tools and approvals stay in the order they happened. */
export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string }
  | { kind: "approval"; approval: Approval };
export type ChatMessage = {
  id: string; seq: number; role: "user" | "assistant"; text: string; reasoning: string | null;
  tools: ToolRow[]; blocks?: MessageBlock[] | null; usage: { input: number; output: number } | null;
  todos?: TodoItem[] | null; status: MessageStatus;
  runId: string | null; model: string | null; attachments: Attachment[]; createdAt: number; error: string | null;
};
/** A persistent local slash-command row. `afterSeq` anchors it after that message seq. */
export type CommandNote = { id: number; name: string; body: string; afterSeq: number; createdAt: number };
export type ChatConfig = { defaultModel: string; newChatModel?: string | null; defaultEffort: Effort | null; maxUploadMb: number; contextWindow: Record<string, number> };
export type RunEvent = { id: number; type: string; data: any };
export type PiSettings = { tools: string[] | null; steeringMode: "all" | "one-at-a-time"; followUpMode: "all" | "one-at-a-time"; autoCompaction: boolean; autoRetry: boolean };
export type PiConfig = { appendSystemPrompt: string; agentsMd: string; defaultTools: string[] | null; gate: { extraProtectedPaths: string[]; extraRisky: string[] }; knownTools: string[]; claudeBridge: boolean; claudeCode: { found: boolean; path: string | null; extension: boolean }; browser: boolean; browserStatus: { extension: boolean; agent: boolean; chromium: boolean } };
/** A Pi skill (global or project) with its enable/disable state. Mirrors the server's PiSkill. */
export type PiSkill = { name: string; description: string; scope: "global" | "project"; path: string; dir: string; cwd: string | null; enabled: boolean };
export type PiAuthType = "oauth" | "api_key";
/** A provider the chat's `/login` can sign in to (GET /pi/auth/providers). */
export type PiAuthProvider = { id: string; name: string; authTypes: PiAuthType[]; oauthLabel?: string; subscription: boolean; configured: boolean; source?: string };
export type PiAuthPrompt = { id: string; type: "text" | "secret" | "select" | "manual_code"; message: string; placeholder?: string; options?: { id: string; label: string; description?: string }[] };
/** A sign-in's notice, as streamed by the bridge (event "auth"). */
export type PiAuthEvent =
  | { type: "info"; message: string; links?: { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
