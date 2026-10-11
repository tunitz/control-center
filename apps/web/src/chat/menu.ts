import type { ChatModel, Effort } from "./types";
import { effortOptions } from "./slash";

export type EffortItem = { value: Effort; label: string };

const EFFORT_LABEL: Record<Effort, string> = { off: "Off", low: "Low", medium: "Medium", high: "High" };

export function effortLabel(e: Effort): string {
  return EFFORT_LABEL[e];
}

/** Effort menu rows for a model. Empty means the control is hidden. Uses the same rules as the /reasoning command. */
export function effortMenuItems(model: ChatModel | undefined): EffortItem[] {
  return effortOptions(model).map(value => ({ value, label: EFFORT_LABEL[value] }));
}

/**
 * Left edge (px, viewport coordinates) for a popup that opens above a trigger.
 * Aligns with the trigger's left edge, then clamps so the popup stays inside the 16px gutters.
 */
export function menuLeft(triggerLeft: number, _triggerWidth: number, menuWidth: number, viewportWidth: number, gutter = 16): number {
  const max = viewportWidth - gutter - menuWidth;
  return Math.max(gutter, Math.min(triggerLeft, max));
}
