import { test, expect, describe } from "bun:test";
import { backendLabel, keyOf, splitKey, viewModels, backendOfKey, modelUsable, effortChoices, todoSummary, tokenNote, sheetErrorText, swapBackend, defaultModelFor, newChoices, defaultBackend } from "./pi";
import type { ChatModel } from "./types";

const M = (over: Partial<ChatModel>): ChatModel => ({ id: "m", provider: "p", label: "M", reasoning: true, canDisableReasoning: true, vision: false, local: false, online: true, ...over });

describe("model keys", () => {
  test("Hermes ids stay as they are; Pi ids get a pi: prefix so equal ids never collide", () => {
    expect(keyOf("hermes", "claude")).toBe("claude");
    expect(keyOf(undefined, "claude")).toBe("claude");
    expect(keyOf("pi", "claude")).toBe("pi:claude");
  });
  test("splitKey is the inverse", () => {
    expect(splitKey("pi:claude")).toEqual({ backend: "pi", id: "claude" });
    expect(splitKey("claude")).toEqual({ backend: "hermes", id: "claude" });
    expect(backendOfKey("pi:x")).toBe("pi");
    expect(backendOfKey("x")).toBe("hermes");
  });
  test("viewModels rewrites only Pi models, keeping every other field", () => {
    const list = [M({ id: "a" }), M({ id: "a", backend: "pi", label: "A pi" })];
    const v = viewModels(list);
    expect(v.map(m => m.id)).toEqual(["a", "pi:a"]);
    expect(v[1].label).toBe("A pi");
    expect(v[1].backend).toBe("pi");
  });
});

describe("modelUsable: a chat keeps its backend", () => {
  const pi = M({ id: "pi:a", backend: "pi" });
  const he = M({ id: "a" });
  test("no chat yet: anything is usable", () => {
    expect(modelUsable(pi, null)).toBe(true);
    expect(modelUsable(he, null)).toBe(true);
  });
  test("an existing chat accepts only its own backend", () => {
    expect(modelUsable(pi, "pi")).toBe(true);
    expect(modelUsable(he, "pi")).toBe(false);
    expect(modelUsable(he, "hermes")).toBe(true);
    expect(modelUsable(pi, "hermes")).toBe(false);
  });
});

describe("effortChoices", () => {
  test("Hermes: unchanged rules", () => {
    expect(effortChoices(M({}), null)).toEqual(["off", "low", "medium", "high"]);
    expect(effortChoices(M({ canDisableReasoning: false }), null)).toEqual(["low", "medium", "high"]);
    expect(effortChoices(M({ reasoning: false }), null)).toEqual([]);
    expect(effortChoices(undefined, null)).toEqual([]);
  });
  test("Pi levels narrow the choices to what Pi reports; minimal and max are not reachable", () => {
    expect(effortChoices(M({ backend: "pi" }), ["off", "minimal", "low", "high", "max"])).toEqual(["off", "low", "high"]);
  });
  test("empty or unknown Pi levels leave the model-based choices alone", () => {
    expect(effortChoices(M({ backend: "pi" }), [])).toEqual(["off", "low", "medium", "high"]);
    expect(effortChoices(M({ backend: "pi" }), null)).toEqual(["off", "low", "medium", "high"]);
  });
  test("Pi reporting only off hides the control", () => {
    expect(effortChoices(M({ backend: "pi" }), ["off"])).toEqual([]);
  });
});

describe("todoSummary", () => {
  const t = (status: "pending" | "in_progress" | "completed") => ({ id: Math.random().toString(), content: "x", status });
  test("counts done items and says all done only when every item is", () => {
    expect(todoSummary([t("completed"), t("pending")])).toEqual({ label: "1 of 2 done", done: false });
    expect(todoSummary([t("completed"), t("completed")])).toEqual({ label: "All 2 done", done: true });
    expect(todoSummary([t("completed")])).toEqual({ label: "All 1 done", done: true });
  });
  test("an empty list has no summary", () => {
    expect(todoSummary([])).toBeNull();
    expect(todoSummary(null)).toBeNull();
    expect(todoSummary(undefined)).toBeNull();
  });
});

describe("tokenNote", () => {
  test("shows before and after with a short unit", () => {
    expect(tokenNote({ tokensBefore: 152000, tokensAfter: 32000 })).toBe("Compacted: about 152k tokens down to 32k");
    expect(tokenNote({ tokensBefore: 900, tokensAfter: 200 })).toBe("Compacted: about 900 tokens down to 200");
  });
});

