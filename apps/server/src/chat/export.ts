/** Markdown export of a chat. Reasoning and tool details are omitted on purpose. */
export type ExportMessage = {
  seq: number;
  role: "user" | "assistant";
  text: string;
  status: string;
  reasoning: string | null;
  attachments: { name: string }[];
};
/** A local command row, anchored after the message with this seq (0 = before the first). */
export type ExportCommand = { afterSeq: number; name: string; body: string };

export function toMarkdown(input: { title: string; model: string; createdAt: number; messages: ExportMessage[]; commands?: ExportCommand[] }): string {
  const out: string[] = [];
  out.push(`# ${input.title}`, "");
  out.push(`Model: ${input.model}  `, `Created: ${new Date(input.createdAt).toISOString()}`, "", "---", "");
  const byAnchor = new Map<number, ExportCommand[]>();
  for (const c of input.commands ?? []) byAnchor.set(c.afterSeq, [...(byAnchor.get(c.afterSeq) ?? []), c]);
  const commands = (seq: number) => {
    for (const c of byAnchor.get(seq) ?? []) {
      out.push(`**/${c.name}**`, "");
      if (c.body) out.push(c.body, "");
    }
  };
  commands(0);
  for (const m of input.messages) {
    out.push(`## ${m.role === "user" ? "You" : "Assistant"}`, "");
    for (const a of m.attachments) out.push(`Attachment: ${a.name}`, "");
    if (m.text) out.push(m.text, "");
    if (m.status !== "complete") out.push(`_(${m.status})_`, "");
    commands(m.seq);
  }
  return out.join("\n");
}

/** Safe, unicode-friendly file name: runs of non letters/digits become "-". Max 60 chars. */
export function exportFilename(title: string): string {
  const s = title
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
  const base = Array.from(s).slice(0, 60).join("");
  return `${base || "chat"}.md`;
}
