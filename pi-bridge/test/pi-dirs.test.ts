import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { api, harness, type Harness } from "./helpers";
import { DEFAULT_POLICY } from "../extensions/cc-gate";
import { PROTECTED_REL } from "../src/pi-dirs";

let h: Harness;
let home: string; // real path of the fake HOME
beforeAll(async () => {
  h = await harness();
  mkdirSync(h.cfg.homeDir, { recursive: true });
  home = realpathSync(h.cfg.homeDir);
  mkdirSync(join(home, "projects", "alpha"), { recursive: true });
  mkdirSync(join(home, "Beta"));
  mkdirSync(join(home, "gamma"));
  mkdirSync(join(home, ".hidden"));
  mkdirSync(join(home, "projects", "control-center", "data"), { recursive: true });
  mkdirSync(join(home, ".hermes"));
  mkdirSync(join(home, ".ssh"));
  mkdirSync(join(home, ".local", "share", "cc-pi", "agent"), { recursive: true });
  writeFileSync(join(home, "notes.txt"), "x");
  symlinkSync("/etc", join(home, "escape-link"));
});
afterAll(async () => {
  await h.close();
});

describe("GET /dirs", () => {
  test("defaults to HOME; lists only non-hidden subdirectories, sorted case-insensitively", async () => {
    const r = await api(h, "GET", "/dirs");
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(home);
    expect(r.json.parent).toBeNull();
    expect(r.json.entries.map((e: { name: string }) => e.name)).toEqual(["Beta", "gamma", "projects"]);
    expect(r.json.entries[0]).toEqual({ name: "Beta", path: join(home, "Beta") });
  });

  test("never lists dot-directories, files, or symlinks that leave HOME", async () => {
    const r = await api(h, "GET", "/dirs");
    const names = r.json.entries.map((e: { name: string }) => e.name);
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain(".hermes");
    expect(names).not.toContain("notes.txt");
    expect(names).not.toContain("escape-link");
  });

  test("a subdirectory returns its parent and omits protected children", async () => {
    const r = await api(h, "GET", `/dirs?path=${encodeURIComponent(join(home, "projects"))}`);
    expect(r.status).toBe(200);
    expect(r.json.path).toBe(join(home, "projects"));
    expect(r.json.parent).toBe(home);
    expect(r.json.entries).toEqual([
      { name: "alpha", path: join(home, "projects", "alpha") },
      { name: "control-center", path: join(home, "projects", "control-center") },
    ]);
    const cc = await api(h, "GET", `/dirs?path=${encodeURIComponent(join(home, "projects", "control-center"))}`);
    expect(cc.json.entries).toEqual([]);
  });

  test("400 for a relative path, a missing path, a file, a path outside HOME, or a symlink out of HOME", async () => {
    const bad = [
      "projects",
      join(home, "nope"),
      join(home, "notes.txt"),
      "/etc",
      join(home, "escape-link"),
    ];
    for (const p of bad) {
      const r = await api(h, "GET", `/dirs?path=${encodeURIComponent(p)}`);
      expect(r.status).toBe(400);
      expect(typeof r.json.error).toBe("string");
    }
  });

  test("400 for a protected directory and anything under it", async () => {
    for (const rel of [".hermes", ".ssh", ".local/share/cc-pi", ".local/share/cc-pi/agent", "projects/control-center/data"]) {
      const r = await api(h, "GET", `/dirs?path=${encodeURIComponent(join(home, rel))}`);
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/protected/);
    }
  });

  test("needs the bearer token", async () => {
    expect((await api(h, "GET", "/dirs", undefined, null)).status).toBe(401);
  });
});

describe("POST /dirs", () => {
  test("creates one non-recursive subdirectory and returns 201 {path,name}", async () => {
    const r = await api(h, "POST", "/dirs", { parent: home, name: "made-here" });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ path: join(home, "made-here"), name: "made-here" });
    const again = await api(h, "POST", "/dirs", { parent: home, name: "made-here" });
    expect(again.status).toBe(409);
    expect(typeof again.json.error).toBe("string");
  });

  test("non-recursive: a missing intermediate parent is not created", async () => {
    const r = await api(h, "POST", "/dirs", { parent: join(home, "no-such-parent"), name: "x" });
    expect(r.status).toBe(400);
  });

  test("rejects bad names with 400", async () => {
    const bad = ["", "a/b", ".dot", "..", "x\0y", "a".repeat(65)];
    for (const name of bad) {
      expect((await api(h, "POST", "/dirs", { parent: home, name })).status).toBe(400);
    }
    expect((await api(h, "POST", "/dirs", { parent: home, name: "a".repeat(64) })).status).toBe(201);
  });

  test("validates the parent like GET /dirs", async () => {
    expect((await api(h, "POST", "/dirs", { parent: "relative", name: "x" })).status).toBe(400);
    expect((await api(h, "POST", "/dirs", { parent: "/etc", name: "x" })).status).toBe(400);
    expect((await api(h, "POST", "/dirs", { parent: join(home, ".ssh"), name: "x" })).status).toBe(400);
    expect((await api(h, "POST", "/dirs", { name: "x" })).status).toBe(400);
  });

  test("refuses to create a protected directory", async () => {
    const r = await api(h, "POST", "/dirs", { parent: join(home, "projects", "control-center"), name: "data" });
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/protected/);
  });
});

