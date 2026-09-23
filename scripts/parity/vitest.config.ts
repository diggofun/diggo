import { defineConfig } from "vitest/config";

/**
 * The node-side parity run (WS-G).
 *
 * The root config's include list covers src/, shared/ and worker/, which is where the app's own
 * tests live. The parity harness has two halves: the half that asserts the frozen contract runs
 * under that config from shared/parity/, and this half reads the JSON vector files that A, B and C
 * emit, which needs the node project's filesystem types.
 *
 *   npx vitest run --config scripts/parity/vitest.config.ts
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/parity/**/*.test.ts"],
  },
});
