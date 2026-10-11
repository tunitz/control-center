import { describe, expect, test } from "bun:test";
import { api, harness, sleep } from "./helpers";

describe("idle reaper", () => {
  test("an idle chat is exited after idleMs and dropped from the table", async () => {
    const h = await harness({ idleMs: 200, reapIntervalMs: 30 });
    try {
      expect((await api(h, "POST", "/chats/idle-1/start", {})).status).toBe(200);
      expect(h.bridge.chats.size()).toBe(1);
      await sleep(600);
      expect(h.bridge.chats.size()).toBe(0);
      expect((await api(h, "POST", "/chats/idle-1/prompt", { message: "hi" })).status).toBe(404);
    } finally {
      await h.close();
    }
  });

  test("a chat with an active run is never reaped; it is reaped after the run settles", async () => {
    const h = await harness({ idleMs: 150, reapIntervalMs: 30 });
    try {
      await api(h, "POST", "/chats/run-1/start", {});
      const p = await api(h, "POST", "/chats/run-1/prompt", { message: "SLOW please" });
      expect(p.status).toBe(200);
      await sleep(500);
      expect(h.bridge.chats.size()).toBe(1);
      expect((await api(h, "POST", "/chats/run-1/command", { name: "get_state" })).status).toBe(200);

      expect((await api(h, "POST", "/chats/run-1/abort", {})).status).toBe(200);
      await sleep(500);
      expect(h.bridge.chats.size()).toBe(0);
    } finally {
      await h.close();
    }
  });
});
