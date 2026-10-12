import type { Approval, ApprovalStatus, ChatMessage, MessageBlock, RunEvent, TokenUsage, ToolRow } from "./types";

export type RunView = { message: ChatMessage; lastId: number; done: boolean };

export function newRunView(base: ChatMessage): RunView {
  return { message: { ...base, text: "", reasoning: null, tools: [], blocks: [], usage: null, status: "running", error: null }, lastId: 0, done: false };
}

const blocksOf = (m: ChatMessage): MessageBlock[] => m.blocks ?? [];

/** Appends text to the trailing text block (or opens a new one), keeping the stream in order. */
function pushText(list: MessageBlock[], text: string): MessageBlock[] {
  const last = list[list.length - 1];
  if (last && last.kind === "text") return [...list.slice(0, -1), { kind: "text", text: last.text + text }];
  return [...list, { kind: "text", text }];
}

/** A tool result answers whichever approval is still pending; a run that ends first leaves it unanswered. */
function resolveApprovals(list: MessageBlock[], to: ApprovalStatus): MessageBlock[] {
  if (!list.some(b => b.kind === "approval" && b.approval.status === "pending")) return list;
  return list.map(b => (b.kind === "approval" && b.approval.status === "pending" ? { ...b, approval: { ...b.approval, status: to } } : b));
}

/** Applies one SSE event. Events at or below lastId are duplicates (replay) and are skipped. */
export function applyEvent(view: RunView, ev: RunEvent): RunView {
  if (ev.id <= view.lastId) return view;
  const v: RunView = { ...view, lastId: ev.id };
  const m = view.message;
  const d = ev.data ?? {};
  const blocks = blocksOf(m);
  switch (ev.type) {
    case "run.started":
      return { ...v, message: { ...m, runId: d.runId ?? m.runId, model: d.model ?? m.model } };
    case "delta": {
      const text = String(d.text ?? "");
      return { ...v, message: { ...m, text: m.text + text, blocks: text ? pushText(blocks, text) : blocks } };
    }
    case "reasoning":
      return { ...v, message: { ...m, reasoning: (m.reasoning ?? "") + String(d.text ?? "") } };
    case "tool.started": {
      const id = String(d.id);
      const row: ToolRow = { id, name: String(d.name ?? "tool"), args: d.args ?? null, preview: d.preview ?? null, status: "running", durationMs: null };
      return { ...v, message: { ...m, tools: [...m.tools, row], blocks: [...blocks, { kind: "tool", id }] } };
    }
    case "tool.completed":
      return {
        ...v,
        message: {
          ...m,
          blocks: resolveApprovals(blocks, d.ok ? "approved" : "denied"),
          tools: m.tools.map(t => (t.id === String(d.id) ? { ...t, status: d.ok ? "ok" : "failed", durationMs: d.durationMs ?? null, preview: d.preview ?? t.preview } : t)),
        },
      };
    case "approval": {
      // Hermes sends a notice only. Pi sends an id, so the card can be answered and later resolved.
      const a: Approval = { command: d.command ?? null, note: String(d.note ?? "needs approval in Hermes") };
      if (typeof d.id === "string") {
        a.id = d.id;
        a.options = Array.isArray(d.options) ? d.options.map(String) : ["approve", "deny"];
        a.status = "pending";
      }
      return { ...v, message: { ...m, blocks: [...blocks, { kind: "approval", approval: a }] } };
    }
    case "approval.answered": {
      const to: ApprovalStatus = d.choice === "approve" ? "approved" : "denied";
      return {
        ...v,
        message: {
          ...m,
          blocks: blocks.map(b => (b.kind === "approval" && b.approval.id === d.id && b.approval.status === "pending" ? { ...b, approval: { ...b.approval, status: to } } : b)),
        },
      };
    }
    case "todo": {
      if (!Array.isArray(d.todos)) return v;
      const todos = d.todos.filter((t: any) => typeof t?.id === "string" && typeof t?.content === "string");
      return { ...v, message: { ...m, todos } };
    }
    case "usage":
      return { ...v, message: { ...m, usage: parseUsage(d) } };
    case "done":
      return {
        ...v,
        done: true,
        message: { ...m, blocks: resolveApprovals(blocks, "ended"), status: d.status ?? "complete", error: d.error ?? null, model: d.model ?? m.model },
      };
    default:
      return v;
  }
}

export function reduceEvents(view: RunView, events: RunEvent[]): RunView {
  return events.reduce(applyEvent, view);
}

/** The reasoning row is shown only when it adds something beyond the final answer. */
export function showReasoning(m: ChatMessage): boolean {
  return !!m.reasoning && m.reasoning.trim() !== "" && m.reasoning.trim() !== m.text.trim();
}

/** Failed and interrupted turns are never presented as normal replies. */
export function isAbnormal(m: ChatMessage): boolean {
  return m.status === "failed" || m.status === "interrupted";
}

/** A `usage` event's payload as a TokenUsage: the two core counters always, the rest only when numeric. */
export function parseUsage(d: Record<string, unknown>): TokenUsage {
  const u: TokenUsage = { input: Number(d.input) || 0, output: Number(d.output) || 0 };
  for (const k of ["cacheRead", "cacheWrite", "context", "calls", "costUsd", "ttftMs", "durationMs"] as const) {
    const n = d[k];
    if (typeof n === "number" && Number.isFinite(n)) u[k] = n;
  }
  return u;
}
