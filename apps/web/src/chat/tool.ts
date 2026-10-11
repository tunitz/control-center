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

/** Every argument in full for the expanded tool row. Nothing is cut: the data is already in the stream, no model tokens. */
export function toolDetail(args: Record<string, unknown> | null): string {
  if (!args) return "";
  const out: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out.push(v.includes("\n") || v.length > 60 ? `${k}:\n${v}` : `${k}: ${v}`);
    else if (typeof v === "number" || typeof v === "boolean") out.push(`${k}: ${v}`);
    else out.push(`${k}:\n${JSON.stringify(v, null, 2)}`);
  }
  return out.join("\n\n");
}
