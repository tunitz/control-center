import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, BASE_TOOLS, BROWSER_TOOLS, FAKE_PROBE_PI, harness, makeConfig, TOKEN, testProbe, type Harness } from "./helpers";
import { createBridge } from "../src/bridge";
import { FALLBACK_TOOL_NAMES, TOOLS_CACHE_FILE, type ProbeLaunch, type ToolInfo } from "../src/tools";

let h: Harness;
beforeEach(async () => {
  h = await harness();
  // The browser toggle only takes effect when the extension file exists.
  writeFileSync(h.cfg.browserExtension, "export default function () {}\n");
});
afterEach(async () => {
  await h.close();
});

const names = (tools: ToolInfo[]) => tools.map((t) => t.name);
const put = (body: unknown) => api(h, "PUT", "/config", body);
const toolNames = async () => names((await api(h, "GET", "/tools")).json.tools);
const auth = { authorization: `Bearer ${TOKEN}` };

/** A second bridge over the same agent dir, with its own probe (simulates a bridge restart). */
function second(probe: (l: ProbeLaunch) => Promise<ToolInfo[]>, over: Parameters<typeof makeConfig>[1] = {}) {
  return createBridge(makeConfig(h.root, over), { probeTools: probe });
}
const rawGet = (b: { fetch(r: Request): Promise<Response> }, path: string) =>
  b.fetch(new Request(`http://x${path}`, { headers: auth }));

describe("GET /tools", () => {
  test("lists the built-in and extension tools, each with a name and a description", async () => {
    const r = await api(h, "GET", "/tools");
    expect(r.status).toBe(200);
    expect(r.json.tools).toEqual(BASE_TOOLS);
    expect(names(r.json.tools)).toContain("subagent");
  });

  test("browser tools appear only while the browser toggle is on", async () => {
    expect(await toolNames()).not.toContain("browser_navigate");
    expect((await put({ browser: true })).status).toBe(200);
    expect(await toolNames()).toEqual(names([...BASE_TOOLS, ...BROWSER_TOOLS]));
    expect((await put({ browser: false })).status).toBe(200);
    expect(await toolNames()).not.toContain("browser_navigate");
  });

  test("requires the bearer token", async () => {
    expect((await api(h, "GET", "/tools", undefined, null)).status).toBe(401);
  });

  test("repeated reads do not probe Pi again", async () => {
    let calls = 0;
    const b = createBridge(makeConfig(h.root), {
      probeTools: async (l) => {
        calls++;
        return testProbe(l);
      },
    });
    try {
      for (let i = 0; i < 3; i++) expect((await rawGet(b, "/tools")).status).toBe(200);
      expect(calls).toBe(1);
    } finally {
      await b.shutdown();
    }
  });

  test("a new bridge process reuses the on-disk cache and does not probe at once", async () => {
    await api(h, "GET", "/tools"); // writes the cache file
    expect(existsSync(join(h.cfg.agentDir, TOOLS_CACHE_FILE))).toBe(true);
    let calls = 0;
    const b = second(async (l) => {
      calls++;
      return testProbe(l);
    });
    try {
      expect(names((await (await rawGet(b, "/tools")).json()).tools)).toEqual(names(BASE_TOOLS));
      expect(calls).toBe(0);
    } finally {
      await b.shutdown();
    }
  });

  test("with no list yet and a failing probe, serves the old eight names", async () => {
    const b = createBridge(makeConfig(h.root, { agentDir: join(h.root, "agent-empty") }), {
      probeTools: async () => {
        throw new Error("pi is missing");
      },
    });
    try {
      const r = await rawGet(b, "/tools");
      expect(r.status).toBe(200);
      expect(names((await r.json()).tools)).toEqual([...FALLBACK_TOOL_NAMES]);
    } finally {
      await b.shutdown();
    }
  });

  test("a failing probe after a good list serves the last good list (stale while revalidating)", async () => {
    expect(await toolNames()).toEqual(names(BASE_TOOLS));
    // Browser toggled on, so the launch key changed and a refresh is due; that refresh fails.
    mkdirSync(h.cfg.agentDir, { recursive: true });
    writeFileSync(join(h.cfg.agentDir, "cc-config.json"), JSON.stringify({ browser: true }));
    const b = second(async () => {
      throw new Error("boom");
    });
    try {
      const r = await rawGet(b, "/tools");
      expect(r.status).toBe(200);
      expect(names((await r.json()).tools)).toEqual(names(BASE_TOOLS));
    } finally {
      await b.shutdown();
    }
  });

  test("turning the browser toggle on is visible in the very next GET /tools", async () => {
    expect(await toolNames()).not.toContain("browser_navigate");
    await put({ browser: true });
    expect(await toolNames()).toContain("browser_navigate");
  });
});

