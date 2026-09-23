/**
 * Prepares the local backend the suite runs against: waits for the Worker, then makes sure the local
 * D1 holds the demo mines the repo's own dev workflow uses. Both steps are idempotent, and a failing
 * seed is reported rather than fatal, so the tests that need that data can skip with the reason.
 */
import { firstLine, seedLocalDemoData, waitForWorker } from "./fixtures/d1";

export default async function globalSetup(): Promise<void> {
  await waitForWorker();

  const seeded = seedLocalDemoData();
  if (seeded.ok) {
    console.log("[e2e] local D1 prepared (migrations + scripts/dev-seed.sql)");
    return;
  }
  console.warn("[e2e] could not prepare local D1: " + firstLine(seeded.output));
}
