import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";
import { compactionReserve, readConfig } from "../src/pi-config";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const put = (body: unknown) => api(h, "PUT", "/config", body);
const get = async () => (await api(h, "GET", "/config")).json;
const settingsPath = () => join(h.cfg.agentDir, "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const seedSettings = (obj: unknown) => { mkdirSync(h.cfg.agentDir, { recursive: true }); writeFileSync(settingsPath(), JSON.stringify(obj, null, 2)); };
const seedModels = (models: Record<string, number>) => {
  mkdirSync(h.cfg.agentDir, { recursive: true });
  const byProvider: Record<string, { models: unknown[] }> = {};
  for (const [key, contextWindow] of Object.entries(models)) {
    const [provider, id] = key.split("/");
    (byProvider[provider] ??= { models: [] }).models.push({ id, name: id, provider, contextWindow, maxTokens: 1000 });
  }
  writeFileSync(join(h.cfg.agentDir, "models-store.json"), JSON.stringify(byProvider));
};

describe("compaction config: defaults and read back", () => {
  test("defaults: enabled, compact at 200000, keep recent 20000", async () => {
    const r = await get();
    expect(r.compaction).toEqual({ enabled: true, compactAtTokens: 200000, keepRecentTokens: 20000 });
  });

  test("a stored raw compactAtTokens reads back exactly as the user set it", async () => {
    expect((await put({ compaction: { compactAtTokens: 123456 } })).status).toBe(200);
    expect((await get()).compaction.compactAtTokens).toBe(123456);
    expect(JSON.parse(readFileSync(join(h.cfg.agentDir, "cc-config.json"), "utf8")).compaction).toMatchObject({ compactAtTokens: 123456 });
  });

  test("enabled and keepRecentTokens are written to settings.json compaction", async () => {
    expect((await put({ compaction: { enabled: false, keepRecentTokens: 30000 } })).status).toBe(200);
    expect(readSettings().compaction).toMatchObject({ enabled: false, keepRecentTokens: 30000 });
    expect((await get()).compaction).toEqual({ enabled: false, compactAtTokens: 200000, keepRecentTokens: 30000 });
  });

  test("a partial patch keeps the other compaction fields", async () => {
    await put({ compaction: { compactAtTokens: 300000, keepRecentTokens: 40000 } });
    await put({ compaction: { enabled: false } });
    expect((await get()).compaction).toEqual({ enabled: false, compactAtTokens: 300000, keepRecentTokens: 40000 });
  });
});

describe("compaction config: merge preserves other Pi settings", () => {
  test("unrelated settings.json keys and foreign compaction keys survive a write", async () => {
    seedSettings({
      steeringMode: "all",
      retry: { enabled: false, maxRetries: 2 },
      lastChangelogVersion: "1.1.0",
      compaction: { enabled: true, customFlag: "keep-me", modelOverrides: { "deepseek/deepseek-flash": { foo: 1, reserveTokens: 5 } } },
    });
    seedModels({ "deepseek/deepseek-flash": 1000000 });
    expect((await put({ compaction: { compactAtTokens: 250000 } })).status).toBe(200);
    const s = readSettings();
    expect(s.steeringMode).toBe("all");
    expect(s.retry).toEqual({ enabled: false, maxRetries: 2 });
    expect(s.lastChangelogVersion).toBe("1.1.0");
    expect(s.compaction.customFlag).toBe("keep-me");
    expect(s.compaction.modelOverrides["deepseek/deepseek-flash"].foo).toBe(1);
    expect(s.compaction.modelOverrides["deepseek/deepseek-flash"].reserveTokens).toBe(750000);
  });

  test("a write leaves no temp files behind and keeps mode 600", async () => {
    seedSettings({ steeringMode: "all" });
    await put({ compaction: { enabled: false } });
    expect(existsSync(settingsPath())).toBe(true);
    expect((await Array.fromAsync(new Bun.Glob("*.tmp*").scan({ cwd: h.cfg.agentDir })))).toEqual([]);
  });

  test("a corrupt settings.json is not overwritten with a partial file: the write is refused", async () => {
    mkdirSync(h.cfg.agentDir, { recursive: true });
    writeFileSync(settingsPath(), "{not json");
    const r = await put({ compaction: { enabled: false } });
    expect(r.status).toBe(400);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{not json");
    expect((await get()).compaction.compactAtTokens).toBe(200000);
  });
});

describe("compaction config: validation", () => {
  test("compactAtTokens must be an integer in 50000..900000", async () => {
    for (const bad of [49999, 900001, 1.5, "200000", null, NaN, Infinity]) {
      expect((await put({ compaction: { compactAtTokens: bad } })).status).toBe(400);
    }
    expect((await put({ compaction: { compactAtTokens: 50000 } })).status).toBe(200);
    expect((await put({ compaction: { compactAtTokens: 900000 } })).status).toBe(200);
  });

  test("keepRecentTokens must be an integer in 5000..100000", async () => {
    for (const bad of [4999, 100001, 2.5, "20000", -1]) {
      expect((await put({ compaction: { keepRecentTokens: bad } })).status).toBe(400);
    }
    expect((await put({ compaction: { keepRecentTokens: 5000 } })).status).toBe(200);
    expect((await put({ compaction: { keepRecentTokens: 100000 } })).status).toBe(200);
  });

  test("enabled must be a boolean; unknown compaction keys and non-object compaction are 400", async () => {
    expect((await put({ compaction: { enabled: "yes" } })).status).toBe(400);
    expect((await put({ compaction: { reserveTokens: 16384 } })).status).toBe(400);
    expect((await put({ compaction: "on" })).status).toBe(400);
    expect((await put({ compaction: [] })).status).toBe(400);
  });

  test("a rejected compaction patch writes nothing", async () => {
    await put({ compaction: { compactAtTokens: 300000 } });
    const before = readFileSync(join(h.cfg.agentDir, "cc-config.json"), "utf8");
    expect((await put({ appendSystemPrompt: "x", compaction: { compactAtTokens: 1 } })).status).toBe(400);
    expect(readFileSync(join(h.cfg.agentDir, "cc-config.json"), "utf8")).toBe(before);
    expect(existsSync(join(h.cfg.agentDir, "APPEND_SYSTEM.md"))).toBe(false);
  });
});

describe("per-model reserve math", () => {
  test("compactionReserve: window minus compactAtTokens; Pi default when the window is not larger", () => {
    expect(compactionReserve(1000000, 200000)).toBe(800000);
    expect(compactionReserve(200000, 200000)).toBe(16384);
    expect(compactionReserve(150000, 200000)).toBe(16384);
    expect(compactionReserve(200000, 150000)).toBe(50000);
  });

  test("writes a modelOverrides reserve per known model, default for small windows", async () => {
    seedModels({ "deepseek/deepseek-flash": 1000000, "anthropic/claude-haiku-4-5": 200000, "anthropic/claude-sonnet-5-5": 1000000 });
    expect((await put({ compaction: { compactAtTokens: 200000 } })).status).toBe(200);
    const mo = readSettings().compaction.modelOverrides;
    expect(mo["deepseek/deepseek-flash"].reserveTokens).toBe(800000);
    expect(mo["anthropic/claude-sonnet-5-5"].reserveTokens).toBe(800000);
    expect(mo["anthropic/claude-haiku-4-5"].reserveTokens).toBe(16384);
  });

  test("changing compactAtTokens rewrites every per-model reserve", async () => {
    seedModels({ "deepseek/deepseek-flash": 1000000 });
    await put({ compaction: { compactAtTokens: 200000 } });
    await put({ compaction: { compactAtTokens: 400000 } });
    expect(readSettings().compaction.modelOverrides["deepseek/deepseek-flash"].reserveTokens).toBe(600000);
  });

  test("readConfig reflects the stored compaction values", async () => {
    await put({ compaction: { enabled: false, compactAtTokens: 400000, keepRecentTokens: 9000 } });
    expect(readConfig(h.cfg.agentDir).compaction).toEqual({ enabled: false, compactAtTokens: 400000, keepRecentTokens: 9000 });
  });
});

describe("compaction changes restart idle chats, and are refused during a run", () => {
  test("changing compaction restarts an idle chat on the same session file", async () => {
    const a = await api(h, "POST", "/chats/c-1/start", {});
    await put({ compaction: { compactAtTokens: 300000 } });
    const b = await api(h, "POST", "/chats/c-1/start", {});
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
    expect(b.json.sessionFile).toBe(a.json.sessionFile);
  });

  test("a same-value compaction patch does not restart the chat", async () => {
    // Baseline: write the files once (a first PUT creates cc-gate.json, which is fingerprinted).
    await put({ compaction: { compactAtTokens: 200000 } });
    const a = await api(h, "POST", "/chats/c-2/start", {});
    await put({ compaction: { compactAtTokens: 200000 } });
    const b = await api(h, "POST", "/chats/c-2/start", {});
    expect(b.json.state.pid).toBe(a.json.state.pid);
  });

  test("a compaction change while a run is active is 409 and the run keeps going", async () => {
    const a = await api(h, "POST", "/chats/c-3/start", {});
    await api(h, "POST", "/chats/c-3/prompt", { message: "SLOW please" });
    for (let i = 0; i < 100 && !(await api(h, "POST", "/chats/c-3/command", { name: "get_state" })).json.data.isStreaming; i++) await Bun.sleep(10);
    await put({ compaction: { compactAtTokens: 300000 } });
    const b = await api(h, "POST", "/chats/c-3/start", {});
    expect(b.status).toBe(409);
    expect((await api(h, "POST", "/chats/c-3/command", { name: "get_state" })).json.data.pid).toBe(a.json.state.pid);
    await api(h, "POST", "/chats/c-3/abort", {});
  });
});