describe("sheetErrorText", () => {
  test("a busy run gets a plain instruction; other errors pass through", () => {
    expect(sheetErrorText(Object.assign(new Error("run active"), { status: 409 }))).toBe("Wait for the run to finish, then try again.");
    expect(sheetErrorText(new Error("boom"))).toBe("boom");
  });
  test("the bridge's technical prefix is dropped, and a short chat gets a plain message", () => {
    expect(sheetErrorText(new Error("pi bridge command failed (502): Nothing to compact (session too small)"))).toBe("Nothing to compact yet. This chat is still short.");
    expect(sheetErrorText(new Error("pi bridge command failed (502): Something else broke"))).toBe("Something else broke");
  });
});

describe("swapBackend: an empty chat can change agent by being replaced", () => {
  const pi = M({ id: "pi:a", backend: "pi" });
  const he = M({ id: "a" });
  test("empty chat + a model of the other backend = swap", () => {
    expect(swapBackend(pi, "hermes", { empty: true, loading: false })).toBe(true);
    expect(swapBackend(he, "pi", { empty: true, loading: false })).toBe(true);
  });
  test("same backend, a chat with messages, a loading chat, or no chat = no swap", () => {
    expect(swapBackend(pi, "pi", { empty: true, loading: false })).toBe(false);
    expect(swapBackend(pi, "hermes", { empty: false, loading: false })).toBe(false);
    expect(swapBackend(pi, "hermes", { empty: true, loading: true })).toBe(false);
    expect(swapBackend(pi, null, { empty: true, loading: false })).toBe(false);
  });
});

describe("backendLabel", () => {
  test("every chat names its agent; a session without the field is Hermes", () => {
    expect(backendLabel("pi")).toBe("Pi");
    expect(backendLabel("hermes")).toBe("Hermes");
    expect(backendLabel(undefined)).toBe("Hermes");
  });
});

describe("new chat defaults", () => {
  const m = (id: string, backend: "hermes" | "pi", online = true) =>
    ({ id, provider: "p", label: id, reasoning: false, canDisableReasoning: false, vision: false, local: false, online, backend }) as any;
  const models = [m("claude-sonnet-5-5", "hermes"), m("deepseek-flash", "hermes"), m("pi:claude-sonnet-5-5", "pi"), m("pi:deepseek-flash", "pi")];

  test("new chat: Hermes starts on its default model, Pi on the configured new-chat model", () => {
    const cfg = { defaultModel: "claude-sonnet-5-5", newChatModel: "pi:claude-sonnet-5-5" };
    expect(defaultModelFor("hermes", models, cfg)!.id).toBe("claude-sonnet-5-5");
    expect(defaultModelFor("pi", models, cfg)!.id).toBe("pi:claude-sonnet-5-5");
  });

  test("new chat: a configured model that is missing or offline falls back to the first online one", () => {
    const cfg = { defaultModel: "gone", newChatModel: "pi:nope" };
    expect(defaultModelFor("hermes", models, cfg)!.id).toBe("claude-sonnet-5-5");
    expect(defaultModelFor("pi", models, cfg)!.id).toBe("pi:claude-sonnet-5-5");
    const offline = [m("a", "hermes", false), m("b", "hermes"), m("pi:c", "pi", false)];
    expect(defaultModelFor("hermes", offline, null)!.id).toBe("b");
    expect(defaultModelFor("pi", offline, null)).toBeNull();
  });

  test("new chat: a new-chat model of the other agent is not used", () => {
    const cfg = { defaultModel: "claude-sonnet-5-5", newChatModel: "pi:deepseek-flash" };
    expect(defaultModelFor("hermes", models, cfg)!.id).toBe("claude-sonnet-5-5");
    expect(defaultModelFor("pi", models, cfg)!.id).toBe("pi:deepseek-flash");
  });

  test("newChoices lists Hermes then Pi, each with its model (null when the agent has none)", () => {
    const c = newChoices(models.filter(x => x.backend === "hermes"), { defaultModel: "deepseek-flash" });
    expect(c.map(x => [x.backend, x.label, x.model?.id ?? null])).toEqual([["hermes", "Hermes", "deepseek-flash"], ["pi", "Pi", null]]);
  });

  test("defaultBackend follows the configured new-chat model, else Hermes", () => {
    expect(defaultBackend(models, { defaultModel: "claude-sonnet-5-5", newChatModel: "pi:claude-sonnet-5-5" })).toBe("pi");
    expect(defaultBackend(models, { defaultModel: "claude-sonnet-5-5" })).toBe("hermes");
    expect(defaultBackend([], null)).toBe("hermes");
  });
});
