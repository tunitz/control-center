// Pure helpers for Pi chats in the web UI (docs/pi-plan.md T7). No React here so they are unit-testable.
import { effortOptions } from "./slash";
import type { Backend, ChatModel, Effort, TodoItem } from "./types";

/**
 * Model ids from the two backends can be equal, so the UI keys Pi models as "pi:<id>".
 * Hermes ids are unchanged, which keeps every stored Hermes session id and test valid.
 */
export const keyOf = (backend: Backend | undefined, id: string): string => (backend === "pi" ? `pi:${id}` : id);
export const splitKey = (key: string): { backend: Backend; id: string } =>
  key.startsWith("pi:") ? { backend: "pi", id: key.slice(3) } : { backend: "hermes", id: key };
export const backendOfKey = (key: string): Backend => splitKey(key).backend;

/** The model list as the pickers see it: Pi ids rewritten to keys. */
export function viewModels(models: ChatModel[]): ChatModel[] {
  return models.map(m => (m.backend === "pi" ? { ...m, id: keyOf("pi", m.id) } : m));
}

/** A chat keeps the backend it was created with; with no chat yet, every model is usable. */
export function modelUsable(m: ChatModel, chatBackend: Backend | null): boolean {
  if (chatBackend === null) return true;
  return (m.backend ?? "hermes") === chatBackend;
}

const ALL_EFFORTS: readonly Effort[] = ["off", "low", "medium", "high"];

/**
 * Thinking levels to offer. Hermes: the model's own rules. Pi: those, narrowed to the levels Pi
 * reports for the current model. Pi's "minimal" and "max" have no match in the four-step control.
 * A control with a single choice is pointless, so it is hidden.
 */
export function effortChoices(model: ChatModel | undefined, piLevels: string[] | null): Effort[] {
  const base = effortOptions(model);
  if (model?.backend !== "pi" || !piLevels || piLevels.length === 0) return base;
  const narrowed = ALL_EFFORTS.filter(e => base.includes(e) && piLevels.includes(e));
  return narrowed.length > 1 ? narrowed : [];
}

/** "1 of 3 done", or "All 3 done" once every item is complete. Null when there is no list. */
export function todoSummary(todos: TodoItem[] | null | undefined): { label: string; done: boolean } | null {
  if (!todos || todos.length === 0) return null;
  const done = todos.filter(t => t.status === "completed").length;
  return done === todos.length ? { label: `All ${done} done`, done: true } : { label: `${done} of ${todos.length} done`, done: false };
}

const short = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
export const tokenNote = (r: { tokensBefore: number; tokensAfter: number }): string =>
  `Compacted: about ${short(r.tokensBefore)} tokens down to ${short(r.tokensAfter)}`;

export function sheetErrorText(e: unknown): string {
  const err = e as { status?: number; message?: string };
  if (err.status === 409) return "Wait for the run to finish, then try again.";
  const text = (err.message ?? "").replace(/^pi bridge [a-z_ ]+ failed \(\d+\):\s*/i, "");
  if (/nothing to compact/i.test(text)) return "Nothing to compact yet. This chat is still short.";
  return text || "Something went wrong.";
}
