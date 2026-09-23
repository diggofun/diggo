/**
 * Runner: loads the TypeScript simulation through Vite's SSR pipeline, so the harness can import
 * the real shared/ modules (which use extensionless relative imports) without a build step.
 *
 *   npm run sim -- --scenario baseline
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
  // hmr off: the app's own dev server already owns the HMR websocket port.
  server: { middlewareMode: true, hmr: false },
});

try {
  const module = await server.ssrLoadModule("/scripts/sim/main.ts");
  await module.run(process.argv.slice(2));
} finally {
  await server.close();
}
