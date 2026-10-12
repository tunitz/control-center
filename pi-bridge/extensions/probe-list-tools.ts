// probe-list-tools: internal to pi-bridge, not a user feature. The bridge launches Pi with this
// extension, sends `/probe-list-tools` over RPC, and reads the tools Pi can offer for this launch.
// The list is written as {tools:[{name,description}]} to $CC_TOOLS_OUT (temp file + rename).
import { renameSync, writeFileSync } from "node:fs";

// Structural subset of Pi's ExtensionAPI, so this file typechecks without Pi's types installed here.
interface ProbeApi {
  registerCommand(name: string, opts: { description: string; handler: () => Promise<void> | void }): void;
  getAllTools(): { name: string; description?: string }[];
}

export default function (pi: ProbeApi) {
  pi.registerCommand("probe-list-tools", {
    description: "pi-bridge internal: write the tool list to CC_TOOLS_OUT",
    handler: () => {
      const out = process.env.CC_TOOLS_OUT;
      if (!out) return;
      const tools = pi.getAllTools().map((t) => ({ name: t.name, description: t.description ?? "" }));
      writeFileSync(`${out}.tmp`, JSON.stringify({ tools }));
      renameSync(`${out}.tmp`, out);
    },
  });
}
