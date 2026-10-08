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

export type StreamState = { text: string; status: "idle" | "streaming" | "done" | "error" | "cancelled"; error: string };
export const initialStream: StreamState = { text: "", status: "idle", error: "" };

export function applyEvent(s: StreamState, e: SseEvent): StreamState {
  switch (e.event) {
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

export type ViewMessage = { role: "user" | "assistant"; content: string };
export function toViewMessages(raw: { role: string; content: string | null }[]): ViewMessage[] {
  return raw.flatMap(m =>
    (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim()
      ? [{ role: m.role as "user" | "assistant", content: m.content }]
      : []);
}

export function sessionLabel(s: { title: string | null; preview: string | null }): string {
  if (s.title && s.title.trim()) return s.title.trim();
  if (s.preview && s.preview.trim()) return s.preview.trim().slice(0, 60);
  return "New chat";
}
