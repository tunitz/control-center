import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { api, harness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const state = async (id: string) => (await api(h, "POST", `/chats/${id}/command`, { name: "get_state" })).json.data;

describe("start settings", () => {
  test("settings are applied after model and thinking", async () => {
    const r = await api(h, "POST", "/chats/st-1/start", {
      thinking: "low",
      settings: { steeringMode: "all", followUpMode: "all", autoCompaction: false, autoRetry: false },
    });
    expect(r.status).toBe(200);
    const s = r.json.state;
    expect(s.thinkingLevel).toBe("low");
    expect(s.steeringMode).toBe("all");
    expect(s.followUpMode).toBe("all");
    expect(s.autoCompactionEnabled).toBe(false);
    expect(s.autoRetryEnabled).toBe(false);
  });

  test("a partial settings object touches only the named keys", async () => {
    await api(h, "POST", "/chats/st-2/start", { settings: { autoRetry: false } });
    const s = await state("st-2");
    expect(s.autoRetryEnabled).toBe(false);
    expect(s.autoCompactionEnabled).toBe(true);
    expect(s.steeringMode).toBe("one-at-a-time");
  });

  test("start on an already-live chat applies settings again (idempotent)", async () => {
    await api(h, "POST", "/chats/st-3/start", { settings: { steeringMode: "all" } });
    const r = await api(h, "POST", "/chats/st-3/start", { settings: { steeringMode: "one-at-a-time", autoRetry: false } });
    expect(r.json.state.steeringMode).toBe("one-at-a-time");
    expect(r.json.state.autoRetryEnabled).toBe(false);
  });

  test("unknown keys, wrong types and bad modes are 400 and start nothing", async () => {
    const bad: unknown[] = [
      { bash: true },
      { steeringMode: "sometimes" },
      { followUpMode: 1 },
      { autoCompaction: "yes" },
      { autoRetry: null },
      "all",
      [],
    ];
    for (const settings of bad) {
      const r = await api(h, "POST", "/chats/st-bad/start", { settings });
      expect(r.status).toBe(400);
    }
    expect((await api(h, "POST", "/chats/st-bad/command", { name: "get_state" })).status).toBe(404);
  });
});

describe("compact", () => {
  test("compact passes through the allowlist and returns Pi's numbers", async () => {
    await api(h, "POST", "/chats/st-c/start", {});
    const r = await api(h, "POST", "/chats/st-c/command", { name: "compact", args: {} });
    expect(r.status).toBe(200);
    expect(r.json.data).toMatchObject({ tokensBefore: 1000, estimatedTokensAfter: 200 });
  });
});
