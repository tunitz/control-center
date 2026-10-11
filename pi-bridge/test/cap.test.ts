import { describe, expect, test } from "bun:test";
import { api, harness } from "./helpers";

describe("process cap", () => {
  test("start is idempotent and delete frees a slot", async () => {
    const h = await harness({ maxLive: 3 });
    try {
      for (const id of ["cap-a", "cap-b", "cap-c"]) {
        expect((await api(h, "POST", `/chats/${id}/start`, {})).status).toBe(200);
      }
      const again = await api(h, "POST", "/chats/cap-a/start", {});
      expect(again.status).toBe(200);
      expect(again.json.sessionFile).toBeTruthy();

      expect((await api(h, "DELETE", "/chats/cap-b")).status).toBe(200);
      expect((await api(h, "POST", "/chats/cap-d/start", {})).status).toBe(200);
      expect(h.bridge.chats.size()).toBe(3);
    } finally {
      await h.close();
    }
  });
});

describe("process cap evicts the least recently used idle chat", () => {
  test("a fourth chat evicts the oldest idle one; the evicted chat resumes from its session file", async () => {
    const h = await harness({ maxLive: 3 });
    try {
      const files: Record<string, string> = {};
      for (const id of ["ev-a", "ev-b", "ev-c"]) {
        files[id] = (await api(h, "POST", `/chats/${id}/start`, {})).json.sessionFile;
        await Bun.sleep(5);
      }
      await api(h, "POST", "/chats/ev-a/command", { name: "get_state" }); // touch a: b is now the oldest
      const d = await api(h, "POST", "/chats/ev-d/start", {});
      expect(d.status).toBe(200);
      expect(h.bridge.chats.size()).toBe(3);
      expect((await api(h, "POST", "/chats/ev-b/command", { name: "get_state" })).status).toBe(404); // evicted
      expect((await api(h, "POST", "/chats/ev-a/command", { name: "get_state" })).status).toBe(200);
      const back = await api(h, "POST", "/chats/ev-b/start", { sessionPath: files["ev-b"] });
      expect(back.status).toBe(200);
      expect(back.json.sessionFile).toBe(files["ev-b"]);
    } finally {
      await h.close();
    }
  });

  test("a chat with an active run is never evicted: when every chat is busy the answer is still 429", async () => {
    const h = await harness({ maxLive: 2 });
    try {
      for (const id of ["bz-a", "bz-b"]) {
        await api(h, "POST", `/chats/${id}/start`, {});
        await api(h, "POST", `/chats/${id}/prompt`, { message: "SLOW please" });
      }
      for (let i = 0; i < 100; i++) {
        const st = await Promise.all(["bz-a", "bz-b"].map(async (id) => (await api(h, "POST", `/chats/${id}/command`, { name: "get_state" })).json.data.isStreaming));
        if (st.every(Boolean)) break;
        await Bun.sleep(10);
      }
      expect((await api(h, "POST", "/chats/bz-c/start", {})).status).toBe(429);
      expect((await api(h, "POST", "/chats/bz-a/command", { name: "get_state" })).status).toBe(200);
      await api(h, "POST", "/chats/bz-a/abort", {}); await api(h, "POST", "/chats/bz-b/abort", {});
    } finally {
      await h.close();
    }
  });

  test("one idle and one busy chat: the idle one is evicted", async () => {
    const h = await harness({ maxLive: 2 });
    try {
      await api(h, "POST", "/chats/mx-idle/start", {});
      await Bun.sleep(5);
      await api(h, "POST", "/chats/mx-busy/start", {});
      await api(h, "POST", "/chats/mx-busy/prompt", { message: "SLOW please" });
      for (let i = 0; i < 100 && !(await api(h, "POST", "/chats/mx-busy/command", { name: "get_state" })).json.data.isStreaming; i++) await Bun.sleep(10);
      expect((await api(h, "POST", "/chats/mx-new/start", {})).status).toBe(200);
      expect((await api(h, "POST", "/chats/mx-busy/command", { name: "get_state" })).status).toBe(200);
      expect((await api(h, "POST", "/chats/mx-idle/command", { name: "get_state" })).status).toBe(404);
      await api(h, "POST", "/chats/mx-busy/abort", {});
    } finally {
      await h.close();
    }
  });
});
