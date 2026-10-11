/** Auto-title: first 8 words of the first user message. */
export function autoTitle(firstUserText: string): string {
  const words = firstUserText.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "New chat";
  return Array.from(words.slice(0, 8).join(" ")).slice(0, 80).join("");
}
