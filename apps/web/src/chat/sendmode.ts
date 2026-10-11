// What the composer's main button does right now. While a task runs, typing steers it instead of starting a
// message, so the button, placeholder and hint all have to say so: a bare arrow looks the same either way.
export type SendMode = {
  kind: "send" | "steer";
  /** Button label (visually hidden on phones, where the icon is alone). */
  label: string;
  /** Tooltip and accessible description of the button. */
  title: string;
  placeholder: string;
  /** Line under the composer while steering; null when sending. */
  hint: string | null;
};

export function sendMode(busy: boolean, agent: string): SendMode {
  if (!busy) return { kind: "send", label: "Send", title: "Send", placeholder: `Message ${agent}…`, hint: null };
  return {
    kind: "steer",
    label: "Steer",
    title: "Steer: send this into the running task",
    placeholder: "Steer the running task…",
    hint: "Running. What you send steers the task.",
  };
}

/**
 * Where the composer's text goes. A slash command (known or not) is never a prompt and never a steer: it runs
 * as a command whatever the button says. Only plain text steers a running task or starts a message.
 */
export function routeInput(busy: boolean, parsed: unknown): "command" | "steer" | "send" {
  if (parsed) return "command";
  return busy ? "steer" : "send";
}
