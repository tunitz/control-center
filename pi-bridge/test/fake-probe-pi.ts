#!/usr/bin/env bun
// Stand-in for `pi --mode rpc` used by the tool-discovery test. It answers `/probe-list-tools` the way
// the real probe extension does: writes {tools:[{name,description}]} to CC_TOOLS_OUT (atomically).
// It also records its argv in `<CC_TOOLS_OUT>.argv` so the test can check the -e flags and env.
import { renameSync, writeFileSync } from "node:fs";

const out = process.env.CC_TOOLS_OUT ?? "";
writeFileSync(`${out}.argv`, JSON.stringify({ argv: process.argv.slice(2), agentDir: process.env.PI_CODING_AGENT_DIR ?? null }));

const decoder = new TextDecoder();
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += decoder.decode(chunk, { stream: true });
  let i: number;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let cmd: any;
    try {
      cmd = JSON.parse(line);
    } catch {
      continue;
    }
    if (cmd.type === "prompt" && cmd.message === "/probe-list-tools") {
      const tmp = `${out}.tmp`;
      writeFileSync(tmp, JSON.stringify({ tools: [
        { name: "read", description: "Read a file." },
        { name: "subagent", description: "Delegate to a subagent." },
        { name: "web_search", description: "Search the web." },
      ] }));
      renameSync(tmp, out);
    }
    process.stdout.write(JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true }) + "\n");
  }
}
