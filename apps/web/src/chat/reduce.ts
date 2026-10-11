import type { Approval, ChatMessage, RunEvent, ToolRow } from "./types";

export type RunView = { message: ChatMessage; lastId: number; approvals: Approval[]; done: boolean };

export function newRunView(base: ChatMessage): RunView {
  return { message: { ...base, text: "", reasoning: null, tools: [], usage: null, status: "running", error: null }, lastId: 0, approvals: [], done: false };
}

/** The first tool result after a Pi approval is its answer; a run that ends first leaves it unanswered. */
function resolveApprovals(list: Approval[], to: "approved" | "denied" | "ended"): Approval[] {
  if (!list.some(a => a.status === "pending")) return list;
  return list.map(a => (a.status === "pending" ? { ...a, status: to } : a));
}

/** Applies one SSE event. Events at or below lastId are duplicates (replay) and are skipped. */
export function applyEvent(view: RunView, ev: RunEvent): RunView {
  if (ev.id <= view.lastId) return view;
  const v: RunView = { ...view, lastId: ev.id };
  const m = view.message;
  const d = ev.data ?? {};
  switch (ev.type) {
    case "run.started":
      return { ...v, message: { ...m, runId: d.runId ?? m.runId, model: d.model ?? m.model } };
    case "delta":
      return { ...v, message: { ...m, text: m.text + String(d.text ?? "") } };
    case "reasoning":
      return { ...v, message: { ...m, reasoning: (m.reasoning ?? "") + String(d.text ?? "") } };
    case "tool.started": {
      const row: ToolRow = { id: String(d.id), name: String(d.name ?? "tool"), args: d.args ?? null, preview: d.preview ?? null, status: "running", durationMs: null };
      return { ...v, message: { ...m, tools: [...m.tools, row] } };
    }
    case "tool.completed":
      return {
        ...v,
        approvals: resolveApprovals(view.approvals, d.ok ? "approved" : "denied"),
        message: {
          ...m,
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
      return { ...v, approvals: [...view.approvals, a] };
    }
    case "todo": {
      if (!Array.isArray(d.todos)) return v;
      const todos = d.todos.filter((t: any) => typeof t?.id === "string" && typeof t?.content === "string");
      return { ...v, message: { ...m, todos } };
    }
    case "usage":
      return { ...v, message: { ...m, usage: { input: Number(d.input) || 0, output: Number(d.output) || 0 } } };
    case "done":
      return {
        ...v,
        done: true,
        approvals: resolveApprovals(view.approvals, "ended"),
        message: { ...m, status: d.status ?? "complete", error: d.error ?? null, model: d.model ?? m.model },
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
