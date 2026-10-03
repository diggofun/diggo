import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { seoPages } from "./scripts/seo";

/**
 * The client's port and the Worker it proxies to are overridable so two checkouts can each run
 * their own pair at the same time - which is exactly what a shared machine with more than one agent
 * needs, because Playwright reuses whatever already answers on its base URL. The defaults are the
 * pair scripts/dev-local.mjs starts (vite 5173, wrangler dev 8787).
 */
const workerUrl = process.env.DIGGO_WORKER_URL ?? "http://localhost:8787";
const clientPort = Number(process.env.DIGGO_CLIENT_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), seoPages()],
  server: {
    port: clientPort,
    proxy: {
      "/api": workerUrl,
      "/media": workerUrl,
      "/webhooks": workerUrl
    }
  }
});
