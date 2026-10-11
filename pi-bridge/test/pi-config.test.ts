import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

const argvOf = async (id: string): Promise<string[]> => (await api(h, "POST", `/chats/${id}/command`, { name: "get_state" })).json.data.argv;
const toolsArg = (argv: string[]) => { const i = argv.indexOf("--tools"); return i >= 0 ? argv[i + 1] : undefined; };
const put = (body: unknown) => api(h, "PUT", "/config", body);

describe("GET/PUT /config", () => {
  test("defaults: empty prompt and notes, no tool override, no extra gate rules, known tools listed", async () => {
    const r = await api(h, "GET", "/config");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      appendSystemPrompt: "", agentsMd: "", defaultTools: null,
      gate: { extraProtectedPaths: [], extraRisky: [] },
    });
    expect(r.json.knownTools).toContain("bash");
    expect(r.json.knownTools).toContain("todo_write");
  });

  test("a partial update writes the Pi files and leaves the other fields alone", async () => {
    await put({ appendSystemPrompt: "Reply in Taglish." });
    await put({ agentsMd: "Use bun." });
    const r = await api(h, "GET", "/config");
    expect(r.json.appendSystemPrompt).toBe("Reply in Taglish.");
    expect(r.json.agentsMd).toBe("Use bun.");
    expect(readFileSync(join(h.cfg.agentDir, "APPEND_SYSTEM.md"), "utf8")).toBe("Reply in Taglish.");
    expect(readFileSync(join(h.cfg.agentDir, "AGENTS.md"), "utf8")).toBe("Use bun.");
  });

  test("an empty string removes the file", async () => {
    await put({ appendSystemPrompt: "x" });
    await put({ appendSystemPrompt: "" });
    expect(existsSync(join(h.cfg.agentDir, "APPEND_SYSTEM.md"))).toBe(false);
  });

  test("files are private (mode 600) and no temp files are left behind", async () => {
    await put({ appendSystemPrompt: "x", agentsMd: "y", defaultTools: ["read"], gate: { extraRisky: ["git push"] } });
    for (const f of ["APPEND_SYSTEM.md", "AGENTS.md", "cc-config.json", "cc-gate.json"]) {
      expect((statSync(join(h.cfg.agentDir, f)).mode & 0o777).toString(8)).toBe("600");
    }
    const left = (await Array.fromAsync(new Bun.Glob("*.tmp*").scan({ cwd: h.cfg.agentDir })));
    expect(left).toEqual([]);
  });

  test("defaultTools: known names only, no duplicates, not empty; null clears", async () => {
    expect((await put({ defaultTools: ["read", "bash"] })).status).toBe(200);
    expect((await api(h, "GET", "/config")).json.defaultTools).toEqual(["read", "bash"]);
    for (const bad of [["rm"], [], ["read", "read"], "read", [1]]) expect((await put({ defaultTools: bad })).status).toBe(400);
    expect((await put({ defaultTools: null })).status).toBe(200);
    expect((await api(h, "GET", "/config")).json.defaultTools).toBeNull();
  });

  test("gate: extra rules only; extraRisky must compile; paths cannot climb out or be absolute", async () => {
    expect((await put({ gate: { extraProtectedPaths: ["projects/secret"], extraRisky: ["git\\s+push"] } })).status).toBe(200);
    const g = (await api(h, "GET", "/config")).json.gate;
    expect(g).toEqual({ extraProtectedPaths: ["projects/secret"], extraRisky: ["git\\s+push"] });
    for (const bad of [
      { extraRisky: ["("] }, { extraProtectedPaths: ["../x"] }, { extraProtectedPaths: ["/etc"] }, { extraProtectedPaths: [""] },
      { bashAllow: [".*"] }, { protectedPaths: [] }, { extraRisky: "x" },
    ]) expect((await put({ gate: bad })).status).toBe(400);
    expect((await api(h, "GET", "/config")).json.gate).toEqual(g);
  });

  test("unknown top-level keys, oversize text and non-strings are 400 and write nothing", async () => {
    for (const bad of [{ shell: "x" }, { appendSystemPrompt: 5 }, { agentsMd: "x".repeat(40_000) }, { appendSystemPrompt: "x".repeat(40_000) }, {}, [] ]) {
      expect((await put(bad)).status).toBe(400);
    }
    expect(existsSync(join(h.cfg.agentDir, "APPEND_SYSTEM.md"))).toBe(false);
  });

  test("a corrupt cc-config.json reads as no override instead of breaking the bridge", async () => {
    await put({ appendSystemPrompt: "x" });
    writeFileSync(join(h.cfg.agentDir, "cc-config.json"), "{not json");
    const r = await api(h, "GET", "/config");
    expect(r.status).toBe(200);
    expect(r.json.defaultTools).toBeNull();
  });

  test("auth is required", async () => {
    expect((await api(h, "GET", "/config", undefined, null)).status).toBe(401);
    expect((await api(h, "PUT", "/config", { agentsMd: "x" }, null)).status).toBe(401);
  });
});

