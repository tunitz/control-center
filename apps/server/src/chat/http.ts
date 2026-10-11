/** Shared HTTP helpers for the chat routes. */

export class ChatError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ChatError";
    this.status = status;
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

/** Parses a JSON object body. Empty body -> {}. Anything else invalid -> 400. */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.trim() === "") return {};
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new ChatError(400, "invalid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ChatError(400, "expected a JSON object");
  return v as Record<string, unknown>;
}
