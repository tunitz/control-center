import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";

let h: Harness;
beforeAll(async () => {
  h = await harness();
});
afterAll(async () => {
  await h.close();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("chat lifecycle", () => {
  test("start returns sessionFile and state; model and thinking are applied", async () => {
    const r = await api(h, "POST", "/chats/lc-1/start", {
      model: { provider: "deepseek", modelId: "deepseek-pro" },
      thinking: "high",
    });
    expect(r.status).toBe(200);
    expect(r.json.state.model).toEqual({ provider: "deepseek", id: "deepseek-pro" });
    expect(r.json.state.thinkingLevel).toBe("high");
    expect(r.json.sessionFile).toMatch(/\.jsonl$/);
  });

  test("start never passes CC or bridge secrets to Pi (only the provider keys, PATH, HOME, agent dir)", async () => {
    const r = await api(h, "POST", "/chats/lc-env/start", {});
    const keys: string[] = r.json.state.envKeys;
    expect(keys).toContain("PATH");
    expect(keys).toContain("HOME");
    expect(keys).toContain("DEEPSEEK_API_KEY");
    expect(keys).toContain("ANTHROPIC_OAUTH_TOKEN");
    expect(keys).not.toContain("ANTHROPIC_API_KEY"); // unset in the harness, so not passed
    expect(keys).toContain("PI_CODING_AGENT_DIR");
    expect(keys.some((k) => k.startsWith("CC_"))).toBe(false);
    expect(keys).not.toContain("PI_BRIDGE_TOKEN");
  });

  test("invalid thinking level, bad chat id, and bad model shape are 400", async () => {
    expect((await api(h, "POST", "/chats/lc-bad/start", { thinking: "ludicrous" })).status).toBe(400);
    expect((await api(h, "POST", "/chats/lc-bad/start", { model: "deepseek/x" })).status).toBe(400);
    expect((await api(h, "POST", "/chats/has space/start", {})).status).toBe(400);
  });

  test("sessionPath must live under the session dir", async () => {
    const r = await api(h, "POST", "/chats/lc-path/start", { sessionPath: "/etc/passwd" });
    expect(r.status).toBe(400);
    const ok = await api(h, "POST", "/chats/lc-path/start", {
      sessionPath: join(h.cfg.sessionDir, "x.jsonl"),
    });
    expect(ok.status).toBe(200);
    expect(ok.json.sessionFile).toBe(join(h.cfg.sessionDir, "x.jsonl"));
  });

  test("start is idempotent: same process and state while live", async () => {
    const a = await api(h, "POST", "/chats/lc-idem/start", {});
    const b = await api(h, "POST", "/chats/lc-idem/start", {});
    expect(b.status).toBe(200);
    expect(b.json.state.pid).toBe(a.json.state.pid);
  });

  test("DELETE kills the Pi process and removes the chat", async () => {
    const r = await api(h, "POST", "/chats/lc-del/start", {});
    const pid: number = r.json.state.pid;
    expect(alive(pid)).toBe(true);
    const d = await api(h, "DELETE", "/chats/lc-del");
    expect(d.status).toBe(200);
    expect(alive(pid)).toBe(false);
    expect((await api(h, "POST", "/chats/lc-del/command", { name: "get_state" })).status).toBe(404);
    expect((await api(h, "DELETE", "/chats/lc-del")).status).toBe(404);
  });

  test("DELETE returns only after the process has exited (no zombie left running)", async () => {
    const r = await api(h, "POST", "/chats/lc-wait/start", {});
    const pid: number = r.json.state.pid;
    const t0 = Date.now();
    expect((await api(h, "DELETE", "/chats/lc-wait")).status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(alive(pid)).toBe(false);
  });

  test("GET /chats/:id/commands passes get_commands through", async () => {
    await api(h, "POST", "/chats/lc-cmds/start", {});
    const r = await api(h, "GET", "/chats/lc-cmds/commands");
    expect(r.status).toBe(200);
    expect(r.json.commands[0].name).toBe("cc-ping");
  });
});
