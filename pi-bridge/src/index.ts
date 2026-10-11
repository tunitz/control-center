import { createBridge } from "./bridge";
import { loadConfig } from "./config";

// Loopback only. Nothing here may bind 0.0.0.0: the bearer token is the only guard.
const cfg = loadConfig();
const bridge = createBridge(cfg);
const server = Bun.serve({
  port: cfg.port,
  hostname: "127.0.0.1",
  idleTimeout: 0, // SSE streams stay open; keepalive pings come from the bridge
  fetch: bridge.fetch,
});
console.log(`pi-bridge listening on 127.0.0.1:${server.port}`);

const stop = async () => {
  await bridge.shutdown();
  server.stop(true);
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
