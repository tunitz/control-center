import type { ChatModel, Effort } from "./types";

/** Effort is a hint, sent only when the model reports reasoning support. "off" only when the model can disable it. */
export function sendEffort(model: ChatModel | undefined, effort: Effort | null): Effort | null {
  if (!model || !model.reasoning || !effort) return null;
  if (effort === "off" && !model.canDisableReasoning) return null;
  return effort;
}
