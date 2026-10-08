// Pure helpers for the Chat page: SSE parsing, stream reducer, and session labels.
// No DOM or React here, so they are unit-tested with bun test.

export type SseEvent = { event: string; data: any };

export function parseSse(prev: string, chunk: string): { events: SseEvent[]; rest: string } {
  const parts = (prev + chunk).split("\n\n");
  const rest = parts.pop() ?? "";
  const events: SseEvent[] = [];
  for (const block of parts) {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) continue;
    const raw = data.join("\n");
    let parsed: any = raw;
    try { parsed = JSON.parse(raw); } catch { /* keep raw */ }
    events.push({ event, data: parsed });
  }
  return { events, rest };
}

export type StreamState = { text: string; thinking: string; status: "idle" | "streaming" | "done" | "error" | "cancelled"; error: string };
export const initialStream: StreamState = { text: "", thinking: "", status: "idle", error: "" };

export function applyEvent(s: StreamState, e: SseEvent): StreamState {
  switch (e.event) {
    case "tool.progress":
      // Hermes sends the model's reasoning as tool.progress with tool_name "_thinking".
      if (e.data?.tool_name === "_thinking") return { ...s, thinking: s.thinking + String(e.data?.delta ?? "") };
      return s;
    case "assistant.delta":
      return { ...s, status: "streaming", text: s.text + String(e.data?.delta ?? "") };
    case "assistant.completed":
      return s.status === "streaming" ? s : { ...s, status: "streaming", text: String(e.data?.content ?? s.text) };
    case "run.completed": {
      const last = [...(e.data?.messages ?? [])].reverse().find((m: any) => m.role === "assistant" && typeof m.content === "string");
      return { ...s, status: "done", text: last ? last.content : s.text };
    }
    case "run.failed":
      return { ...s, status: "error", error: String(e.data?.error ?? "The run failed") };
    case "run.cancelled":
      return { ...s, status: "cancelled" };
    default:
      return s;
  }
}

export type ViewMessage = { role: "user" | "assistant"; content: string; thinking?: string };

// Gateway-generated notices (background process, internal) are not chat messages.
const GATEWAY_NOTICE = /^\[(IMPORTANT: Background process|INTERNAL NOTIFICATION)/;
/** Strips the sender prefix and the triggering-id line that Discord messages carry. */
export function cleanUserText(text: string): string {
  return text
    .replace(/^\s*\[Triggering message id:[^\]\n]*(\]|…|\n|$)\s*/, "")
    .replace(/^\s*\[tun\]\s*/, "")
    .trim();
}

export function toViewMessages(raw: { role: string; content: string | null }[]): ViewMessage[] {
  return raw.flatMap((m): ViewMessage[] => {
    if (!(m.role === "user" || m.role === "assistant") || typeof m.content !== "string" || !m.content.trim()) return [];
    if (m.role === "user") {
      if (GATEWAY_NOTICE.test(m.content.trim())) return [];
      const text = cleanUserText(m.content);
      return text ? [{ role: "user" as const, content: text }] : [];
    }
    return [{ role: "assistant" as const, content: m.content }];
  });
}

export function sessionLabel(s: { title: string | null; preview: string | null }): string {
  const title = s.title ? cleanUserText(s.title) : "";
  if (title) return title;
  const preview = s.preview ? cleanUserText(s.preview) : "";
  if (preview) return preview.slice(0, 60);
  return "New chat";
}


export type ModelChoice = { value: string; label: string; provider: string; model: string };

/** Flattens Hermes' /api/model/options providers into one picker list; value = "provider|model". */
export function modelChoices(payload: { providers?: { slug: string; name: string; models?: string[] }[] }): ModelChoice[] {
  return (payload.providers ?? []).flatMap(p =>
    (p.models ?? []).map(model => ({
      value: `${p.slug}|${model}`,
      label: `${p.name} · ${model}`,
      provider: p.slug,
      model,
    })));
}

/** Reasoning levels offered in the chat picker; "none" turns reasoning off. */
export const REASONING_CHOICES: { value: string; label: string }[] = [
  { value: "none", label: "Off" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

/** Hermes model_options for a reasoning choice; "" means leave the session default. */
export function reasoningOptions(effort: string): { reasoning: { enabled?: boolean; effort?: string } } | undefined {
  if (!effort) return undefined;
  if (effort === "none") return { reasoning: { enabled: false } };
  return { reasoning: { enabled: true, effort } };
}
