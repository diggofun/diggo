/**
 * Publishes the official Diggo.fun coin's logo and metadata JSON to the production media store
 * (the TOKEN_CACHE KV namespace that serves https://diggo.fun/media/<key>).
 *
 * Dry run by default: it verifies the pinned local bytes and reports what the public URLs serve
 * right now. Only --upload writes, and only for a key that is missing; a URL already serving
 * different bytes is refused because /media responses are cached as immutable for a year.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH, assertOfficialLogo, officialMetadataJson } from "./launch-official-coin-core.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TOKEN_CACHE_NAMESPACE_ID = "d40b446e286b4c3fa6141e9eeaf983e1";
const WRANGLER = join(REPO_ROOT, "node_modules", "wrangler", "bin", "wrangler.js");

type HostedState = "live" | "missing" | "different";

async function hostedState(url: string, expected: Uint8Array): Promise<HostedState> {
  const response = await fetch(`${url}?media-check=${Date.now()}`, { cache: "no-store" });
  if (response.status === 404) return "missing";
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  return Buffer.from(body).equals(Buffer.from(expected)) ? "live" : "different";
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  for (const arg of args) if (arg !== "--upload") throw new Error(`Unknown option ${arg}`);
  const upload = args.includes("--upload");

  const logoPath = join(REPO_ROOT, "public", "brand", LAUNCH.imageKey);
  const logo = readFileSync(logoPath);
  assertOfficialLogo(logo);
  const json = Buffer.from(officialMetadataJson(), "utf8");
  const scratch = mkdtempSync(join(tmpdir(), "diggo-official-media-"));
  const jsonPath = join(scratch, LAUNCH.metadataKey);
  writeFileSync(jsonPath, json);

  // The logo goes first so the metadata JSON never points at a missing image.
  const items = [
    { key: `media:${LAUNCH.imageKey}`, path: logoPath, contentType: "image/png", url: LAUNCH.imageUrl, bytes: logo },
    { key: `media:${LAUNCH.metadataKey}`, path: jsonPath, contentType: "application/json", url: LAUNCH.metadataUrl, bytes: json },
  ];
  try {
    for (const item of items) {
      const state = await hostedState(item.url, item.bytes);
      console.log(`${item.url}: ${state} (${item.bytes.length} bytes expected)`);
      if (state === "different") throw new Error(`${item.url} already serves different bytes; refusing to continue`);
      if (state === "live" || !upload) continue;
      // Same KV format as uploadMedia() in worker/tokens.ts, without a TTL: on-chain metadata
      // points at these keys permanently.
      const metadata = JSON.stringify({ contentType: item.contentType, wallet: LAUNCH.payer, uploadedAt: Math.floor(Date.now() / 1000) });
      execFileSync(
        process.execPath,
        [WRANGLER, "kv", "key", "put", item.key, `--path=${item.path}`, `--namespace-id=${TOKEN_CACHE_NAMESPACE_ID}`, `--metadata=${metadata}`, "--remote"],
        { cwd: REPO_ROOT, stdio: "inherit" },
      );
      let verified = false;
      for (let attempt = 0; attempt < 12 && !verified; attempt += 1) {
        if (attempt > 0) await new Promise((done) => setTimeout(done, 5_000));
        verified = (await hostedState(item.url, item.bytes)) === "live";
      }
      if (!verified) throw new Error(`${item.url} does not serve the uploaded bytes after 60 s`);
      console.log(`${item.url}: uploaded and verified`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!upload) console.log("Dry run only: nothing was uploaded. Re-run with --upload after owner approval.");
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
