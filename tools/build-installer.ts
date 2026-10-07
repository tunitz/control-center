// Writes the generic, key-as-argument installer (a release asset): bun run tools/build-installer.ts [outfile]
import { installScript } from "../apps/server/src/install";
const out = process.argv[2] ?? "dist/install-ccagent.sh";
await Bun.write(out, installScript({ interval: 5 }));
console.log("wrote", out);
