// Typechecked by Pi at load time (it imports Pi packages not installed in this repo). Live-verified with real Pi.
// cc-browser: first-class browser tools backed by the `agent-browser` CLI and a local Chromium.
// One session per Pi process (= one chat). Loaded with `-e` only when the bridge's browser toggle is on.
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { browserEnv, cleanOutput, resolveAgentBrowser, resolveChromium, sessionName } from "../src/browser";

const TIMEOUT_MS = 60_000;

export default function (pi: ExtensionAPI) {
  const home = process.env.HOME ?? "";
  const agent = resolveAgentBrowser(process.env, home);
  // No CLI on this host: register nothing rather than break the session.
  if (!agent) return;
  const session = sessionName(process.pid);
  const socketDir = mkdtempSync(join(tmpdir(), "cc-browser-"));
  const env = browserEnv(process.env, resolveChromium(process.env, home), socketDir);

  const run = (args: string[], timeoutMs = TIMEOUT_MS): Promise<string> =>
    new Promise((resolve) => {
      execFile(
        agent,
        ["--session", session, ...args],
        { cwd: process.cwd(), env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          const text = cleanOutput(`${stdout ?? ""}${stderr ?? ""}`);
          resolve(err && text === "(no output)" ? `browser command failed: ${(err as Error).message}` : text);
        },
      );
    });

  // Best-effort teardown when the Pi process ends.
  process.on("exit", () => {
    try {
      execFile(agent, ["--session", session, "close"], { env, timeout: 5000 }, () => {});
    } catch {
      /* ignore */
    }
  });

  const tool = (name: string, label: string, description: string, parameters: unknown, build: (p: any) => string[]) =>
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_id: string, params: any) {
        return { content: [{ type: "text", text: await run(build(params)) }] };
      },
    });

  tool(
    "browser_navigate",
    "Browser Navigate",
    "Open a URL in the browser and return a compact page snapshot. Call this before the other browser tools.",
    Type.Object({ url: Type.String({ description: "Absolute URL, e.g. https://example.com" }) }),
    (p) => ["open", p.url],
  );
  tool(
    "browser_snapshot",
    "Browser Snapshot",
    "Text snapshot of the current page's accessibility tree with @ref IDs for browser_click and browser_type. Use after an interaction changes the page.",
    Type.Object({}),
    () => ["snapshot"],
  );
  tool(
    "browser_click",
    "Browser Click",
    "Click the element with this ref ID from a snapshot (for example @e3).",
    Type.Object({ ref: Type.String({ description: "Ref ID from a snapshot, e.g. @e3" }) }),
    (p) => ["click", p.ref],
  );
  tool(
    "browser_type",
    "Browser Type",
    "Clear an input and fill it with text, by ref ID from a snapshot.",
    Type.Object({ ref: Type.String({ description: "Ref ID from a snapshot, e.g. @e5" }), text: Type.String() }),
    (p) => ["fill", p.ref, p.text],
  );
  tool(
    "browser_press",
    "Browser Press",
    "Press a keyboard key, for example Enter, Tab or Control+a.",
    Type.Object({ key: Type.String() }),
    (p) => ["press", p.key],
  );
  tool(
    "browser_scroll",
    "Browser Scroll",
    "Scroll the page up, down, left or right, optionally by a pixel amount.",
    Type.Object({ direction: StringEnum(["up", "down", "left", "right"] as const), px: Type.Optional(Type.Number()) }),
    (p) => ["scroll", p.direction, ...(p.px != null ? [String(p.px)] : [])],
  );
  tool("browser_back", "Browser Back", "Go back in the browser history.", Type.Object({}), () => ["back"]);
  tool(
    "browser_screenshot",
    "Browser Screenshot",
    "Save a PNG screenshot of the current page and return its path.",
    Type.Object({}),
    () => ["screenshot"],
  );
  tool("browser_close", "Browser Close", "Close this chat's browser session.", Type.Object({}), () => ["close"]);
}
