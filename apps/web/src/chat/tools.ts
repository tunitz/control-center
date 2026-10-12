// Pure helpers for the Pi tool checkboxes (Settings and the per-chat sheet). No React here, so they unit-test.
import type { PiTool } from "./types";

export type ToolRow = { name: string; description: string; checked: boolean; missing: boolean };

/**
 * One checkbox row per tool the bridge offers, in bridge order. A selected name that the bridge no
 * longer offers still gets a row (marked missing) so the person can untick it.
 */
export function toolRows(offered: PiTool[], selected: string[] | null): ToolRow[] {
  const sel = new Set(selected ?? []);
  const rows: ToolRow[] = offered.map((t) => ({ name: t.name, description: t.description, checked: sel.has(t.name), missing: false }));
  const known = new Set(offered.map((t) => t.name));
  for (const name of selected ?? []) {
    if (!known.has(name)) {
      rows.push({ name, description: "No longer offered by Pi.", checked: true, missing: true });
      known.add(name);
    }
  }
  return rows;
}

/**
 * Ticks or unticks one tool, keeping the bridge's order. Never empties the selection (a run needs one tool).
 * `current` is the effective selection; the result is the new selection.
 */
export function toggleTool(offered: PiTool[], current: string[], name: string): string[] {
  const next = current.includes(name) ? current.filter((x) => x !== name) : [...current, name];
  if (next.length === 0) return current;
  const order = [...offered.map((t) => t.name), ...current.filter((x) => !offered.some((t) => t.name === x))];
  return order.filter((x) => next.includes(x));
}
