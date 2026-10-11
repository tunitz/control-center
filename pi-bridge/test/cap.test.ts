import { describe, expect, test } from "bun:test";
import { api, harness } from "./helpers";

describe("process cap", () => {
  test("a fourth live chat gets 429; start is idempotent; delete frees a slot", async () => {
    const h = await harness({ maxLive: 3 });
    try {
      for (const id of ["cap-a", "cap-b", "cap-c"]) {
        expect((await api(h, "POST", `/chats/${id}/start`, {})).status).toBe(200);
      }
      const denied = await api(h, "POST", "/chats/cap-d/start", {});
      expect(denied.status).toBe(429);

      const again = await api(h, "POST", "/chats/cap-a/start", {});
      expect(again.status).toBe(200);
      expect(again.json.sessionFile).toBeTruthy();

      expect((await api(h, "DELETE", "/chats/cap-b")).status).toBe(200);
      expect((await api(h, "POST", "/chats/cap-d/start", {})).status).toBe(200);
      expect((await api(h, "POST", "/chats/cap-e/start", {})).status).toBe(429);
    } finally {
      await h.close();
    }
  });
});
