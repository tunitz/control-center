import { test, expect, beforeEach } from "bun:test";
import { copyText } from "./clipboard";

let calls: string[], execResult: boolean, created: any[];
beforeEach(() => {
  calls = []; execResult = true; created = [];
  (globalThis as any).document = {
    body: { appendChild: (e: any) => calls.push("append"), removeChild: () => calls.push("remove") },
    createElement: () => { const e: any = { style: {}, setAttribute() {}, select: () => calls.push("select"), setSelectionRange: () => calls.push("range"), focus() {} }; created.push(e); return e; },
    execCommand: (c: string) => { calls.push("exec:" + c); return execResult; },
  };
});

test("insecure context (no navigator.clipboard, e.g. http://LAN-ip on iPhone) falls back to execCommand and reports success", async () => {
  (globalThis as any).navigator = {};
  expect(await copyText("hello")).toBe(true);
  expect(created[0].value).toBe("hello");
  expect(calls).toContain("exec:copy");
  expect(calls.at(-1)).toBe("remove"); // temp element cleaned up
});
test("reports failure instead of silently pretending when both methods fail", async () => {
  (globalThis as any).navigator = {};
  execResult = false;
  expect(await copyText("x")).toBe(false);
});
test("uses the async clipboard API when available", async () => {
  let written = "";
  (globalThis as any).navigator = { clipboard: { writeText: async (t: string) => { written = t; } } };
  expect(await copyText("abc")).toBe(true);
  expect(written).toBe("abc");
  expect(calls).not.toContain("exec:copy");
});
test("falls back when the async API rejects", async () => {
  (globalThis as any).navigator = { clipboard: { writeText: async () => { throw new Error("denied"); } } };
  expect(await copyText("abc")).toBe(true);
  expect(calls).toContain("exec:copy");
});