describe("POST /start with cwd", () => {
  test("spawns Pi in the chosen directory and echoes cwd", async () => {
    const dir = join(home, "projects", "alpha");
    const r = await api(h, "POST", "/chats/cwd-1/start", { cwd: dir });
    expect(r.status).toBe(200);
    expect(r.json.cwd).toBe(dir);
    // fake-pi reports its process.cwd() in get_state: this proves the spawn directory.
    expect(r.json.state.cwd).toBe(dir);
  });

  test("absent cwd keeps workspace/<chatId> and echoes null", async () => {
    const r = await api(h, "POST", "/chats/cwd-default/start", {});
    expect(r.status).toBe(200);
    expect(r.json.cwd).toBeNull();
    expect(r.json.state.cwd).toBe(realpathSync(join(h.cfg.workspaceRoot, "cwd-default")));
  });

  test("invalid cwd is 400 and no chat is created", async () => {
    for (const cwd of ["relative/dir", "/etc", join(home, "notes.txt"), join(home, ".ssh"), 42]) {
      const r = await api(h, "POST", "/chats/cwd-bad/start", { cwd });
      expect(r.status).toBe(400);
    }
    expect((await api(h, "POST", "/chats/cwd-bad/command", { name: "get_state" })).status).toBe(404);
  });

  test("a restart (config change) reuses the chosen cwd", async () => {
    const dir = join(home, "gamma");
    const first = await api(h, "POST", "/chats/cwd-restart/start", { cwd: dir });
    expect(first.json.state.cwd).toBe(dir);
    const put = await api(h, "PUT", "/config", { defaultTools: ["read"] });
    expect(put.status).toBe(200);
    const again = await api(h, "POST", "/chats/cwd-restart/start", {});
    expect(again.status).toBe(200);
    expect(again.json.state.pid).not.toBe(first.json.state.pid);
    expect(again.json.state.cwd).toBe(dir);
    expect(again.json.cwd).toBe(dir);
    await api(h, "PUT", "/config", { defaultTools: null });
  });

  test("a live chat cannot be moved to another cwd (409); the same cwd is accepted", async () => {
    const dir = join(home, "Beta");
    await api(h, "POST", "/chats/cwd-fixed/start", { cwd: dir });
    expect((await api(h, "POST", "/chats/cwd-fixed/start", { cwd: join(home, "gamma") })).status).toBe(409);
    expect((await api(h, "POST", "/chats/cwd-fixed/start", {})).json.cwd).toBe(dir);
    expect((await api(h, "POST", "/chats/cwd-fixed/start", { cwd: dir })).status).toBe(200);
  });

  test("a live default-workspace chat cannot be given a cwd (409)", async () => {
    await api(h, "POST", "/chats/cwd-ws/start", {});
    expect((await api(h, "POST", "/chats/cwd-ws/start", { cwd: join(home, "gamma") })).status).toBe(409);
  });
});

describe("protected directory list stays in step with cc-gate", () => {
  test("every gate-protected path is covered by a bridge protected root", () => {
    for (const p of DEFAULT_POLICY.protectedPaths) {
      const covered = PROTECTED_REL.some((root) => p === root || p.startsWith(root + "/"));
      expect(covered).toBe(true);
    }
  });

  test("a chosen cwd may be an ancestor of a protected directory; protected dirs themselves are rejected", async () => {
    // projects/ and projects/control-center contain the protected data/ folder. cc-gate covers access to it.
    const ancestors = [home, join(home, "projects"), join(home, "projects", "control-center")];
    for (const [i, dir] of ancestors.entries()) {
      const id = `cwd-ancestor-${i}`;
      expect((await api(h, "POST", `/chats/${id}/start`, { cwd: dir })).status).toBe(200);
      await api(h, "DELETE", `/chats/${id}`);
    }
    const protectedDirs = [join(home, "projects", "control-center", "data"), join(home, ".hermes")];
    for (const [i, dir] of protectedDirs.entries()) {
      const r = await api(h, "POST", `/chats/cwd-protected-${i}/start`, { cwd: dir });
      expect(r.status).toBe(400);
      expect(r.json.error).toMatch(/protected/);
    }
  });
});
