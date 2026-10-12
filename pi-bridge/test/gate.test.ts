import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluate, askWithTimeout, loadPolicy, navigatesOut, DEFAULT_POLICY } from "../extensions/cc-gate";

const HOME = "/home/u";
const CWD = `${HOME}/.local/share/cc-pi/workspace/chat1`;
const P = { ...DEFAULT_POLICY, home: HOME };
const ev = (tool: string, input: Record<string, unknown>) => evaluate(tool, input, CWD, P);

describe("cc-gate evaluate", () => {
  test("plain bash runs", () => {
    expect(ev("bash", { command: "ls -la" }).confirm).toBe(false);
    expect(ev("bash", { command: "echo hi && git status" }).confirm).toBe(false);
  });

  test("risky bash asks", () => {
    for (const c of ["rm -rf x", "sudo ls", "chmod 777 f", "chown a f", "curl http://x", "wget http://x", "ssh host", "dd if=a of=b", "mkfs.ext4 /dev/x", "echo a > f"]) {
      expect(ev("bash", { command: c }).confirm).toBe(true);
    }
  });

  test("words that only contain a risky name do not ask", () => {
    expect(ev("bash", { command: "echo transform farm" }).confirm).toBe(false);
  });

  test("bash touching a protected path asks", () => {
    expect(ev("bash", { command: "cat ~/.ssh/id_ed25519" }).confirm).toBe(true);
    expect(ev("bash", { command: `cat ${HOME}/.hermes/.env` }).confirm).toBe(true);
    expect(ev("bash", { command: "cat $HOME/.local/share/cc-pi/env" }).confirm).toBe(true);
  });

  test("write/edit inside workspace runs, outside asks", () => {
    expect(ev("write", { path: "a.txt", content: "x" }).confirm).toBe(false);
    expect(ev("edit", { path: `${CWD}/sub/a.txt` }).confirm).toBe(false);
    expect(ev("write", { path: "../other/a.txt" }).confirm).toBe(true);
    expect(ev("edit", { path: `${HOME}/projects/x.ts` }).confirm).toBe(true);
  });

  test("any read or write touching a protected path asks", () => {
    expect(ev("read", { path: `${HOME}/.hermes/config.yaml` }).confirm).toBe(true);
    expect(ev("read", { path: "~/.ssh/config" }).confirm).toBe(true);
    expect(ev("grep", { pattern: "x", path: `${HOME}/.local/share/cc-pi/env` }).confirm).toBe(true);
    expect(ev("ls", { path: `${HOME}/projects/control-center/data` }).confirm).toBe(true);
  });

  test("read outside the workspace but not protected runs", () => {
    expect(ev("read", { path: "/etc/hostname" }).confirm).toBe(false);
    expect(ev("read", { path: "notes.md" }).confirm).toBe(false);
  });

  test("path traversal into a protected dir asks", () => {
    expect(ev("read", { path: "../../../../../.ssh/id_rsa" }).confirm).toBe(true);
  });

  test("unknown tools run", () => {
    expect(ev("todo_write", { todos: [] }).confirm).toBe(false);
  });

  test("allowlist lets a matching bash command run", () => {
    const p = { ...P, bashAllow: ["^curl -s http://127\\.0\\.0\\.1:\\d+/health$"] };
    expect(evaluate("bash", { command: "curl -s http://127.0.0.1:80/health" }, CWD, p).confirm).toBe(false);
    expect(evaluate("bash", { command: "curl http://evil" }, CWD, p).confirm).toBe(true);
  });

  test("a confirm carries a title and a readable reason", () => {
    const d = ev("bash", { command: "rm -rf x" });
    expect(d.title.length).toBeGreaterThan(0);
    expect(d.message).toContain("rm -rf x");
  });
});

