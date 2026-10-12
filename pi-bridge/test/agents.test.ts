import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";

let h: Harness;
beforeEach(async () => {
  h = await harness();
});
afterEach(async () => {
  await h.close();
});

const dir = () => join(h.cfg.agentDir, "agents");
const file = (name: string) => join(dir(), `${name}.md`);
const seed = (name: string, text: string) => {
  mkdirSync(dir(), { recursive: true });
  writeFileSync(file(name), text);
};
const read = (name: string) => readFileSync(file(name), "utf8");
const put = (name: string, body: unknown) => api(h, "PUT", `/agents/${name}`, body);

const CODER_MD = `---
name: coder
description: Implementation agent
model: claude-bridge/claude-haiku-5-5
thinking: medium
extensions: /home/tunitz/.pi/agent/npm/node_modules/pi-claude-bridge/src/index.ts
tools: read, bash, edit
---

You are coder.
`;

const agent = (over: Record<string, unknown> = {}) => ({
  name: "reviewer",
  description: "Reviews diffs",
  model: "claude-bridge/claude-haiku-5-5",
  thinking: "low",
  instructions: "Review the diff.",
  notes: "",
  tools: ["read", "grep"],
  skills: [],
  ...over,
});

describe("GET /agents", () => {
  test("empty when the agents dir does not exist", async () => {
    expect(await api(h, "GET", "/agents")).toMatchObject({ status: 200, json: { agents: [] } });
  });

  test("lists each agent with its mapped fields; notes come from after the marker", async () => {
    seed("coder", CODER_MD + "\n<!-- cc:notes -->\n\nPrefer small diffs.\n");
    seed("researcher", "---\nname: researcher\ndescription: Looks things up\nskills: pdf-tools, web\n---\n\nFind facts.\n");
    const r = await api(h, "GET", "/agents");
    expect(r.status).toBe(200);
    expect(r.json.agents).toEqual([
      {
        name: "coder", description: "Implementation agent", model: "claude-bridge/claude-haiku-5-5", thinking: "medium",
        instructions: "You are coder.", notes: "Prefer small diffs.", tools: ["read", "bash", "edit"], skills: [],
      },
      {
        name: "researcher", description: "Looks things up", model: "", thinking: "",
        instructions: "Find facts.", notes: "", tools: [], skills: ["pdf-tools", "web"],
      },
    ]);
  });

  test("files whose name is not a valid agent name are not listed", async () => {
    seed("coder", CODER_MD);
    writeFileSync(join(dir(), "Bad_Name.md"), CODER_MD);
    expect((await api(h, "GET", "/agents")).json.agents.map((a: any) => a.name)).toEqual(["coder"]);
  });

  test("requires the bearer token", async () => {
    expect((await api(h, "GET", "/agents", undefined, null)).status).toBe(401);
  });
});

describe("PUT /agents/:name create", () => {
  test("a new agent gets the defaults and a copy of the extensions line from coder.md", async () => {
    seed("coder", CODER_MD);
    const r = await put("reviewer", agent());
    expect(r.status).toBe(200);
    expect(r.json).toEqual(agent());
    const ext = CODER_MD.split("\n").find((l) => l.startsWith("extensions:"))!;
    expect(read("reviewer")).toBe(
      [
        "---",
        "name: reviewer",
        "description: Reviews diffs",
        "model: claude-bridge/claude-haiku-5-5",
        "thinking: low",
        "tools: read, grep",
        "systemPromptMode: replace",
        "inheritProjectContext: false",
        "inheritSkills: false",
        ext,
        "---",
        "",
        "Review the diff.",
        "",
      ].join("\n"),
    );
  });

  test("with no coder.md there is no extensions line", async () => {
    await put("reviewer", agent());
    expect(read("reviewer")).not.toContain("extensions:");
  });

  test("empty thinking and empty skills are omitted; inheritSkills stays false", async () => {
    await put("reviewer", agent({ thinking: "", skills: [] }));
    const text = read("reviewer");
    expect(text).not.toMatch(/^thinking:/m);
    expect(text).not.toMatch(/^skills:/m);
    expect(text).toContain("inheritSkills: false");
  });

  test("skills are written comma-separated, and the agent is served back the same", async () => {
    await put("reviewer", agent({ skills: ["pdf-tools", "web"] }));
    expect(read("reviewer")).toMatch(/^skills: pdf-tools, web$/m);
    expect((await api(h, "GET", "/agents")).json.agents[0].skills).toEqual(["pdf-tools", "web"]);
  });

  test("a value that needs YAML quoting is quoted and reads back intact", async () => {
    const tricky = "Reviews: diffs # carefully, it's fine";
    await put("reviewer", agent({ description: tricky }));
    const back = (await api(h, "GET", "/agents")).json.agents[0];
    expect(back.description).toBe(tricky);
  });
});

