import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = import.meta.dir;
const read = (file: string) => readFileSync(join(SRC, file), "utf8");

test("the server has no chat module", () => {
  const index = read("index.ts");
  expect(index).not.toContain("./chat/");
  expect(index).not.toContain("handleChat");
  expect(index).not.toContain("createChatContext");
  expect(index).not.toContain("/api/chat");
  expect(index).not.toContain("chatCtx");
});

test("the database has no chat schema or chat migrations", () => {
  const db = read("db.ts");
  expect(db).not.toContain("CHAT_SCHEMA");
  expect(db).not.toContain("migrateChatSessions");
  expect(db).not.toContain("migrateChatCommands");
  expect(db).not.toContain("migrateChatMessages");
  expect(db).not.toContain("chat_sessions");
  expect(db).not.toContain("chat_messages");
});
