import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, harness, makeConfig, type Harness } from "./helpers";
import { createBridge } from "../src/bridge";

// Compaction is fixed, not configurable: Pi compacts at 256,000 tokens and keeps 51,200 recent
// tokens. The bridge writes this into Pi's settings.json on every start and at bridge startup.
let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const settingsPath = () => join(h.cfg.agentDir, "settings.json");
const readSettings = () => JSON.parse(readFileSync(settingsPath(), "utf8"));
const seed = (name: string, obj: unknown) => {
  mkdirSync(h.cfg.agentDir, { recursive: true });
  writeFileSync(join(h.cfg.agentDir, name), JSON.stringify(obj, null, 2));
};
const seedModels = (models: Record<string, number>) => {
  const byProvider: Record<string, { models: unknown[] }> = {};
  for (const [key, contextWindow] of Object.entries(models)) {
    const [provider, id] = key.split("/");
    (byProvider[provider] ??= { models: [] }).models.push({ id, name: id, provider, contextWindow, maxTokens: 1000 });
  }
  seed("models-store.json", byProvider);
};
const start = (id: string) => api(h, "POST", `/chats/${id}/start`, {});

// 1M: reserve = window - 256000, global keepRecentTokens applies.
// 200k and 64k: Pi's default reserve 16384; keepRecentTokens = min(51200, floor((window - 16384) / 2)).
// anthropic models are also listed under claude-bridge with the same window.
const MODELS = { "deepseek/big": 1_000_000, "anthropic/mid": 200_000, "anthropic/small": 64_000 };
const EXPECTED_OVERRIDES = {
  "deepseek/big": { reserveTokens: 744_000 },
  "anthropic/mid": { reserveTokens: 16_384, keepRecentTokens: 51_200 },
  "anthropic/small": { reserveTokens: 16_384, keepRecentTokens: 23_808 },
  "claude-bridge/mid": { reserveTokens: 16_384, keepRecentTokens: 51_200 },
  "claude-bridge/small": { reserveTokens: 16_384, keepRecentTokens: 23_808 },
};

describe("fixed compaction: the generated settings", () => {
  beforeEach(() => seedModels(MODELS));

  test("a start writes keepRecentTokens 51200 and the exact per-model reserves", async () => {
    expect((await start("c-1")).status).toBe(200);
    const c = readSettings().compaction;
    expect(c).toMatchObject({ enabled: true, keepRecentTokens: 51_200 });
    expect(c.modelOverrides).toEqual(EXPECTED_OVERRIDES);
  });

  test("cc-config content and old settings values do not change the result", async () => {
    seed("cc-config.json", { defaultTools: null, claudeBridge: false, browser: false, compaction: { compactAtTokens: 123_456 } });
    seed("settings.json", {
      steeringMode: "all",
      compaction: { enabled: false, keepRecentTokens: 9_000, modelOverrides: { "deepseek/big": { reserveTokens: 5, keepRecentTokens: 777 } } },
    });
    expect((await start("c-2")).status).toBe(200);
    const s = readSettings();
    expect(s.steeringMode).toBe("all");
    expect(s.compaction.enabled).toBe(false); // the on/off state is kept as it is
    expect(s.compaction.keepRecentTokens).toBe(51_200);
    expect(s.compaction.modelOverrides).toEqual(EXPECTED_OVERRIDES);
  });

  test("a model added later gets its values on the next start, and that restarts an idle chat", async () => {
    const a = await start("c-3");
    seedModels({ ...MODELS, "anthropic/new": 1_000_000 });
    const b = await start("c-3");
    expect(readSettings().compaction.modelOverrides["anthropic/new"]).toEqual({ reserveTokens: 744_000 });
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
  });

  test("a start with nothing changed keeps the running chat", async () => {
    const a = await start("c-4");
    const b = await start("c-4");
    expect(b.json.state.pid).toBe(a.json.state.pid);
  });

  test("the bridge writes the same block at startup, before any chat starts", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-compaction-startup-"));
    mkdirSync(join(root, "sessions"), { recursive: true });
    const cfg = makeConfig(root);
    mkdirSync(cfg.agentDir, { recursive: true });
    writeFileSync(join(cfg.agentDir, "models-store.json"), JSON.stringify({
      deepseek: { models: [{ id: "big", contextWindow: 1_000_000 }] },
      anthropic: { models: [{ id: "mid", contextWindow: 200_000 }, { id: "small", contextWindow: 64_000 }] },
    }));
    const bridge = createBridge(cfg);
    try {
      const s = JSON.parse(readFileSync(join(cfg.agentDir, "settings.json"), "utf8"));
      expect(s.compaction).toMatchObject({ enabled: true, keepRecentTokens: 51_200 });
      expect(s.compaction.modelOverrides).toEqual(EXPECTED_OVERRIDES);
    } finally {
      await bridge.shutdown();
    }
  });

  test("a corrupt settings.json is never overwritten: the start is refused", async () => {
    mkdirSync(h.cfg.agentDir, { recursive: true });
    writeFileSync(settingsPath(), "{not json");
    const r = await start("c-5");
    expect(r.status).toBe(400);
    expect(readFileSync(settingsPath(), "utf8")).toBe("{not json");
  });
});

describe("no user-facing compaction config", () => {
  test("GET /config has no compaction field", async () => {
    const r = await api(h, "GET", "/config");
    expect(r.status).toBe(200);
    expect("compaction" in r.json).toBe(false);
  });

  test("PUT /config with a compaction key is 400 and changes nothing", async () => {
    const r = await api(h, "PUT", "/config", { compaction: { compactAtTokens: 300_000 } });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("compaction");
    const mixed = await api(h, "PUT", "/config", { appendSystemPrompt: "x", compaction: { enabled: false } });
    expect(mixed.status).toBe(400);
    expect(existsSync(join(h.cfg.agentDir, "APPEND_SYSTEM.md"))).toBe(false);
  });

  test("a PUT /config leaves a hand-edited compaction block alone until the next start, which resets it", async () => {
    seed("settings.json", { compaction: { enabled: false, keepRecentTokens: 9_000 } });
    expect((await api(h, "PUT", "/config", { appendSystemPrompt: "hi" })).status).toBe(200);
    expect(readSettings().compaction.keepRecentTokens).toBe(9_000);
    await start("c-6");
    expect(readSettings().compaction.keepRecentTokens).toBe(51_200);
  });
});
