/**
 * End-to-end check of the referral capture path against the production bundle.
 *
 * Serves ./dist, opens /r/<slug> in a real browser and asserts the code is remembered and the URL is
 * cleaned up. This is the flow that used to lose every referral: nothing here signs in, because the
 * whole failure was that sign-in was the only moment the code was ever read.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { chromium } from "@playwright/test";

const DIST = new URL("../dist/", import.meta.url).pathname.replace(/^\/(.:)/, "$1");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json" };

const server = createServer(async (request, response) => {
  const path = normalize(decodeURIComponent(new URL(request.url, "http://x").pathname));
  for (const candidate of [join(DIST, path), join(DIST, "index.html")]) {
    try {
      const body = await readFile(candidate);
      response.writeHead(200, { "content-type": TYPES[extname(candidate)] ?? "application/octet-stream" });
      response.end(body);
      return;
    } catch {
      // Fall through to the SPA shell.
    }
  }
  response.writeHead(404).end("not found");
});

await new Promise((resolve) => server.listen(0, resolve));
const origin = "http://127.0.0.1:" + server.address().port;
const browser = await chromium.launch();
const page = await browser.newPage();
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures.push(name + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
  console.log((ok ? "PASS  " : "FAIL  ") + name);
};

try {
  // The app needs its API; stub the two calls the landing page makes.
  await page.route("**/api/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      tokens: [],
      config: { cluster: "mainnet-beta", chainMode: "meteora", meteoraConfigPubkey: "", turnstileSiteKey: "", programId: "", vanitySuffix: "diggo" },
    }),
  }));

  /**
   * The capture runs in a React effect, so wait for the app to actually mount before asserting.
   * domcontentloaded alone fires long before the module graph has executed.
   */
  const settle = () => page.waitForFunction(() => document.querySelector("#root")?.childElementCount > 0);

  await page.goto(origin + "/r/TestCode", { waitUntil: "domcontentloaded" });
  await settle();
  const stored = await page.evaluate(() => window.localStorage.getItem("diggo_ref"));
  check("remembers the /r/ slug", JSON.parse(stored ?? "null")?.code, "testcode");
  check("cleans the /r/ URL", new URL(page.url()).pathname, "/");

  await page.goto(origin + "/?ref=jurek&mint=So111", { waitUntil: "domcontentloaded" });
  await settle();
  const query = new URL(page.url());
  check("keeps the first referrer", JSON.parse(await page.evaluate(() => window.localStorage.getItem("diggo_ref") ?? "null"))?.code, "testcode");
  check("drops ?ref=", query.searchParams.get("ref"), null);
  check("keeps ?mint=", query.searchParams.get("mint"), "So111");

  await page.goto(origin + "/explore?ref=admin", { waitUntil: "domcontentloaded" });
  await settle();
  // `admin` is reserved, so it is neither stored nor sent; the earlier referrer stays put.
  const afterReserved = JSON.parse(await page.evaluate(() => window.localStorage.getItem("diggo_ref") ?? "null"));
  check("rejects a reserved code", afterReserved?.code, "testcode");
  check("leaves a refused ?ref= in the URL", new URL(page.url()).searchParams.get("ref"), "admin");
  check("leaves a non-referral path alone", new URL(page.url()).pathname, "/explore");
} finally {
  await browser.close();
  server.close();
}

if (failures.length) {
  console.error("\n" + failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("\nAll referral capture checks passed.");
}
