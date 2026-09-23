/**
 * Local D1 fixtures.
 *
 * The schema is prepared with the same wrangler command as npm run db:local, invoked as
 * "node node_modules/wrangler/bin/wrangler.js" so no shell shim is involved on Windows.
 *
 * The local database is shared with the running wrangler dev process, so every call retries: the
 * two do contend for the same SQLite file. Fixture failures are handed back to the caller instead of
 * thrown, because a test that needs missing backend state should skip with a reason rather than
 * fail as if the product were broken.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const REPO_ROOT = process.cwd();
const WRANGLER_BIN = path.join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
const DATABASE = "diggo-db";
/** The Worker half of the dev pair, overridable with the client's own proxy target. */
const WORKER_URL = process.env.DIGGO_E2E_WORKER_URL ?? "http://localhost:8787";

export interface D1Result {
  ok: boolean;
  output: string;
}

/** Synchronous backoff between attempts at a contended local database. */
function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function wrangler(args: string[]): D1Result {
  const result = spawnSync(process.execPath, [WRANGLER_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 90_000,
  });
  return { ok: result.status === 0, output: (result.stdout ?? "") + (result.stderr ?? "") };
}

function withRetries(run: () => D1Result, attempts = 3): D1Result {
  let last = run();
  for (let index = 1; index < attempts && !last.ok; index += 1) {
    sleepSync(1_500);
    last = run();
  }
  return last;
}

/** Runs SQL against the local D1 and returns the parsed result rows. */
export function d1Query<T>(sql: string): { ok: boolean; rows: T[]; output: string } {
  const result = withRetries(() =>
    wrangler(["d1", "execute", DATABASE, "--local", "--json", "--command", sql]),
  );
  if (!result.ok) return { ok: false, rows: [], output: result.output };
  const start = result.output.indexOf("[");
  const end = result.output.lastIndexOf("]");
  if (start === -1 || end <= start) return { ok: false, rows: [], output: result.output };
  try {
    const parsed = JSON.parse(result.output.slice(start, end + 1)) as { results?: T[] }[];
    return { ok: true, rows: parsed.flatMap((entry) => entry.results ?? []), output: result.output };
  } catch (error) {
    return { ok: false, rows: [], output: result.output + " / " + String(error) };
  }
}

/** Runs a statement that returns no rows. */
export function d1Execute(sql: string): D1Result {
  return withRetries(() => wrangler(["d1", "execute", DATABASE, "--local", "--command", sql]));
}

/** Applies pending migrations. It intentionally does not load demo application rows. */
export function prepareLocalD1(): D1Result {
  return withRetries(() => wrangler(["d1", "migrations", "apply", DATABASE, "--local"]));
}

/**
 * Waits for the Worker half of the dev pair. Playwright has already waited for vite (webServer) by
 * the time global setup runs, and wrangler dev starts a few seconds behind it.
 */
export async function waitForWorker(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no attempt made";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(WORKER_URL + "/api/bootstrap?limit=1");
      if (response.ok) return;
      lastError = "HTTP " + response.status;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("the Worker at " + WORKER_URL + " did not answer /api/bootstrap: " + lastError);
}

/** First line of a wrangler output block, for compact skip reasons. */
export function firstLine(output: string): string {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.length > 0);
  return (line ?? "unknown error").slice(0, 200);
}
