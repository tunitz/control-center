import type { ServiceKind, ServiceItem } from "./api";
export type { ServiceItem };

export const AGENT_HINT = "Nothing found. Reinstall the agent on this unit to enable services.";
export const isAgentMissing = (msg: string) => /agent/i.test(msg);

/**
 * Where the agent-reinstall hint is shown, if anywhere. At most one place at a time:
 * while the Manage picker is open the picker owns the hint (empty discover, or an agent error); otherwise the list does.
 */
export function hintFor(o: { listErr: string; pickerOpen: boolean; discoverCount: number; pickerErr: string }): "list" | "picker" | null {
  if (o.pickerOpen) return o.discoverCount === 0 || isAgentMissing(o.pickerErr) ? "picker" : null;
  return isAgentMissing(o.listErr) ? "list" : null;
}

export const KIND_ORDER: ServiceKind[] = ["systemd", "docker", "lxc"];
export const KIND_LABEL: Record<ServiceKind, string> = { systemd: "systemd", docker: "Docker", lxc: "LXC" };

/** Human relative time, e.g. "12s ago", "3m ago". Future timestamps (clock skew) read as "0s ago". */
export function relativeTime(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Dot colour for a unit state: ok = green, bad = red, off = grey. */
export function stateTone(state: string): "ok" | "off" | "bad" {
  const s = state.toLowerCase();
  if (s === "running" || s === "active") return "ok";
  if (s === "failed") return "bad";
  return "off";
}

/** Start is useless only when the service is already up. */
export const canStart = (state: string) => stateTone(state) !== "ok";
/** Stop is useless only when the service is already down (stopped, inactive, exited). */
export const canStop = (state: string) => stateTone(state) === "ok" || stateTone(state) === "bad";

/** Groups by kind in fixed order (systemd, docker, lxc), drops empty kinds, sorts names. */
export function groupByKind<T extends { kind: ServiceKind; name: string }>(items: T[]): { kind: ServiceKind; items: T[] }[] {
  return KIND_ORDER.map(kind => ({
    kind,
    items: items.filter(i => i.kind === kind).sort((a, b) => a.name.localeCompare(b.name)),
  })).filter(g => g.items.length > 0);
}

/** Case-insensitive substring filter on the name. Blank query keeps everything. */
export function filterItems<T extends { name: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter(i => i.name.toLowerCase().includes(q)) : items;
}
