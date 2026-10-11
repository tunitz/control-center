/** Markdown export of a chat. Reasoning and tool details are omitted on purpose. */
export type ExportMessage = {
  role: "user" | "assistant";
  text: string;
  status: string;
  reasoning: string | null;
  attachments: { name: string }[];
};

export function toMarkdown(input: { title: string; model: string; createdAt: number; messages: ExportMessage[] }): string {
  const out: string[] = [];
  out.push(`# ${input.title}`, "");
  out.push(`Model: ${input.model}  `, `Created: ${new Date(input.createdAt).toISOString()}`, "", "---", "");
  for (const m of input.messages) {
    out.push(`## ${m.role === "user" ? "You" : "Assistant"}`, "");
    for (const a of m.attachments) out.push(`Attachment: ${a.name}`, "");
    if (m.text) out.push(m.text, "");
    if (m.status !== "complete") out.push(`_(${m.status})_`, "");
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
