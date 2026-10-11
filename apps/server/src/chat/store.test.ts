import { test, expect, beforeEach } from "bun:test";
import { openDb } from "../db";
import * as S from "./store";

let db: ReturnType<typeof openDb>;
beforeEach(() => { db = openDb(":memory:"); });

const mk = (id: string, t: number, extra: Partial<{ title: string }> = {}) =>
  S.createSession(db, { id, model: "claude-sonnet-5-5", provider: "anthropic", effort: null, now: t, ...extra });

test("createSession returns the contract shape with ms timestamps and idle run state", () => {
  const s = mk("s1", 1000);
  expect(s).toEqual({
    id: "s1", title: "New chat", titleAuto: true, model: "claude-sonnet-5-5", provider: "anthropic", effort: null, cwd: null,
    pinned: false, archived: false, createdAt: 1000, updatedAt: 1000, runState: "idle", runId: null, unread: false, preview: "", awaiting: 0,
  });
});

test("list: pinned first then updatedAt desc; archived filter", () => {
  mk("a", 1); mk("b", 2); mk("c", 3);
  S.updateSession(db, "a", { pinned: true }, 10);
  S.updateSession(db, "c", { archived: true }, 11);
  expect(S.listSessions(db, {}).map(s => s.id)).toEqual(["a", "b"]);
  expect(S.listSessions(db, { archived: true }).map(s => s.id)).toEqual(["c"]);
});

test("updateSession: title sets titleAuto=false; model change does not touch model_locked", () => {
  mk("s1", 1);
  const s = S.updateSession(db, "s1", { title: "Renamed", model: "deepseek-flash", provider: "deepseek", effort: "high" }, 5)!;
  expect(s).toMatchObject({ title: "Renamed", titleAuto: false, model: "deepseek-flash", provider: "deepseek", effort: "high", updatedAt: 5 });
  expect((db.query("SELECT model_locked FROM chat_sessions WHERE id='s1'").get() as any).model_locked).toBeNull();
  expect(S.updateSession(db, "nope", { pinned: true }, 1)).toBeNull();
});

test("deleteSession removes mirror rows and returns attachment paths for file cleanup", () => {
  mk("s1", 1);
  S.insertMessage(db, { id: "m1", sessionId: "s1", seq: 1, role: "user", text: "kiwi", createdAt: 1, status: "complete", attachments: [
    { id: "a1", kind: "file", name: "x.txt", mime: "text/plain", size: 3, sha256: "h", path: "/p/x.txt", w: null, h: null },
  ] });
  const paths = S.deleteSession(db, "s1");
  expect(paths).toEqual(["/p/x.txt"]);
  expect(S.getSession(db, "s1")).toBeNull();
  expect((db.query("SELECT count(*) c FROM chat_messages").get() as any).c).toBe(0);
});

test("deleteMessage drops one message and returns its file paths; truncateFrom drops a seq range", () => {
  mk("s1", 1);
  for (let i = 1; i <= 4; i++) S.insertMessage(db, { id: `m${i}`, sessionId: "s1", seq: i, role: i % 2 ? "user" : "assistant", text: `t${i}`, createdAt: i, status: "complete", attachments: i === 1 ? [
    { id: "a1", kind: "file", name: "x.txt", mime: "text/plain", size: 3, sha256: "h", path: "/p/x.txt", w: null, h: null },
  ] : i === 3 ? [
    { id: "a3", kind: "file", name: "y.txt", mime: "text/plain", size: 3, sha256: "h", path: "/p/y.txt", w: null, h: null },
  ] : [] });
  expect(S.getMessageMeta(db, "m2")).toEqual({ sessionId: "s1", seq: 2, role: "assistant", text: "t2" });
  expect(S.deleteMessage(db, "m2")).toEqual([]);
  expect(S.getMessageMeta(db, "m2")).toBeNull();
  expect(S.listAllMessages(db, "s1").map(m => m.seq)).toEqual([1, 3, 4]);
  // A retry branches at seq 3: that row and everything after it go, with their files.
  expect(S.truncateFrom(db, "s1", 3)).toEqual(["/p/y.txt"]);
  expect(S.listAllMessages(db, "s1").map(m => m.seq)).toEqual([1]);
  expect(S.getMessageMeta(db, "nope")).toBeNull();
});

test("commands: insert anchors, list is ordered, deleteCommandsFrom drops a tail; lastSeq tracks messages", () => {
  mk("s1", 1);
  expect(S.lastSeq(db, "s1")).toBe(0);
  S.insertMessage(db, { id: "m1", sessionId: "s1", seq: 1, role: "user", text: "hi", createdAt: 1, status: "complete", attachments: [] });
  expect(S.lastSeq(db, "s1")).toBe(1);
  const a = S.insertCommand(db, { sessionId: "s1", name: "help", body: "commands", afterSeq: S.lastSeq(db, "s1"), createdAt: 5 });
  S.insertCommand(db, { sessionId: "s1", name: "model", body: "set", afterSeq: 1, createdAt: 6 });
  expect(a).toMatchObject({ name: "help", body: "commands", afterSeq: 1, createdAt: 5 });
  expect(typeof a.id).toBe("number");
  expect(S.listCommands(db, "s1").map(c => c.name)).toEqual(["help", "model"]);
  S.deleteCommandsFrom(db, "s1", 1);
  expect(S.listCommands(db, "s1")).toEqual([]);
});

