import { test, expect } from "bun:test";
import { openDb } from "../db";
import { getModels, getConfig, DEFAULT_MODELS, CONTEXT_WINDOW } from "./models";
import { FakeHermes } from "./fake-hermes";

const set = (db: ReturnType<typeof openDb>, k: string, v: string) => db.query("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);

test("default curated Hermes list: Sonnet, Haiku and DeepSeek Flash; no OpenAI and no local Llama", () => {
  const byId = Object.fromEntries(DEFAULT_MODELS.map(m => [m.id, m]));
  expect(Object.keys(byId).sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "deepseek-flash"]);
  expect(byId["claude-sonnet-5-5"].provider).toBe("anthropic");
  expect(byId["claude-haiku-5-5"].provider).toBe("anthropic");
  expect(byId["deepseek-flash"].provider).toBe("deepseek");
  expect(byId["claude-sonnet-5-5"].vision).toBe(true);
  expect(byId["claude-haiku-5-5"].vision).toBe(true);
  expect(byId["deepseek-flash"].vision).toBe(false);
  for (const m of DEFAULT_MODELS) {
    expect(typeof m.label).toBe("string");
    expect(typeof m.reasoning).toBe("boolean");
    expect(typeof m.canDisableReasoning).toBe("boolean");
  }
});

test("context windows per contract", () => {
  expect(CONTEXT_WINDOW["claude-sonnet-5-5"]).toBe(200000);
  expect(CONTEXT_WINDOW["claude-haiku-5-5"]).toBe(200000);
  expect(CONTEXT_WINDOW["deepseek-flash"]).toBe(1000000);
  expect(CONTEXT_WINDOW["gpt-6-luna"]).toBeUndefined();
  expect(CONTEXT_WINDOW["local-llama"]).toBeUndefined();
});

test("getModels marks online from modelOptions: unavailable_models and unauthenticated providers go offline", async () => {
  const db = openDb(":memory:");
  const hermes = new FakeHermes({ modelOptions: { unavailable_models: ["deepseek-flash"], providers: [{ id: "anthropic", authenticated: true }] } });
  const models = await getModels(db, hermes);
  const online = Object.fromEntries(models.map(m => [m.id, m.online]));
  expect(online).toEqual({ "claude-sonnet-5-5": true, "claude-haiku-5-5": true, "deepseek-flash": false });
  expect(models[0]).toEqual({ id: "claude-sonnet-5-5", provider: "anthropic", label: expect.any(String), reasoning: true, canDisableReasoning: true, vision: true, local: false, online: true });
});

test("getModels: when modelOptions fails every model is offline", async () => {
  const db = openDb(":memory:");
  const hermes = new FakeHermes({ modelOptionsError: "boom" });
  const models = await getModels(db, hermes);
  expect(models.every(m => m.online === false)).toBe(true);
  expect(models).toHaveLength(3);
});

test("settings chat.models overrides the list; invalid JSON or bad entries fall back or are dropped", async () => {
  const db = openDb(":memory:");
  const hermes = new FakeHermes();
  set(db, "chat.models", JSON.stringify([
    { id: "m-one", provider: "anthropic", label: "One", reasoning: false, canDisableReasoning: false, vision: false, local: false },
    { provider: "x" },
    "junk",
  ]));
  expect((await getModels(db, hermes)).map(m => m.id)).toEqual(["m-one"]);
  set(db, "chat.models", "{not json");
  expect((await getModels(db, hermes)).map(m => m.id)).toEqual(DEFAULT_MODELS.map(m => m.id));
  set(db, "chat.models", "[]");
  expect((await getModels(db, hermes)).map(m => m.id)).toEqual(DEFAULT_MODELS.map(m => m.id));
});

test("getConfig: defaults and overrides", () => {
  const db = openDb(":memory:");
  expect(getConfig(db)).toEqual({ defaultModel: "claude-sonnet-5-5", newChatModel: null, defaultEffort: null, maxUploadMb: 20, contextWindow: CONTEXT_WINDOW });
  set(db, "chat.defaultModel", "deepseek-flash");
  set(db, "chat.defaultEffort", "high");
  set(db, "chat.maxUploadMb", "5");
  expect(getConfig(db)).toMatchObject({ defaultModel: "deepseek-flash", defaultEffort: "high", maxUploadMb: 5 });
  set(db, "chat.defaultEffort", "bogus");
  expect(getConfig(db).defaultEffort).toBeNull();
});

test("getConfig: newChatModel accepts a Pi key or a known Hermes model, ignores junk, and leaves defaultModel alone", () => {
  const db = openDb(":memory:");
  set(db, "chat.newChatModel", "pi:claude-sonnet-5-5");
  expect(getConfig(db)).toMatchObject({ newChatModel: "pi:claude-sonnet-5-5", defaultModel: "claude-sonnet-5-5" });
  set(db, "chat.newChatModel", "deepseek-flash");
  expect(getConfig(db).newChatModel).toBe("deepseek-flash");
  for (const bad of ["nope", "pi:", ""]) {
    set(db, "chat.newChatModel", bad);
    expect(getConfig(db).newChatModel).toBeNull();
  }
});
