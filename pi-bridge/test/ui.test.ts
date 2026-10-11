import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, harness, type Harness, readEvents, settled } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

async function confirmFlow(chat: string, body: Record<string, unknown>) {
  await api(h, "POST", `/chats/${chat}/start`, {});
  const live = readEvents(h, chat, { until: settled, timeoutMs: 8000 });
  expect((await api(h, "POST", `/chats/${chat}/prompt`, { message: "CONFIRM rm" })).status).toBe(200);
  const asked = await readEvents(h, chat, {
    until: (f) => f.event === "extension_ui_request",
    timeoutMs: 5000,
  });
  const req = asked.frames.find((f) => f.event === "extension_ui_request")!;
  expect(req.data.method).toBe("confirm");
  expect(req.data.id).toBe("ui-1");
  const r = await api(h, "POST", `/chats/${chat}/ui_response`, { id: req.data.id, ...body });
  expect(r.status).toBe(200);
  return live;
}

describe("ui_response forwarding", () => {
  test("confirmed:true reaches Pi (tool runs, isError false)", async () => {
    const r = await confirmFlow("ui-yes", { confirmed: true });
    const res = await r;
    const end = res.frames.find((f) => f.event === "tool_execution_end")!;
    expect(end.data.isError).toBe(false);
    const text = res.frames.find((f) => f.event === "message_end" && f.data.message?.role === "assistant");
    expect(text!.data.message.content[0].text).toBe("got:true");
  });

  test("confirmed:false reaches Pi (tool result isError, file survives in the spike case)", async () => {
    const r = await confirmFlow("ui-no", { confirmed: false });
    const res = await r;
    const end = res.frames.find((f) => f.event === "tool_execution_end")!;
    expect(end.data.isError).toBe(true);
    const text = res.frames.find((f) => f.event === "message_end" && f.data.message?.role === "assistant");
    expect(text!.data.message.content[0].text).toBe("got:false");
  });

  test("ui_response on an unknown chat is 404; bad body is 400", async () => {
    expect((await api(h, "POST", "/chats/ghost/ui_response", { id: "x", confirmed: true })).status).toBe(404);
    await api(h, "POST", "/chats/ui-bad/start", {});
    expect((await api(h, "POST", "/chats/ui-bad/ui_response", { confirmed: true })).status).toBe(400);
  });
});

describe("abort while a question is waiting", () => {
  test("abort cancels the pending confirm first, so it returns promptly and the run ends", async () => {
    await api(h, "POST", "/chats/ui-abort/start", {});
    const live = readEvents(h, "ui-abort", { until: settled, timeoutMs: 8000 });
    await api(h, "POST", "/chats/ui-abort/prompt", { message: "CONFIRM rm" });
    await readEvents(h, "ui-abort", { until: (f) => f.event === "extension_ui_request", timeoutMs: 5000 });
    const t0 = Date.now();
    const r = await api(h, "POST", "/chats/ui-abort/abort", {});
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    const run = await live;
    expect(run.frames.some((f) => f.event === "agent_settled")).toBe(true);
    const tool = run.frames.find((f) => f.event === "tool_execution_end");
    expect(tool?.data.isError).toBe(true); // the question was declined, the command did not run
  });

  test("a question that was already answered is not cancelled twice", async () => {
    await api(h, "POST", "/chats/ui-abort2/start", {});
    const live = readEvents(h, "ui-abort2", { until: settled, timeoutMs: 8000 });
    await api(h, "POST", "/chats/ui-abort2/prompt", { message: "CONFIRM rm" });
    await readEvents(h, "ui-abort2", { until: (f) => f.event === "extension_ui_request", timeoutMs: 5000 });
    await api(h, "POST", "/chats/ui-abort2/ui_response", { id: "ui-1", confirmed: true });
    await live;
    expect((await api(h, "POST", "/chats/ui-abort2/abort", {})).status).toBe(200);
  });

  test("abort on an idle chat with nothing pending is still ok", async () => {
    await api(h, "POST", "/chats/ui-abort3/start", {});
    expect((await api(h, "POST", "/chats/ui-abort3/abort", {})).status).toBe(200);
  });
});