describe("askWithTimeout", () => {
  test("answer wins", async () => {
    expect(await askWithTimeout(async () => true, 1000)).toBe(true);
    expect(await askWithTimeout(async () => false, 1000)).toBe(false);
  });
  test("no answer in time = deny", async () => {
    const t0 = Date.now();
    expect(await askWithTimeout(() => new Promise<boolean>(() => {}), 60)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(500);
  });
  test("a throwing prompt = deny", async () => {
    expect(await askWithTimeout(async () => { throw new Error("x"); }, 1000)).toBe(false);
  });
});

describe("Pi's own config files are protected", () => {
  for (const f of ["APPEND_SYSTEM.md", "cc-append-system.md", "SYSTEM.md", "AGENTS.md", "cc-gate.json", "cc-config.json", "extensions/cc-gate.ts"]) {
    test(`write to agent dir ${f} asks`, () => {
      expect(ev("write", { path: `${HOME}/.local/share/cc-pi/agent/${f}`, content: "x" }).confirm).toBe(true);
      expect(ev("bash", { command: `echo hi > ~/.local/share/cc-pi/agent/${f}` }).confirm).toBe(true);
    });
  }
  test("Pi's session files are still readable without asking", () => {
    expect(ev("read", { path: `${HOME}/.local/share/cc-pi/agent/sessions/a.jsonl` }).confirm).toBe(false);
  });
});

describe("loadPolicy: the config file can only make the gate stricter", () => {
  const dirWith = (obj: unknown) => {
    const d = mkdtempSync(join(tmpdir(), "gate-"));
    writeFileSync(join(d, "cc-gate.json"), typeof obj === "string" ? obj : JSON.stringify(obj));
    return d;
  };
  test("no file = the default policy", () => {
    expect(loadPolicy(mkdtempSync(join(tmpdir(), "gate-")))).toEqual(DEFAULT_POLICY);
    expect(loadPolicy(undefined)).toEqual(DEFAULT_POLICY);
  });
  test("extraProtectedPaths and extraRisky are added to the defaults", () => {
    const pol = loadPolicy(dirWith({ extraProtectedPaths: ["projects/secret"], extraRisky: ["git\\s+push"] }));
    expect(pol.protectedPaths).toEqual([...DEFAULT_POLICY.protectedPaths, "projects/secret"]);
    expect(evaluate("read", { path: `${HOME}/projects/secret/a` }, CWD, { ...pol, home: HOME }).confirm).toBe(true);
    expect(evaluate("bash", { command: "git push origin main" }, CWD, { ...pol, home: HOME }).confirm).toBe(true);
    expect(evaluate("bash", { command: "ls" }, CWD, { ...pol, home: HOME }).confirm).toBe(false);
  });
  test("keys that would loosen the gate are ignored", () => {
    const pol = loadPolicy(dirWith({ protectedPaths: [], bashAllow: [".*"], bashRisky: "never", timeoutMs: 1 }));
    expect(pol).toEqual(DEFAULT_POLICY);
  });
  test("a bad regex or a corrupt file never loosens or crashes", () => {
    expect(loadPolicy(dirWith({ extraRisky: ["("] })).bashRisky).toBe(DEFAULT_POLICY.bashRisky);
    expect(loadPolicy(dirWith("{nope"))).toEqual(DEFAULT_POLICY);
  });
});

describe("browser tools through the gate", () => {
  test("navigating off the machine asks; loopback and data: URLs run", () => {
    for (const url of ["https://example.com", "http://10.0.0.5/x", "https://localhost.evil.com"]) {
      expect(ev("browser_navigate", { url }).confirm).toBe(true);
    }
    for (const url of ["data:text/html,<h1>x</h1>", "about:blank", "http://localhost:3000", "http://127.0.0.1/x"]) {
      expect(ev("browser_navigate", { url }).confirm).toBe(false);
    }
  });

  test("browser_eval always asks, and the read-only browser tools do not", () => {
    expect(ev("browser_eval", { expression: "document.title" }).confirm).toBe(true);
    for (const tool of ["browser_snapshot", "browser_get_images", "browser_click", "browser_type", "browser_scroll", "browser_screenshot", "browser_vision", "browser_close"]) {
      expect(ev(tool, {}).confirm).toBe(false);
    }
  });

  test("navigatesOut classifies URLs", () => {
    expect(navigatesOut("https://example.com/x")).toBe(true);
    expect(navigatesOut("data:text/html,x")).toBe(false);
    expect(navigatesOut("http://127.0.0.1:1")).toBe(false);
    expect(navigatesOut("http://[::1]:1")).toBe(false);
    expect(navigatesOut("not a url")).toBe(true);
  });
});