test("listMessages: newest page by default, before= paging, ascending order, hasMore, attachments with url", () => {
  mk("s1", 1);
  for (let i = 1; i <= 5; i++) S.insertMessage(db, { id: `m${i}`, sessionId: "s1", seq: i, role: i % 2 ? "user" : "assistant", text: `t${i}`, createdAt: i, status: "complete", attachments: i === 5 ? [
    { id: "att5", kind: "image", name: "p.png", mime: "image/png", size: 9, sha256: "h", path: "/p.png", w: 128, h: 64 },
  ] : [] });
  const newest = S.listMessages(db, "s1", { limit: 2 });
  expect(newest.messages.map(m => m.seq)).toEqual([4, 5]);
  expect(newest.hasMore).toBe(true);
  expect(newest.messages[1].attachments).toEqual([{ id: "att5", kind: "image", name: "p.png", mime: "image/png", size: 9, w: 128, h: 64, url: "/api/chat/files/att5" }]);
  const older = S.listMessages(db, "s1", { before: 4, limit: 2 });
  expect(older.messages.map(m => m.seq)).toEqual([2, 3]);
  expect(older.hasMore).toBe(true);
  const first = S.listMessages(db, "s1", { before: 2, limit: 40 });
  expect(first).toEqual({ messages: [expect.objectContaining({ seq: 1 })], hasMore: false });
  expect(S.listMessages(db, "s1", { limit: 999 }).messages.length).toBe(5);
});

test("messages carry tools, usage, reasoning and status; interrupted is kept as-is", () => {
  mk("s1", 1);
  S.insertMessage(db, { id: "m1", sessionId: "s1", seq: 1, role: "assistant", text: "partial", reasoning: "r", createdAt: 1, status: "interrupted", error: "stopped",
    tools: [{ id: "t1", name: "terminal", args: { cmd: "ls" }, preview: "ok", status: "ok", durationMs: 12 }], usage: { input: 3, output: 4 }, runId: "run1", model: "m", attachments: [] });
  const m = S.listMessages(db, "s1", {}).messages[0];
  expect(m).toMatchObject({ status: "interrupted", error: "stopped", reasoning: "r", usage: { input: 3, output: 4 }, runId: "run1", model: "m", tools: [{ name: "terminal", args: { cmd: "ls" }, durationMs: 12, status: "ok" }] });
});

test("search: FTS match with snippet, title match, substring/CJK fallback, injection-safe", () => {
  mk("s1", 1, { title: "Fruit planning" });
  mk("s2", 2);
  mk("s3", 3);
  S.insertMessage(db, { id: "m1", sessionId: "s1", seq: 1, role: "user", text: "buy pineapple and mango", createdAt: 1, status: "complete", attachments: [] });
  S.insertMessage(db, { id: "m2", sessionId: "s2", seq: 1, role: "user", text: "这是资料库", createdAt: 2, status: "complete", attachments: [] });
  const hit = S.searchSessions(db, { q: "pineapple", archived: false });
  expect(hit.map(s => s.id)).toEqual(["s1"]);
  expect(hit[0].snippet).toContain("pineapple");
  expect(S.searchSessions(db, { q: "fruit" }).map(s => s.id)).toEqual(["s1"]);
  expect(S.searchSessions(db, { q: "资料" }).map(s => s.id)).toEqual(["s2"]);
  expect(S.searchSessions(db, { q: "pine*" }).map(s => s.id)).toEqual(["s1"]);
  expect(() => S.searchSessions(db, { q: "\" OR * NEAR( ) -- '; DROP TABLE chat_messages" })).not.toThrow();
  expect(S.searchSessions(db, { q: "   " }).length).toBe(3);
  expect(S.searchSessions(db, { q: "nothinghere" })).toEqual([]);
});

test("preview is the last message text trimmed to 140 chars", () => {
  mk("s1", 1);
  S.insertMessage(db, { id: "m1", sessionId: "s1", seq: 1, role: "user", text: "x".repeat(300), createdAt: 1, status: "complete", attachments: [] });
  expect(S.getSession(db, "s1")!.preview.length).toBe(140);
});

test("listPiCwds returns distinct Pi working folders only", () => {
  S.createSession(db, { id: "p1", model: "m", provider: "p", effort: null, now: 1, backend: "pi", cwd: "/a" });
  S.createSession(db, { id: "p2", model: "m", provider: "p", effort: null, now: 1, backend: "pi", cwd: "/b" });
  S.createSession(db, { id: "p3", model: "m", provider: "p", effort: null, now: 1, backend: "pi", cwd: "/a" });
  S.createSession(db, { id: "h1", model: "m", provider: "p", effort: null, now: 1 });
  expect(S.listPiCwds(db)).toEqual(["/a", "/b"]);
});
