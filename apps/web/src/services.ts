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

export const KIND_ORDER: ServiceKind[] = ["systemd", "user", "docker", "lxc"];
export const KIND_LABEL: Record<ServiceKind, string> = { systemd: "systemd", user: "User services", docker: "Docker", lxc: "LXC" };

/** Visible name: the unit part for user items ("user:unit" -> "unit"), the plain name otherwise. */
export function displayName(item: { kind: ServiceKind; name: string }): string {
  if (item.kind !== "user") return item.name;
  const i = item.name.indexOf(":");
  return i >= 0 ? item.name.slice(i + 1) : item.name;
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name);

/**
 * Groups by kind in fixed order (systemd, user, docker, lxc), drops empty groups, sorts names.
 * User services get one group per username (sorted), labelled "User services (<username>)".
 */
export function groupByKind<T extends { kind: ServiceKind; name: string }>(items: T[]): { kind: ServiceKind; label: string; items: T[] }[] {
  return KIND_ORDER.flatMap((kind): { kind: ServiceKind; label: string; items: T[] }[] => {
    const mine = items.filter(i => i.kind === kind).sort(byName);
    if (kind !== "user") return mine.length ? [{ kind, label: KIND_LABEL[kind], items: mine }] : [];
    const users = [...new Set(mine.map(i => i.name.split(":")[0]))].sort((a, b) => a.localeCompare(b));
    return users.map(u => ({ kind, label: `${KIND_LABEL.user} (${u})`, items: mine.filter(i => i.name.split(":")[0] === u) }));
  });
}

/** Case-insensitive substring filter on the display name or the full name. Blank query keeps everything. */
export function filterItems<T extends { kind: ServiceKind; name: string }>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter(i => displayName(i).toLowerCase().includes(q) || i.name.toLowerCase().includes(q)) : items;
}

export { relativeTime } from "./lib/format";

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

