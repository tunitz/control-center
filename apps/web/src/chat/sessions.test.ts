import { test, expect } from "bun:test";
import { groupSessions } from "./sessions";
import type { ChatSession } from "./types";

const s = (id: string, o: Partial<ChatSession> = {}): ChatSession => ({ id, title: id, titleAuto: true, model: "m", provider: "p", effort: null, pinned: false, archived: false, createdAt: 0, updatedAt: 0, runState: "idle", runId: null, unread: false, preview: "", ...o });
// Local-time dates so the test is timezone independent.
const now = new Date(2026, 9, 11, 15, 0).getTime();
const at = (d: number, h = 9) => new Date(2026, 9, d, h).getTime();

test("pinned first, then time buckets newest first", () => {
  const g = groupSessions([
    s("old", { updatedAt: at(1) }),
    s("today", { updatedAt: at(11, 10) }),
    s("pin", { pinned: true, updatedAt: at(2) }),
    s("yest", { updatedAt: at(10) }),
    s("week", { updatedAt: at(6) }),
    s("today2", { updatedAt: at(11, 12) }),
  ], now);
  expect(g.map(x => x.label)).toEqual(["Pinned", "Today", "Yesterday", "Previous 7 days", "Older"]);
  expect(g[0].items.map(x => x.id)).toEqual(["pin"]);
  expect(g[1].items.map(x => x.id)).toEqual(["today2", "today"]);
  expect(g[4].items.map(x => x.id)).toEqual(["old"]);
});

test("empty buckets are omitted and empty input gives no groups", () => {
  expect(groupSessions([], now)).toEqual([]);
  const g = groupSessions([s("a", { updatedAt: at(11) })], now);
  expect(g.map(x => x.label)).toEqual(["Today"]);
});
