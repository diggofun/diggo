/**
 * Runner for the v2 section alone, through Vite's SSR pipeline so the TypeScript needs no build:
 *
 *   node scripts/sim/run-v2.mjs
 *
 * It loads only scripts/sim/v2*.ts, so it works while the v4 harness's shared/ imports are being
 * rewritten by the other workstreams. The same section is appended to the full report by
 * scripts/sim/main.ts, and reaches it through the sim npm script.
 */
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");

const server = await createServer({
  configFile: false,
  root,
  logLevel: "error",
  appType: "custom",
  server: { middlewareMode: true, hmr: false },
});

try {
  const module = await server.ssrLoadModule("/scripts/sim/v2standalone.ts");
  module.run();
} finally {
  await server.close();
}
