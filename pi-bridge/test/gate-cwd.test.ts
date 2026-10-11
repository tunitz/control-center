import { describe, expect, test } from "bun:test";
import { DEFAULT_POLICY, evaluate } from "../extensions/cc-gate";

// A chat started in a user-chosen directory uses that directory as ctx.cwd, which is the gate's
// workspace. The gate itself is unchanged; these tests pin the behaviour the picker relies on.
const HOME = "/home/u";
const CHOSEN = `${HOME}/projects/alpha`;
const P = { ...DEFAULT_POLICY, home: HOME };
const at = (cwd: string, tool: string, input: Record<string, unknown>) => evaluate(tool, input, cwd, P);

describe("cc-gate with a chosen (non-workspace) cwd", () => {
  test("a write inside the chosen directory runs without asking", () => {
    expect(at(CHOSEN, "write", { path: `${CHOSEN}/src/a.ts`, content: "x" }).confirm).toBe(false);
    expect(at(CHOSEN, "edit", { path: "src/a.ts" }).confirm).toBe(false);
  });

  test("a write outside the chosen directory asks", () => {
    expect(at(CHOSEN, "write", { path: `${HOME}/projects/beta/a.ts`, content: "x" }).confirm).toBe(true);
    expect(at(CHOSEN, "edit", { path: `${HOME}/notes.txt` }).confirm).toBe(true);
  });

  test("with HOME as the cwd, protected paths still ask", () => {
    expect(at(HOME, "write", { path: `${HOME}/.hermes/config.yaml`, content: "x" }).confirm).toBe(true);
    expect(at(HOME, "edit", { path: `${HOME}/projects/control-center/data/app.db` }).confirm).toBe(true);
    expect(at(HOME, "read", { path: `${HOME}/.ssh/id_ed25519` }).confirm).toBe(true);
    expect(at(HOME, "bash", { command: "cat ~/.local/share/cc-pi/env" }).confirm).toBe(true);
  });

  test("with the control-center repo as the cwd, its data/ still asks and its src/ runs", () => {
    const REPO = `${HOME}/projects/control-center`;
    expect(at(REPO, "write", { path: `${REPO}/data/x`, content: "x" }).confirm).toBe(true);
    expect(at(REPO, "write", { path: `${REPO}/src/x`, content: "x" }).confirm).toBe(false);
  });

  test("with HOME as the cwd, ordinary writes under HOME run", () => {
    expect(at(HOME, "write", { path: `${HOME}/projects/alpha/a.ts`, content: "x" }).confirm).toBe(false);
  });
});