describe("knownTools in GET /config comes from discovery", () => {
  test("lists the discovered names, extension tools included", async () => {
    const r = await api(h, "GET", "/config");
    expect(r.json.knownTools).toEqual(names(BASE_TOOLS));
    expect(r.json.knownTools).toContain("subagent");
  });

  test("falls back to the eight old names when discovery fails", async () => {
    const b = createBridge(makeConfig(h.root, { agentDir: join(h.root, "agent-x") }), {
      probeTools: async () => {
        throw new Error("no pi");
      },
    });
    try {
      expect((await (await rawGet(b, "/config")).json()).knownTools).toEqual([...FALLBACK_TOOL_NAMES]);
    } finally {
      await b.shutdown();
    }
  });
});

describe("tool-name validation uses the discovered list", () => {
  test("defaultTools accepts any discovered name, extension tools included", async () => {
    expect((await put({ defaultTools: ["read", "subagent"] })).status).toBe(200);
    expect((await api(h, "GET", "/config")).json.defaultTools).toEqual(["read", "subagent"]);
  });

  test("a name not in the discovered list is rejected while the list is known", async () => {
    expect((await put({ defaultTools: ["rm"] })).status).toBe(400);
    expect((await put({ defaultTools: ["browser_navigate"] })).status).toBe(400); // toggle is off
  });

  test("when the list is unavailable, any name matching the tool-name pattern is accepted", async () => {
    const b = createBridge(makeConfig(h.root, { agentDir: join(h.root, "agent-y") }), {
      probeTools: async () => {
        throw new Error("no pi");
      },
    });
    const putRaw = (body: unknown) =>
      b.fetch(new Request("http://x/config", {
        method: "PUT",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      }));
    try {
      expect((await putRaw({ defaultTools: ["brand_new_tool"] })).status).toBe(200);
      expect((await putRaw({ defaultTools: ["Bad Name!"] })).status).toBe(400);
      expect((await putRaw({ defaultTools: ["../etc"] })).status).toBe(400);
    } finally {
      await b.shutdown();
    }
  });

  test("per-chat tools are validated against the same list", async () => {
    expect((await api(h, "POST", "/chats/tv-1/start", { settings: { tools: ["read", "subagent"] } })).status).toBe(200);
    expect((await api(h, "POST", "/chats/tv-2/start", { settings: { tools: ["nope"] } })).status).toBe(400);
  });
});

describe("the default probe (real process, fake Pi)", () => {
  test("launches Pi like a chat (agent dir, -e flags) plus the probe extension, and reads its list", async () => {
    const cfg = makeConfig(h.root, { piBin: FAKE_PROBE_PI });
    writeFileSync(cfg.probeExtension, "export default function () {}\n");
    mkdirSync(cfg.agentDir, { recursive: true });
    writeFileSync(join(cfg.agentDir, "cc-config.json"), JSON.stringify({ browser: true }));
    const b = createBridge(cfg); // no probeTools override: the real probe runs
    try {
      const r = await rawGet(b, "/tools");
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({
        tools: [
          { name: "read", description: "Read a file." },
          { name: "subagent", description: "Delegate to a subagent." },
          { name: "web_search", description: "Search the web." },
        ],
      });
      const probeDir = join(cfg.workspaceRoot, ".probe");
      const argvFile = readdirSync(probeDir).find((f) => f.endsWith(".json.argv"));
      expect(argvFile).toBeDefined();
      const seen = JSON.parse(readFileSync(join(probeDir, argvFile!), "utf8"));
      expect(seen.agentDir).toBe(cfg.agentDir);
      expect(seen.argv).toEqual(expect.arrayContaining(["--mode", "rpc", "-e", cfg.probeExtension, cfg.browserExtension]));
      expect(seen.argv.indexOf(cfg.probeExtension)).toBeLessThan(seen.argv.indexOf(cfg.browserExtension));
      // The probe's temp output is removed once read.
      expect(readdirSync(probeDir).filter((f) => f.endsWith(".json")).length).toBe(0);
    } finally {
      await b.shutdown();
    }
  });
});
