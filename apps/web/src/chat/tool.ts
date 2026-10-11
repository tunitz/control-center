import type { ToolRow } from "./types";

const MAX = 80;
const cut = (s: string) => (s.length > MAX ? s.slice(0, MAX - 1) + "…" : s);

function part(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** One-line summary of a tool call's arguments. Objects are never stringified with String(). */
export function toolTarget(args: Record<string, unknown> | null): string {
  if (!args) return "";
  const tasks = args.tasks;
  if (Array.isArray(tasks) && tasks.length > 0) {
    const first = tasks[0] as Record<string, unknown> | string | null;
    const goal = typeof first === "string" ? first : part((first as Record<string, unknown> | null)?.goal);
    return cut(tasks.length > 1 ? `${goal} +${tasks.length - 1} more` : goal);
  }
  return cut(Object.values(args).map(part).filter(Boolean).join(" "));
}

/** delegate_task returns as soon as the subagent is dispatched, so a finished row is not a result. */
export function toolStatus(t: ToolRow): { cls: string; label: string } {
  if (t.status === "running") return { cls: "stat-run", label: "running" };
  if (t.status === "failed") return { cls: "stat-err", label: "failed" };
  if (t.name === "delegate_task") return { cls: "stat-run", label: "background" };
  return { cls: "stat-ok", label: "ok" };
}
