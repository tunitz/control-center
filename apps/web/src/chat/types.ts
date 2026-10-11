// Mirrors docs/chat-contract.md. Change only via the contract owner.
export type Effort = "off" | "low" | "medium" | "high";
export type Backend = "hermes" | "pi";
export type ChatModel = { id: string; provider: string; label: string; reasoning: boolean; canDisableReasoning: boolean; vision: boolean; local: boolean; online: boolean; backend?: Backend };
export type ChatSession = {
  id: string; title: string; titleAuto: boolean; model: string; provider: string; effort: Effort | null;
  pinned: boolean; archived: boolean; createdAt: number; updatedAt: number;
  runState: "idle" | "running" | "needs_approval"; runId: string | null; unread: boolean; preview: string; awaiting: number;
  backend?: Backend;
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
export type ChatConfig = { defaultModel: string; defaultEffort: Effort | null; maxUploadMb: number; contextWindow: Record<string, number> };
export type RunEvent = { id: number; type: string; data: any };
export type PiSettings = { tools: string[] | null; steeringMode: "all" | "one-at-a-time"; followUpMode: "all" | "one-at-a-time"; autoCompaction: boolean; autoRetry: boolean };
export type PiConfig = { appendSystemPrompt: string; agentsMd: string; defaultTools: string[] | null; gate: { extraProtectedPaths: string[]; extraRisky: string[] }; knownTools: string[] };
