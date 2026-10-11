/** Short model name for the phone composer pill: "Claude Sonnet 5.5" -> "Sonnet 5.5". Never returns an empty string. */
export function shortModelLabel(label: string): string {
  const trimmed = label.trim();
  const short = trimmed.replace(/^claude\s+/i, "").trim();
  return short || trimmed;
}