describe("tools at launch", () => {
  test("no tools setting: Pi is started without --tools", async () => {
    await api(h, "POST", "/chats/t-1/start", {});
    expect(toolsArg(await argvOf("t-1"))).toBeUndefined();
  });

  test("a per-chat tools setting becomes --tools", async () => {
    await api(h, "POST", "/chats/t-2/start", { settings: { tools: ["read", "grep"] } });
    expect(toolsArg(await argvOf("t-2"))).toBe("read,grep");
  });

  test("the global default applies when the chat has none; the chat overrides it", async () => {
    await put({ defaultTools: ["read", "ls"] });
    await api(h, "POST", "/chats/t-3/start", {});
    expect(toolsArg(await argvOf("t-3"))).toBe("read,ls");
    await api(h, "POST", "/chats/t-4/start", { settings: { tools: ["bash"] } });
    expect(toolsArg(await argvOf("t-4"))).toBe("bash");
  });

  test("bad tool lists in settings are 400 and start nothing", async () => {
    for (const tools of [["nope"], [], "read", ["read", "read"]]) {
      expect((await api(h, "POST", "/chats/t-bad/start", { settings: { tools } })).status).toBe(400);
    }
    expect((await api(h, "POST", "/chats/t-bad/command", { name: "get_state" })).status).toBe(404);
  });
});

describe("restart when launch inputs change", () => {
  test("same inputs: the same process keeps running", async () => {
    const a = await api(h, "POST", "/chats/r-1/start", { settings: { tools: ["read"] } });
    const b = await api(h, "POST", "/chats/r-1/start", { settings: { tools: ["read"] } });
    expect(b.json.state.pid).toBe(a.json.state.pid);
  });

  test("changed tools: an idle chat restarts on the same session file with the new tools", async () => {
    const a = await api(h, "POST", "/chats/r-2/start", { settings: { tools: ["read"] } });
    const b = await api(h, "POST", "/chats/r-2/start", { settings: { tools: ["read", "bash"] } });
    expect(b.status).toBe(200);
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
    expect(b.json.sessionFile).toBe(a.json.sessionFile);
    expect(toolsArg(await argvOf("r-2"))).toBe("read,bash");
  });

  test("changed global files: an idle chat restarts, so the new system prompt is picked up", async () => {
    const a = await api(h, "POST", "/chats/r-3/start", {});
    await put({ appendSystemPrompt: "new rule" });
    const b = await api(h, "POST", "/chats/r-3/start", {});
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
    expect(b.json.sessionFile).toBe(a.json.sessionFile);
  });

  test("a change while a run is active is 409 and the run keeps going", async () => {
    const a = await api(h, "POST", "/chats/r-4/start", {});
    await api(h, "POST", "/chats/r-4/prompt", { message: "SLOW please" });
    for (let i = 0; i < 100 && !(await api(h, "POST", "/chats/r-4/command", { name: "get_state" })).json.data.isStreaming; i++) await Bun.sleep(10);
    const b = await api(h, "POST", "/chats/r-4/start", { settings: { tools: ["read"] } });
    expect(b.status).toBe(409);
    const st = (await api(h, "POST", "/chats/r-4/command", { name: "get_state" })).json.data;
    expect(st.pid).toBe(a.json.state.pid);
    await api(h, "POST", "/chats/r-4/abort", {});
  });

  test("restart keeps the model and live settings that the same call asks for", async () => {
    await api(h, "POST", "/chats/r-5/start", { settings: { tools: ["read"] } });
    const b = await api(h, "POST", "/chats/r-5/start", {
      model: { provider: "deepseek", modelId: "deepseek-pro" }, thinking: "high",
      settings: { tools: ["read", "ls"], autoRetry: false },
    });
    expect(b.json.state.model.id).toBe("deepseek-pro");
    expect(b.json.state.thinkingLevel).toBe("high");
    expect(b.json.state.autoRetryEnabled).toBe(false);
  });
});

describe("a start that does not name the tools keeps the running tools", () => {
  test("start without settings after start with tools: same process, same --tools", async () => {
    const a = await api(h, "POST", "/chats/k-1/start", { settings: { tools: ["read", "ls"] } });
    const b = await api(h, "POST", "/chats/k-1/start", { model: { provider: "deepseek", modelId: "deepseek-pro" } });
    expect(b.json.state.pid).toBe(a.json.state.pid);
    expect(toolsArg(await argvOf("k-1"))).toBe("read,ls");
  });

  test("settings without a tools key also keep them", async () => {
    const a = await api(h, "POST", "/chats/k-2/start", { settings: { tools: ["read"] } });
    const b = await api(h, "POST", "/chats/k-2/start", { settings: { autoRetry: false } });
    expect(b.json.state.pid).toBe(a.json.state.pid);
    expect(toolsArg(await argvOf("k-2"))).toBe("read");
  });

  test("tools: null goes back to the global default and restarts", async () => {
    await put({ defaultTools: ["ls", "find"] });
    const a = await api(h, "POST", "/chats/k-3/start", { settings: { tools: ["read"] } });
    const b = await api(h, "POST", "/chats/k-3/start", { settings: { tools: null } });
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
    expect(toolsArg(await argvOf("k-3"))).toBe("ls,find");
  });

  test("a global file change restarts the chat but keeps the chat's own tools", async () => {
    const a = await api(h, "POST", "/chats/k-4/start", { settings: { tools: ["read", "grep"] } });
    await put({ appendSystemPrompt: "new rule" });
    const b = await api(h, "POST", "/chats/k-4/start", {});
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
    expect(toolsArg(await argvOf("k-4"))).toBe("read,grep");
  });

  test("a reaped chat that is started again without settings gets the global default", async () => {
    await put({ defaultTools: ["ls"] });
    await api(h, "POST", "/chats/k-5/start", {});
    expect(toolsArg(await argvOf("k-5"))).toBe("ls");
  });

  test("tools: null is accepted by the settings parser; other non-list values are not", async () => {
    expect((await api(h, "POST", "/chats/k-6/start", { settings: { tools: null } })).status).toBe(200);
    expect((await api(h, "POST", "/chats/k-7/start", { settings: { tools: "read" } })).status).toBe(400);
  });
});

