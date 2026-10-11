import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserEnv, cleanOutput, resolveAgentBrowser, resolveChromium, sessionName, unwrapJs } from "../src/browser";

const home = () => mkdtempSync(join(tmpdir(), "cc-browser-"));
const touch = (p: string) => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, ""); };

test("resolveAgentBrowser: CC_BROWSER_BIN, then PATH, then the bundled CLI, else null", () => {
  const h = home();
  expect(resolveAgentBrowser({}, h)).toBeNull();

  const bundled = join(h, ".hermes/tools/agent-browser-9.9.9/bin/agent-browser-linux-x64");
  touch(bundled);
  expect(resolveAgentBrowser({}, h)).toBe(bundled);

  const onPath = join(h, "bin/agent-browser");
  touch(onPath);
  expect(resolveAgentBrowser({ PATH: join(h, "bin") }, h)).toBe(onPath);

  const explicit = join(h, "custom-agent-browser");
  touch(explicit);
  expect(resolveAgentBrowser({ CC_BROWSER_BIN: explicit, PATH: join(h, "bin") }, h)).toBe(explicit);
  // A stale explicit path is ignored, not fatal.
  expect(resolveAgentBrowser({ CC_BROWSER_BIN: join(h, "missing") }, h)).toBe(bundled);
});

test("resolveChromium: env value first, else the bundled Chromium, else null", () => {
  const h = home();
  expect(resolveChromium({}, h)).toBeNull();

  const chrome = join(h, ".hermes/tools/chromium-1208/chrome-linux64/chrome");
  touch(chrome);
  expect(resolveChromium({}, h)).toBe(chrome);
  expect(resolveChromium({ AGENT_BROWSER_EXECUTABLE_PATH: join(h, "missing") }, h)).toBe(chrome);

  const explicit = join(h, "my-chrome");
  touch(explicit);
  expect(resolveChromium({ AGENT_BROWSER_EXECUTABLE_PATH: explicit }, h)).toBe(explicit);
});

test("sessionName, browserEnv and cleanOutput", () => {
  expect(sessionName(4242)).toBe("cc-4242");

  // An explicit executable path wins; the socket dir is always set.
  expect(browserEnv({ PATH: "/usr/bin", AGENT_BROWSER_EXECUTABLE_PATH: "/x/chrome" }, "/bundled/chrome", "/sock"))
    .toEqual({ PATH: "/usr/bin", AGENT_BROWSER_EXECUTABLE_PATH: "/x/chrome", AGENT_BROWSER_SOCKET_DIR: "/sock" });
  expect(browserEnv({}, "/bundled/chrome", "/sock")).toEqual({ AGENT_BROWSER_EXECUTABLE_PATH: "/bundled/chrome", AGENT_BROWSER_SOCKET_DIR: "/sock" });

  expect(cleanOutput("  hi  ")).toBe("hi");
  expect(cleanOutput("")).toBe("(no output)");
  expect(cleanOutput("x".repeat(20), 5)).toContain("trimmed");
  expect(cleanOutput("x".repeat(5), 5)).toBe("xxxxx");
});

test("unwrapJs unwraps a JSON string, leaves arrays and plain text", () => {
  expect(unwrapJs('"hello"')).toBe("hello");
  expect(unwrapJs('  "[{\\"a\\":1}]"  ')).toBe('[{"a":1}]');
  expect(unwrapJs('[{"a":1}]')).toBe('[{"a":1}]');
  expect(unwrapJs("plain text")).toBe("plain text");
});
