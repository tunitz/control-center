// Mirrors docs/chat-contract.md. Change only via the contract owner.
export type Effort = "off" | "low" | "medium" | "high";
export type ChatModel = { id: string; provider: string; label: string; reasoning: boolean; canDisableReasoning: boolean; vision: boolean; local: boolean; online: boolean };
export type ChatSession = {
  id: string; title: string; titleAuto: boolean; model: string; provider: string; effort: Effort | null;
  pinned: boolean; archived: boolean; createdAt: number; updatedAt: number;
  runState: "idle" | "running" | "needs_approval"; runId: string | null; unread: boolean; preview: string;
};
export type SessionHit = ChatSession & { snippet: string };
export type Attachment = { id: string; kind: "image" | "file"; name: string; mime: string; size: number; w: number | null; h: number | null; url: string };
export type ToolRow = { id: string; name: string; args: Record<string, unknown> | null; preview: string | null; status: "running" | "ok" | "failed"; durationMs: number | null };
export type MessageStatus = "complete" | "failed" | "interrupted" | "running";
export type ChatMessage = {
  id: string; seq: number; role: "user" | "assistant"; text: string; reasoning: string | null;
  tools: ToolRow[]; usage: { input: number; output: number } | null; status: MessageStatus;
  runId: string | null; model: string | null; attachments: Attachment[]; createdAt: number; error: string | null;
};
export type ChatConfig = { defaultModel: string; defaultEffort: Effort | null; maxUploadMb: number; contextWindow: Record<string, number> };
export type RunEvent = { id: number; type: string; data: any };
export type Approval = { command: string | null; note: string };