describe("Claude Code bridge", () => {
  const envKeysOf = async (id: string): Promise<string[]> => (await api(h, "POST", `/chats/${id}/command`, { name: "get_state" })).json.data.envKeys;
  const extArg = (argv: string[]) => { const i = argv.indexOf("-e"); return i >= 0 ? argv[i + 1] : undefined; };
  const installExtension = () => writeFileSync(h.cfg.claudeBridgeExtension, "export default () => {}\n");

  test("defaults off, writes the flag, rejects a non-boolean, and reports the extension", async () => {
    expect((await api(h, "GET", "/config")).json.claudeBridge).toBe(false);
    expect((await api(h, "GET", "/config")).json.claudeCode).toMatchObject({ extension: false });
    expect((await put({ claudeBridge: true })).status).toBe(200);
    expect((await api(h, "GET", "/config")).json.claudeBridge).toBe(true);
    expect(JSON.parse(readFileSync(join(h.cfg.agentDir, "cc-config.json"), "utf8")).claudeBridge).toBe(true);
    expect((await put({ claudeBridge: "yes" })).status).toBe(400);
    expect((await api(h, "GET", "/config")).json.claudeBridge).toBe(true);
  });

  test("enabled with the extension present: -e is loaded and ANTHROPIC_* stays out of Pi's env", async () => {
    installExtension();
    expect((await api(h, "GET", "/config")).json.claudeCode.extension).toBe(true);
    await put({ claudeBridge: true });
    await api(h, "POST", "/chats/cb-1/start", {});
    expect(extArg(await argvOf("cb-1"))).toBe(h.cfg.claudeBridgeExtension);
    const env = await envKeysOf("cb-1");
    expect(env).not.toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(env).not.toContain("ANTHROPIC_API_KEY");
    expect(env).toContain("DEEPSEEK_API_KEY");
  });

  test("disabled: no -e and ANTHROPIC_OAUTH_TOKEN still reaches Pi", async () => {
    await api(h, "POST", "/chats/cb-2/start", {});
    expect(extArg(await argvOf("cb-2"))).toBeUndefined();
    expect(await envKeysOf("cb-2")).toContain("ANTHROPIC_OAUTH_TOKEN");
  });

  test("toggling restarts an idle chat with the new flags", async () => {
    installExtension();
    const a = await api(h, "POST", "/chats/cb-3/start", {});
    await put({ claudeBridge: true });
    const b = await api(h, "POST", "/chats/cb-3/start", {});
    expect(b.json.state.pid).not.toBe(a.json.state.pid);
    expect(b.json.sessionFile).toBe(a.json.sessionFile);
    expect(extArg(await argvOf("cb-3"))).toBe(h.cfg.claudeBridgeExtension);
    expect(await envKeysOf("cb-3")).not.toContain("ANTHROPIC_OAUTH_TOKEN");
  });

  test("enabled but the extension is missing: no -e, and the Anthropic env is left alone", async () => {
    await put({ claudeBridge: true });
    await api(h, "POST", "/chats/cb-4/start", {});
    expect(extArg(await argvOf("cb-4"))).toBeUndefined();
    expect(await envKeysOf("cb-4")).toContain("ANTHROPIC_OAUTH_TOKEN");
  });

  test("browser: defaults off, writes the flag, loads the extension with -e when present", async () => {
    expect((await api(h, "GET", "/config")).json.browser).toBe(false);
    expect((await api(h, "GET", "/config")).json.browserStatus).toMatchObject({ extension: false });
    writeFileSync(h.cfg.browserExtension, "export default () => {}\n");
    expect((await api(h, "GET", "/config")).json.browserStatus.extension).toBe(true);
    expect((await put({ browser: true })).status).toBe(200);
    await api(h, "POST", "/chats/br-1/start", {});
    expect((await argvOf("br-1")).filter((a) => a === "-e").length).toBe(1);
    expect(await argvOf("br-1")).toContain(h.cfg.browserExtension);
    expect((await put({ browser: "yes" })).status).toBe(400);
  });
});
