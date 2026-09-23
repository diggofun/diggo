/**
 * Shared page helpers: the wallet handshake, the crew's activation state, and the console-error
 * collector the "no console errors" sweep uses.
 *
 * Selectors here are the app's own accessible names and class hooks (header wallet control,
 * .dash-status, .report-modal). Nothing reaches into React internals or stubs a fetch: every helper
 * clicks what a player would click.
 */
import { expect, type Page } from "@playwright/test";
import { sessionCookie } from "../fixtures/session";
import { shortAddress, wallet } from "../fixtures/wallet";
import { MOCK_WALLET_NAME } from "./mockWallet";

export function headerWallet(page: Page) {
  return page.locator("header .wallet-control");
}

/** The header button that shows the signed-in address (its title says so). */
export function signedInButton(page: Page) {
  return headerWallet(page).getByRole("button", { name: shortAddress(wallet.address) });
}

export function activateButton(page: Page) {
  return page.getByRole("button", { name: /^Activate for/ });
}

export function collectButton(page: Page) {
  return page.getByRole("button", { name: /Collect report/ });
}

/**
 * Opens the header's connect menu and picks the injected wallet. The wallet registers from an init
 * script, so it can appear a moment after the app; the menu is reopened a few times rather than
 * sleeping on a fixed timeout.
 */
export async function connectMockWallet(page: Page): Promise<void> {
  const connect = headerWallet(page).getByRole("button", { name: /Connect wallet/ });
  await expect(connect).toBeVisible();

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    await connect.click();
    const entry = page.getByRole("button", { name: MOCK_WALLET_NAME });
    const appeared = await entry
      .waitFor({ state: "visible", timeout: 4_000 })
      .then(() => true)
      .catch(() => false);
    if (appeared) {
      await entry.click();
      return;
    }
    await page.keyboard.press("Escape");
  }
  throw new Error("the injected Wallet Standard wallet never appeared in the connect menu");
}

/**
 * Signs the Worker's challenge with the connected wallet; the header then shows the address.
 *
 * The Worker rate-limits /api/auth/* to 12 requests per IP per minute and every browser in a run
 * shares one IP, so a refused attempt waits the window out and tries once more instead of reporting
 * a product failure that is really the suite's own concurrency.
 */
export async function signInWithWallet(page: Page, attempts = 2): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await headerWallet(page).getByRole("button", { name: "Sign in", exact: true }).click();
    const signedIn = await signedInButton(page)
      .waitFor({ state: "visible", timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    if (signedIn) return;
    if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 62_000));
  }
  await expect(signedInButton(page)).toBeVisible({ timeout: 5_000 });
}

/**
 * The state every game surface needs: a real session cookie for this worker's wallet (see
 * e2e/fixtures/session.ts) plus the connected wallet the header renders from.
 *
 * The session is the Worker's own, issued after verifying a genuine signature over its challenge;
 * only the exchange happens over HTTP instead of through the header's button, which keeps the suite
 * inside the per-IP auth rate limit. e2e/auth.e2e.ts covers the interactive path.
 */
export async function startSignedIn(page: Page): Promise<void> {
  await page.context().addCookies([await sessionCookie()]);
  await page.goto("/");
  await expectBootstrapLoaded(page);
  await connectMockWallet(page);
  await expect(signedInButton(page)).toBeVisible({ timeout: 30_000 });
}

/**
 * The app shows a loading screen until /api/bootstrap answers, and an alert when it does not. Both
 * are checked here so a dev server that restarted mid-run fails at the helper with a clear message
 * instead of somewhere deeper in a test.
 */
export async function expectBootstrapLoaded(page: Page): Promise<void> {
  await expect(page.locator(".loading-screen")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator(".page-alert")).toHaveCount(0);
}

export async function gotoMinePage(page: Page): Promise<void> {
  await page.goto("/mine");
  await expect(page.getByRole("heading", { level: 1, name: /YOUR CREW IS/ })).toBeVisible();
}

/**
 * Brings the crew to ACTIVE through the dashboard's own button, tolerating a wallet whose
 * activation window is already open (a second test in the same file reuses one wallet).
 */
export async function activateCrew(page: Page): Promise<void> {
  await gotoMinePage(page);
  await expect(activateButton(page).or(collectButton(page))).toBeVisible({ timeout: 30_000 });
  if (await activateButton(page).isVisible()) {
    await activateButton(page).click();
    await expect(collectButton(page)).toBeVisible({ timeout: 30_000 });
  }
  await expect(page.getByText("Crew on shift")).toBeVisible();
  await closeReportModal(page);
}

/** Activation opens the mining report; the dashboard sits behind it. */
export async function closeReportModal(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible().catch(() => false)) {
    await dialog.getByRole("button", { name: "Close" }).click();
    await expect(dialog).toBeHidden();
  }
}

/** Third-party noise: analytics, the WalletConnect relay, and any resource outside localhost. */
const THIRD_PARTY_TEXT = /(posthog|walletconnect|reown)/i;
const THIRD_PARTY_URL = /https?:\/\/(?!localhost|127\.0\.0\.1)[^\s"')]+/i;

function isThirdPartyNoise(text: string, source: string): boolean {
  return THIRD_PARTY_TEXT.test(text) || THIRD_PARTY_TEXT.test(source) || THIRD_PARTY_URL.test(text);
}

/**
 * Watches the console and the uncaught-error channel for the whole test.
 *
 * Requests that leave localhost are ignored (the app loads PostHog and can talk to a devnet RPC;
 * those failures are not app defects); everything the app itself logs counts. Identical messages are
 * collapsed into one line with a repeat count, because a render loop can emit hundreds of the same
 * error and the report should stay readable. Each line carries the route it happened on.
 */
export function collectConsoleErrors(page: Page): { read(): string[] } {
  const seen = new Map<string, number>();

  const record = (kind: string, text: string, source: string): void => {
    if (isThirdPartyNoise(text, source)) return;
    const key = kind + ": " + text + " [" + page.url() + "]";
    seen.set(key, (seen.get(key) ?? 0) + 1);
  };

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    record("console error", message.text(), message.location().url);
  });
  page.on("pageerror", (error) => {
    record("page error", error.stack ?? error.message, "");
  });

  return {
    read: () =>
      Array.from(seen, ([key, count]) => (count > 1 ? key + " (x" + count + ")" : key)),
  };
}
