import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, harness, type Harness, readEvents, settled } from "./helpers";

let h: Harness;
let small: Harness;

beforeAll(async () => {
  h = await harness();
  small = await harness({ ringSize: 5 });
});
afterAll(async () => {
  await h.close();
  await small.close();
});

async function runPrompt(hh: Harness, chat: string, message: string) {
  const start = await api(hh, "POST", `/chats/${chat}/start`, {});
  expect(start.status).toBe(200);
  const p = await api(hh, "POST", `/chats/${chat}/prompt`, { message });
  expect(p.status).toBe(200);
  expect(p.json.disposition).toBe("started");
}

describe("event stream", () => {
  test("SSE carries Pi events in order with monotonic ids, ending in agent_settled", async () => {
    await runPrompt(h, "ev-order", "say hi");
    const r = await readEvents(h, "ev-order", { until: settled, timeoutMs: 5000 });
    expect(r.status).toBe(200);
    expect(r.matched).toBe(true);
    const types = r.frames.map((f) => f.event);
    expect(types.slice(0, 3)).toEqual(["agent_start", "turn_start", "message_start"]);
    expect(types.at(-1)).toBe("agent_settled");
    const ids = r.frames.map((f) => f.id as number);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBeGreaterThan(0);
  });

  test("reconnect with after=n replays only events with id > n", async () => {
    const full = await readEvents(h, "ev-order", { until: settled, timeoutMs: 5000 });
    const mid = full.frames[2].id as number;
    const replay = await readEvents(h, "ev-order", {
      after: mid,
      until: settled,
      timeoutMs: 3000,
    });
    expect(replay.frames.length).toBe(full.frames.length - 3);
    expect(replay.frames[0].id).toBe(mid + 1);
    expect(replay.frames.some((f) => f.event === "gap")).toBe(false);
  });

  test("after=n that fell out of the ring yields a gap event first, then the oldest events", async () => {
    await runPrompt(small, "ev-gap", "say hi");
    // Let the run finish first, so the 5-slot ring has already dropped the early events.
    const done = await readEvents(small, "ev-gap", { until: settled, timeoutMs: 5000 });
    expect(done.matched).toBe(true);
    const full = await readEvents(small, "ev-gap", { after: 0, until: settled, timeoutMs: 3000 });
    expect(full.frames.some((f) => f.event === "gap")).toBe(true);
    const oldest = full.frames.find((f) => f.event !== "gap")!.id as number;
    expect(oldest).toBeGreaterThan(1);

    const r = await readEvents(small, "ev-gap", { after: 1, until: settled, timeoutMs: 3000 });
    expect(r.frames[0].event).toBe("gap");
    expect(r.frames[0].data.requested).toBe(1);
    expect(r.frames[0].data.oldest).toBe(oldest);
    expect(r.frames[1].id).toBe(oldest);
  });

  test("agent_settled carries stopReason and errorMessage of the last assistant message (error)", async () => {
    await runPrompt(h, "ev-err", "ERR please");
    const r = await readEvents(h, "ev-err", { until: settled, timeoutMs: 5000 });
    const s = r.frames.find(settled)!;
    expect(s.data.stopReason).toBe("error");
    expect(s.data.errorMessage).toBe("boom: provider down");
  });

  test("agent_settled carries stopReason aborted after abort", async () => {
    await runPrompt(h, "ev-abort", "SLOW one");
    const live = readEvents(h, "ev-abort", { until: settled, timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 150));
    expect((await api(h, "POST", "/chats/ev-abort/abort", {})).status).toBe(200);
    const r = await live;
    const s = r.frames.find(settled)!;
    expect(s.data.stopReason).toBe("aborted");
    expect(s.data.errorMessage).toBe("Request was aborted");
  });

  test("a normal run settles with stopReason stop", async () => {
    await runPrompt(h, "ev-stop", "say hi");
    const r = await readEvents(h, "ev-stop", { until: settled, timeoutMs: 5000 });
    expect(r.frames.find(settled)!.data.stopReason).toBe("stop");
  });

  test("raw U+2028 inside a delta survives end to end", async () => {
    await runPrompt(h, "ev-u2028", "U2028 please");
    const r = await readEvents(h, "ev-u2028", { until: settled, timeoutMs: 5000 });
    const deltas = r.frames
      .filter((f) => f.event === "message_update")
      .map((f) => f.data.assistantMessageEvent?.delta)
      .filter((d) => typeof d === "string");
    expect(deltas).toContain("a\u2028b\u2029c");
  });

  test("a Pi crash emits process_exit, drops the chat and ends the stream", async () => {
    await runPrompt(h, "ev-crash", "CRASH now");
    const r = await readEvents(h, "ev-crash", { until: (f) => f.event === "process_exit", timeoutMs: 5000 });
    expect(r.matched).toBe(true);
    expect(r.frames.at(-1)!.data.code).toBe(3);
    expect((await api(h, "POST", "/chats/ev-crash/prompt", { message: "x" })).status).toBe(404);
  });

  test("prompt validation and disposition", async () => {
    expect((await api(h, "POST", "/chats/nope/prompt", { message: "x" })).status).toBe(404);
    await api(h, "POST", "/chats/ev-val/start", {});
    expect((await api(h, "POST", "/chats/ev-val/prompt", {})).status).toBe(400);
    expect((await api(h, "POST", "/chats/ev-val/prompt", { message: "" })).status).toBe(400);
    expect((await api(h, "POST", "/chats/ev-val/prompt", { message: "x", images: "no" })).status).toBe(400);
  });

  test("a second prompt while streaming is rejected by Pi and reported as 409", async () => {
    await runPrompt(h, "ev-busy", "SLOW wait");
    const second = await api(h, "POST", "/chats/ev-busy/prompt", { message: "again" });
    expect(second.status).toBe(409);
    expect(second.json.error).toMatch(/processing/i);
    await api(h, "POST", "/chats/ev-busy/abort", {});
  });
});
