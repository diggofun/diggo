/**
 * Prepares the local backend the suite runs against: waits for the Worker, then applies pending D1
 * migrations. The suite never seeds application rows: v2 reads indexed chain state and must show
 * honest empty/unavailable states when no validator has produced any.
 */
import { firstLine, prepareLocalD1, waitForWorker } from "./fixtures/d1";

export default async function globalSetup(): Promise<void> {
  await waitForWorker();

  const prepared = prepareLocalD1();
  if (prepared.ok) {
    console.log("[e2e] local D1 prepared (migrations only)");
    return;
  }
  console.warn("[e2e] could not prepare local D1: " + firstLine(prepared.output));
}