describe("PUT /agents/:name update keeps every other frontmatter key", () => {
  const SEED = [
    "---",
    "name: reviewer",
    "description: Reviews diffs",
    "aliases: review, check",
    "acceptanceRole: reviewer",
    "model: claude-bridge/claude-sonnet-5-5",
    "thinking: low",
    "systemPromptMode: replace",
    "inheritProjectContext: true",
    "inheritSkills: true",
    "extensions: /x/y.ts",
    "tools: read, grep",
    "skills: lint, pdf-tools",
    "defaultContext: fresh",
    "output: review.md",
    "---",
    "",
    "Old instructions.",
    "",
    "<!-- cc:notes -->",
    "",
    "Old notes",
    "",
  ].join("\n");

  test("untouched keys keep their order and value; managed keys change in place; empty ones are removed", async () => {
    seed("reviewer", SEED);
    const r = await put("reviewer", agent({
      description: "Reviews diffs carefully",
      model: "",
      thinking: "",
      tools: ["read", "grep", "ls"],
      skills: [],
      instructions: "New instructions.",
      notes: "",
    }));
    expect(r.status).toBe(200);
    expect(read("reviewer")).toBe(
      [
        "---",
        "name: reviewer",
        "description: Reviews diffs carefully",
        "aliases: review, check",
        "acceptanceRole: reviewer",
        "systemPromptMode: replace",
        "inheritProjectContext: true",
        "inheritSkills: false",
        "extensions: /x/y.ts",
        "tools: read, grep, ls",
        "defaultContext: fresh",
        "output: review.md",
        "---",
        "",
        "New instructions.",
        "",
      ].join("\n"),
    );
  });

  test("an update with skills set keeps inheritSkills as it was", async () => {
    seed("reviewer", SEED);
    await put("reviewer", agent({ skills: ["web"] }));
    expect(read("reviewer")).toMatch(/^inheritSkills: true$/m);
    expect(read("reviewer")).toMatch(/^skills: web$/m);
  });

  test("an update keeps a value Pi wrote with a quoted or block-scalar form for the untouched keys", async () => {
    seed("reviewer", "---\nname: reviewer\ndescription: Reviews diffs\nextensions: \"/a b/c.ts\"\nnotes: |\n  one\n  two\n---\n\nBody.\n");
    await put("reviewer", agent({ description: "Changed" }));
    expect(read("reviewer")).toContain('extensions: "/a b/c.ts"\nnotes: |\n  one\n  two\n---');
  });

  test("a body with a notes marker in the instructions is 400 and changes nothing", async () => {
    seed("reviewer", SEED);
    const before = read("reviewer");
    expect((await put("reviewer", agent({ instructions: "a <!-- cc:notes --> b" }))).status).toBe(400);
    expect(read("reviewer")).toBe(before);
  });

  test("notes round-trip through the marker", async () => {
    await put("reviewer", agent({ notes: "Keep it short.\nNo emojis." }));
    expect(read("reviewer")).toContain("<!-- cc:notes -->");
    const back = (await api(h, "GET", "/agents")).json.agents[0];
    expect(back.notes).toBe("Keep it short.\nNo emojis.");
    expect(back.instructions).toBe("Review the diff.");
  });

  test("a PUT names the agent in the path; no temp files are left behind", async () => {
    await put("reviewer", agent());
    expect(readdirSync(dir()).filter((f) => f.includes(".tmp"))).toEqual([]);
    expect((await put("reviewer", agent({ name: "other" }))).status).toBe(400);
  });
});

describe("PUT /agents/:name validation", () => {
  test("bad bodies are 400 and write nothing", async () => {
    const bad: unknown[] = [
      null,
      [],
      "x",
      agent({ name: undefined }),
      agent({ description: "" }),
      agent({ description: "two\nlines" }),
      agent({ instructions: "   " }),
      agent({ thinking: "turbo" }),
      agent({ tools: "read" }),
      agent({ tools: ["read", "read"] }),
      agent({ tools: ["Read Files"] }),
      agent({ skills: ["a,b"] }),
      agent({ extra: 1 }),
      agent({ model: 5 }),
    ];
    for (const body of bad) expect((await put("reviewer", body)).status).toBe(400);
    expect(existsSync(file("reviewer"))).toBe(false);
  });

  test("a body with invalid JSON is 400", async () => {
    const r = await fetch(`${h.base}/agents/reviewer`, { method: "PUT", headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" }, body: "{nope" });
    expect(r.status).toBe(400);
  });

  test("names must match ^[a-z][a-z0-9-]{0,39}$; path tricks are rejected", async () => {
    for (const bad of ["Coder", "1coder", "a_b", "a.b", "-x", "a%2Fb", "..%2Fevil", "x%00y"]) {
      expect((await put(bad, agent({ name: decodeURIComponent(bad) }))).status).toBe(400);
    }
    // Dot segments are normalised by the URL parser before the bridge sees them: never a write.
    const r = await put("%2e%2e%2fevil", agent({ name: "../evil" }));
    expect([400, 404]).toContain(r.status);
    expect(existsSync(join(h.cfg.agentDir, "evil.md"))).toBe(false);
    expect((await put("a".repeat(41), agent({ name: "a".repeat(41) }))).status).toBe(400);
    expect((await put("a".repeat(40), agent({ name: "a".repeat(40) }))).status).toBe(200);
  });
});

describe("DELETE /agents/:name", () => {
  test("removes the file and answers ok", async () => {
    seed("coder", CODER_MD);
    expect(await api(h, "DELETE", "/agents/coder")).toMatchObject({ status: 200, json: { ok: true } });
    expect(existsSync(file("coder"))).toBe(false);
  });

  test("an unknown name is 404", async () => {
    expect((await api(h, "DELETE", "/agents/ghost")).status).toBe(404);
  });

  test("an invalid name is 400 and nothing outside the agents dir is touched", async () => {
    writeFileSync(join(h.cfg.agentDir, "keep.md"), "x");
    expect((await api(h, "DELETE", "/agents/..%2Fkeep")).status).toBe(400);
    expect(existsSync(join(h.cfg.agentDir, "keep.md"))).toBe(true);
  });
});
