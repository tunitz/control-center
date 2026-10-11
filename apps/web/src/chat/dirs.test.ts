import { test, expect, describe } from "bun:test";
import { homeRelative, sessionCreatePayload, mapDirError, folderTag, validFolderName } from "./dirs";

describe("homeRelative", () => {
  test("home itself shows as ~", () => {
    expect(homeRelative("/home/tunitz", "/home/tunitz")).toBe("~");
  });
  test("folders under home show with ~/", () => {
    expect(homeRelative("/home/tunitz/projects/x", "/home/tunitz")).toBe("~/projects/x");
  });
  test("a path outside home stays absolute", () => {
    expect(homeRelative("/srv/data", "/home/tunitz")).toBe("/srv/data");
  });
  test("a sibling that only shares the prefix is not home-relative", () => {
    expect(homeRelative("/home/tunitz2/a", "/home/tunitz")).toBe("/home/tunitz2/a");
  });
  test("trailing slash on home is tolerated", () => {
    expect(homeRelative("/home/tunitz/a", "/home/tunitz/")).toBe("~/a");
  });
});

describe("sessionCreatePayload", () => {
  test("pi with a folder carries backend and cwd", () => {
    expect(sessionCreatePayload({ model: "m", effort: "low", backend: "pi", cwd: "/home/tunitz/p" }))
      .toEqual({ model: "m", effort: "low", backend: "pi", cwd: "/home/tunitz/p" });
  });
  test("pi with no folder (default workspace) carries no cwd", () => {
    const p = sessionCreatePayload({ model: "m", effort: null, backend: "pi", cwd: null });
    expect(p).toEqual({ model: "m", effort: null, backend: "pi" });
    expect("cwd" in p).toBe(false);
  });
  test("hermes never carries cwd or backend, even if a folder is given", () => {
    const p = sessionCreatePayload({ model: "m", effort: null, backend: "hermes", cwd: "/x" });
    expect(p).toEqual({ model: "m", effort: null });
    expect("cwd" in p).toBe(false);
    expect("backend" in p).toBe(false);
  });
  test("missing backend is treated as hermes", () => {
    expect("cwd" in sessionCreatePayload({ cwd: "/x" })).toBe(false);
  });
});

describe("mapDirError", () => {
  test("shows the server's own message on 400 and 409", () => {
    expect(mapDirError(400, "path is outside home")).toBe("path is outside home");
    expect(mapDirError(409, "folder already exists")).toBe("folder already exists");
  });
  test("falls back to a plain sentence when the server sends no text", () => {
    expect(mapDirError(400, "")).toBe("That folder cannot be used.");
    expect(mapDirError(409, "")).toBe("A folder with that name already exists.");
  });
  test("other failures get a generic message", () => {
    expect(mapDirError(500, "boom")).toBe("boom");
    expect(mapDirError(0, "")).toBe("Something went wrong.");
  });
});

describe("folderTag", () => {
  test("null means no tag", () => {
    expect(folderTag(null)).toBeNull();
  });
  test("shows the last two segments, full path as title", () => {
    expect(folderTag("/home/tunitz/projects/control-center")).toEqual({ label: "projects/control-center", title: "/home/tunitz/projects/control-center" });
  });
  test("a single segment shows as is", () => {
    expect(folderTag("/srv")).toEqual({ label: "srv", title: "/srv" });
  });
  test("trailing slash does not produce an empty segment", () => {
    expect(folderTag("/home/tunitz/a/")?.label).toBe("tunitz/a");
  });
});

describe("validFolderName", () => {
  test("accepts a plain name", () => {
    expect(validFolderName("notes")).toBe(true);
    expect(validFolderName("  notes  ")).toBe(true);
  });
  test("rejects empty, dot names and separators", () => {
    expect(validFolderName("")).toBe(false);
    expect(validFolderName("   ")).toBe(false);
    expect(validFolderName(".")).toBe(false);
    expect(validFolderName("..")).toBe(false);
    expect(validFolderName("a/b")).toBe(false);
  });
});
