// What the composer's main button says. A message sent while a task runs is not a steer: like Hermes, the server
// interrupts the task and starts the message, or queues it when subagents are running or the chat is compacting.
export type SendMode = {
  label: string;
  title: string;
  placeholder: string;
  /** Line under the composer while a task runs; null when idle. */
  hint: string | null;
};

export function sendMode(busy: boolean, agent: string): SendMode {
  return {
    label: "Send",
    title: busy ? "Send: stops the running task and starts this message" : "Send",
    placeholder: `Message ${agent}…`,
    hint: busy ? "Running. A new message stops the task and replaces it, or waits if subagents are running." : null,
  };
}

/**
 * Where the composer's text goes. A slash command (known or not) is never a prompt: it runs as a command whatever
 * the chat is doing. Everything else is a message; the server decides between interrupt and queue.
 */
export function routeInput(parsed: unknown): "command" | "send" {
  return parsed ? "command" : "send";
}
