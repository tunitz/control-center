import type { ChatSession } from "./types";

export type Group = { label: string; items: ChatSession[] };

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/** Pinned first, then by updatedAt desc; the rest bucketed by local calendar day. Empty buckets are dropped. */
export function groupSessions(list: ChatSession[], now: number): Group[] {
  const sorted = [...list].sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.updatedAt - a.updatedAt));
  const today = startOfDay(now);
  const buckets: Record<string, ChatSession[]> = { Pinned: [], Today: [], Yesterday: [], "Previous 7 days": [], Older: [] };
  for (const s of sorted) {
    if (s.pinned) { buckets.Pinned.push(s); continue; }
    const diff = Math.round((today - startOfDay(s.updatedAt)) / DAY);
    const label = diff <= 0 ? "Today" : diff === 1 ? "Yesterday" : diff <= 7 ? "Previous 7 days" : "Older";
    buckets[label].push(s);
  }
  return Object.entries(buckets).filter(([, items]) => items.length).map(([label, items]) => ({ label, items }));
}
