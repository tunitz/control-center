import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, harness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await harness();
  const r = await api(h, "POST", "/chats/al-1/start", {});
  expect(r.status).toBe(200);
});
afterAll(async () => {
  await h.close();
});

describe("command allowlist", () => {
  test.each(["bash", "get_env", "fork", "clone", "export_html", "cycle_model", "not_a_command", ""])(
    "rejects %p with 400",
    async (name) => {
      const r = await api(h, "POST", "/chats/al-1/command", { name, args: {} });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/not allowed|unknown|name/i);
    },
  );

  test.each([
    "get_state",
    "get_messages",
    "get_entries",
    "get_available_models",
    "get_available_thinking_levels",
    "get_commands",
    "new_session",
        "set_session_name",
    "compact",
    "set_auto_compaction",
    "set_auto_retry",
    "set_steering_mode",
    "set_follow_up_mode",
  ])("allows %p", async (name) => {
    const r = await api(h, "POST", "/chats/al-1/command", { name, args: {} });
    expect(r.status).toBe(200);
  });

  test("switch_session needs a valid sessionPath inside the session dir", async () => {
    const bad = await api(h, "POST", "/chats/al-1/command", { name: "switch_session", args: {} });
    expect(bad.status).toBe(400);
    const good = await api(h, "POST", "/chats/al-1/command", {
      name: "switch_session",
      args: { sessionPath: join(h.cfg.sessionDir, "s.jsonl") },
    });
    expect(good.status).toBe(200);
  });

  test("args cannot override the command type", async () => {
    const r = await api(h, "POST", "/chats/al-1/command", {
      name: "set_session_name",
      args: { type: "bash", command: "id" },
    });
    expect(r.status).toBe(200);
    const st = await api(h, "POST", "/chats/al-1/command", { name: "get_state" });
    expect(st.status).toBe(200);
  });

  test("unknown chat is 404, malformed chat id is 400", async () => {
    expect((await api(h, "POST", "/chats/nobody/command", { name: "get_state" })).status).toBe(404);
    expect((await api(h, "POST", "/chats/..%2Fetc/command", { name: "get_state" })).status).toBe(400);
  });
});
