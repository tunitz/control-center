/** The host's `credits --discord` text as markdown the chat can render. Discord's `-# ` small-text lines become italics. */
export function creditsMarkdown(text: string): string {
  return text.replace(/\r/g, "").split("\n").map(l => l.replace(/^-#\s+(.*)$/, "*$1*")).join("\n").trim();
}
