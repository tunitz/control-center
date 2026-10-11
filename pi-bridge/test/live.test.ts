// Live smoke against the real Pi on this host. Costs a few cents of DeepSeek flash.
// Run: PI_LIVE=1 bun test pi-bridge/test/live.test.ts
import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { createBridge } from "../src/bridge";
import { makeConfig } from "./helpers";
import { api, readEvents, settled } from "./helpers";

const envFile = join(homedir(), ".local/share/cc-pi/env");

function deepseekKeyFromEnvFile(): string | undefined {
  // Read only the one key we need; the value is never printed or logged.
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^DEEPSEEK_API_KEY=(.*)$/);
    if (m) return m[1].trim().replace(/^['"]|['"]$/g, "");
  }
  return undefined;
}

describe.skipIf(process.env.PI_LIVE !== "1")("live Pi smoke", () => {
  test("starts real pi, prompts, sees agent_settled with stopReason stop", async () => {
    const root = mkdtempSync(join(tmpdir(), "pi-bridge-live-"));
    const cfg = makeConfig(root, {
      piBin: join(homedir(), ".local/bin/pi"),
      agentDir: join(homedir(), ".local/share/cc-pi/agent"),
      sessionDir: join(root, "sessions"),
      workspaceRoot: join(root, "ws"),
      deepseekApiKey: deepseekKeyFromEnvFile(),
      commandTimeoutMs: 60_000,
    });
    const bridge = createBridge(cfg);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: bridge.fetch });
    const h = { base: `http://127.0.0.1:${server.port}`, token: cfg.token };
    try {
      const start = await api(h, "POST", "/chats/live-1/start", {
        model: { provider: "deepseek", modelId: "deepseek-flash" },
        thinking: "off",
      });
      expect(start.status).toBe(200);
      expect(start.json.state.model.id).toBe("deepseek-flash");

      const live = readEvents(h, "live-1", { until: settled, timeoutMs: 120_000 });
      const p = await api(h, "POST", "/chats/live-1/prompt", { message: "reply with the single word OK" });
      expect(p.status).toBe(200);
      const r = await live;
      expect(r.matched).toBe(true);
      const s = r.frames.find(settled)!;
      expect(s.data.stopReason).toBe("stop");
      const text = r.frames
        .filter((f) => f.event === "message_update")
        .map((f) => f.data.assistantMessageEvent?.delta ?? "")
        .join("");
      console.log("live reply:", JSON.stringify(text));
      expect(text.toUpperCase()).toContain("OK");

      expect((await api(h, "DELETE", "/chats/live-1")).status).toBe(200);
    } finally {
      await bridge.shutdown();
      server.stop(true);
    }
  }, 180_000);
});
