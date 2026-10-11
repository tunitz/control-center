import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  writeFileSync(
    join(h.cfg.sessionDir, "2026-10-11T01-00-00-000Z_aaaa1111.jsonl"),
    [
      JSON.stringify({ type: "session", version: 3, id: "aaaa1111", timestamp: "2026-10-11T01:00:00.000Z", cwd: "/w/one" }),
      JSON.stringify({ type: "session_info", id: "s1", parentId: null, timestamp: "2026-10-11T01:00:01.000Z", name: "first" }),
      JSON.stringify({ type: "message", id: "m1", parentId: "s1", timestamp: "2026-10-11T01:00:02.000Z", message: { role: "user", content: "hello there" } }),
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(h.cfg.sessionDir, "2026-10-11T02-00-00-000Z_bbbb2222.jsonl"),
    JSON.stringify({ type: "session", version: 3, id: "bbbb2222", timestamp: "2026-10-11T02:00:00.000Z", cwd: "/w/two" }) + "\n",
  );
});
afterAll(async () => {
  await h.close();
});

describe("GET /sessions and /models", () => {
  test("lists sessions from the session dir (header fallback when the SDK is absent)", async () => {
    const r = await api(h, "GET", "/sessions");
    expect(r.status).toBe(200);
    const byId = Object.fromEntries(r.json.sessions.map((s: any) => [s.id, s]));
    expect(Object.keys(byId).sort()).toEqual(["aaaa1111", "bbbb2222"]);
    expect(byId.aaaa1111.cwd).toBe("/w/one");
    expect(byId.aaaa1111.name).toBe("first");
    expect(byId.aaaa1111.path).toBe(join(h.cfg.sessionDir, "2026-10-11T01-00-00-000Z_aaaa1111.jsonl"));
    expect(byId.aaaa1111.firstMessage).toBe("hello there");
    expect(byId.bbbb2222.name).toBeUndefined();
  });

  test("GET /models proxies get_available_models via a short-lived process when none is live", async () => {
    const r = await api(h, "GET", "/models");
    expect(r.status).toBe(200);
    expect(r.json.models.map((m: any) => m.id)).toEqual(["deepseek-flash", "deepseek-pro"]);
    expect(h.bridge.chats.size()).toBe(0);
  });
});
