import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";
import { parseFrontmatter } from "../src/skills";

let h: Harness;
beforeEach(async () => { h = await harness(); });
afterEach(async () => { await h.close(); });

function skill(dir: string, name: string, description: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
}

const argvOf = async (id: string, body: Record<string, unknown> = {}): Promise<string[]> => {
  await api(h, "POST", `/chats/${id}/start`, body);
  const r = await api(h, "POST", `/chats/${id}/command`, { name: "get_state" });
  return r.json.data.argv;
};
const skillArgs = (argv: string[]): string[] => argv.flatMap((a, i) => (a === "--skill" ? [argv[i + 1]] : []));

describe("skills", () => {
  test("parseFrontmatter reads plain, quoted and block-scalar values", () => {
    expect(parseFrontmatter(`---\nname: pdf-tools\ndescription: "Quoted: value"\n---\nbody`)).toEqual({ name: "pdf-tools", description: "Quoted: value" });
    expect(parseFrontmatter(`---\nname: x\ndescription: >\n  one line\n  two lines\n---\n`).description).toBe("one line two lines");
    expect(parseFrontmatter("no frontmatter here")).toEqual({});
  });

  test("lists global then project skills for the given folders; skips skills without a description", async () => {
    const cwd = join(h.cfg.homeDir, "projects/alpha");
    mkdirSync(cwd, { recursive: true });
    skill(join(h.cfg.agentDir, "skills/pdf-tools"), "pdf-tools", "Extract text from PDFs.");
    skill(join(h.cfg.homeDir, ".agents/skills/review"), "review", "Review a diff.");
    skill(join(cwd, ".pi/skills/release-notes"), "release-notes", "Draft release notes.");
    skill(join(cwd, ".agents/skills/lint"), "lint", "Lint the project.");
    // A skill with no description is not loaded by Pi, so it is not listed.
    mkdirSync(join(h.cfg.agentDir, "skills/empty"), { recursive: true });
    writeFileSync(join(h.cfg.agentDir, "skills/empty/SKILL.md"), "---\nname: empty\n---\n");

    const r = await api(h, "GET", `/skills?cwd=${encodeURIComponent(cwd)}`);
    expect(r.status).toBe(200);
    expect(r.json.skills.map((s: any) => [s.name, s.scope])).toEqual([
      ["pdf-tools", "global"], ["review", "global"], ["lint", "project"], ["release-notes", "project"],
    ]);
    expect(r.json.skills.every((s: any) => s.enabled)).toBe(true);
    const rn = r.json.skills.find((s: any) => s.name === "release-notes");
    expect(rn.cwd).toBe(cwd);
    expect(rn.description).toBe("Draft release notes.");
  });

  test("skills named in settings.json are discovered (user and project)", async () => {
    const cwd = join(h.cfg.homeDir, "projects/alpha");
    mkdirSync(cwd, { recursive: true });
    // User settings, path relative to the agent dir.
    skill(join(h.cfg.agentDir, "extra/by-settings"), "by-settings", "From user settings.");
    writeFileSync(join(h.cfg.agentDir, "settings.json"), JSON.stringify({ skills: ["./extra/by-settings"] }));
    // Project settings, path relative to the project .pi dir, pointing at the SKILL.md file itself.
    const projSkill = join(cwd, ".pi/skills/from-project");
    skill(projSkill, "from-project", "From project settings.");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi/settings.json"), JSON.stringify({ skills: ["skills/from-project/SKILL.md"] }));

    const r = await api(h, "GET", `/skills?cwd=${encodeURIComponent(cwd)}`);
    const byName = new Map(r.json.skills.map((s: any) => [s.name, s]));
    expect(byName.get("by-settings")).toMatchObject({ scope: "global", enabled: true });
    expect(byName.get("from-project")).toMatchObject({ scope: "project" });
  });

  test("a disabled skill is reported off and left out of the launch flags", async () => {
    const cwd = join(h.cfg.homeDir, "projects/alpha");
    mkdirSync(cwd, { recursive: true });
    skill(join(h.cfg.agentDir, "skills/pdf-tools"), "pdf-tools", "Extract text from PDFs.");
    skill(join(cwd, ".pi/skills/release-notes"), "release-notes", "Draft release notes.");
    const before = await api(h, "GET", `/skills?cwd=${encodeURIComponent(cwd)}`);
    const rn = before.json.skills.find((s: any) => s.name === "release-notes");

    const put = await api(h, "PUT", `/skills?cwd=${encodeURIComponent(cwd)}`, { disabled: [rn.path] });
    expect(put.status).toBe(200);
    expect(put.json.skills.find((s: any) => s.name === "release-notes").enabled).toBe(false);
    expect(existsSync(join(h.cfg.agentDir, "cc-skills.json"))).toBe(true);

    const argv = await argvOf("sk-disabled", { cwd });
    expect(argv).toContain("--no-skills");
    const enabled = skillArgs(argv);
    expect(enabled).toContain(join(h.cfg.agentDir, "skills/pdf-tools"));
    expect(enabled).not.toContain(join(cwd, ".pi/skills/release-notes"));
  });

  test("with nothing disabled Pi keeps its own discovery (no --no-skills)", async () => {
    const argv = await argvOf("sk-clean", {});
    expect(argv).not.toContain("--no-skills");
    expect(skillArgs(argv)).toEqual([]);
  });

  test("disabled must be a list of absolute paths", async () => {
    for (const bad of ["x", [1], ["relative/path"], ["/a/../b"]]) {
      expect((await api(h, "PUT", "/skills", { disabled: bad })).status).toBe(400);
    }
    expect((await api(h, "PUT", "/skills", {})).status).toBe(400);
  });
});
