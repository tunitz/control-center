import { describe, expect, test } from "bun:test";
import { evaluate, askWithTimeout, DEFAULT_POLICY } from "../extensions/cc-gate";

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
