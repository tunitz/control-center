/**
 * Builds the Hermes `message` for a turn. Pure: no DB, no disk.
 * - text only -> string
 * - non-image files -> "Attached file:" lines (absolute path) before the text
 * - images -> content parts with a data URL (must be at least 64px per side)
 */
import { ChatError } from "./http";

export type PromptAttachment = {
  kind: "image" | "file";
  name: string;
  mime: string;
  size: number;
  path: string;
  w: number | null;
  h: number | null;
  bytes?: Uint8Array;
};

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export const MIN_IMAGE_SIDE = 64;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Throws the contract's 400 errors for an image that cannot be sent to the model. */
export function assertImageSize(w: number | null, h: number | null): void {
  if (w === null || h === null) throw new ChatError(400, "image unreadable");
  if (w < MIN_IMAGE_SIDE || h < MIN_IMAGE_SIDE) throw new ChatError(400, "image too small");
}

/** Display name for the prompt: control chars and newlines removed, max 200 code points. */
export function promptName(name: string): string {
  return Array.from(name.replace(CONTROL_RE, "").trim()).slice(0, 200).join("");
}

export function buildPrompt(input: { text: string; attachments: PromptAttachment[] }): { message: string | ContentPart[] } {
  const lines: string[] = [];
  const images: PromptAttachment[] = [];
  for (const a of input.attachments) {
    if (a.kind === "image") {
      assertImageSize(a.w, a.h);
      images.push(a);
      continue;
    }
    lines.push(`Attached file: ${a.path} (${promptName(a.name)}, ${a.mime}, ${a.size} bytes)`);
    if (a.mime === "application/pdf") {
      lines.push("Note: Text PDFs only. Scanned or image-only PDFs cannot be read.");
    }
  }
  const prefix = lines.length ? lines.join("\n") + "\n" : "";
  const text = prefix + input.text;

  if (images.length === 0) {
    return { message: text };
  }
  const parts: ContentPart[] = [{ type: "text", text }];
  for (const img of images) {
    if (!img.bytes) throw new ChatError(500, "image bytes missing");
    const b64 = Buffer.from(img.bytes).toString("base64");
    parts.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${b64}` } });
  }
  return { message: parts };
}
