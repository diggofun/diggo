/**
 * The v2 flows that need no chain.
 *
 * Everything here is a claim the page makes before anything is signed, and every one of them is
 * checkable against a dev pair with no validator behind it: what a launch costs and who pays it,
 * what playing costs a wallet, what the footer says, and that the legal documents render. The
 * flows that do need a chain (a roll, an upgrade) are either skipped with their reason or
 * asserted only as far as "the page reported an answer".
 */
import { expect, test } from "@playwright/test";
import { installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

test("the launch builder quotes the creator's cost and says who pays it", async ({ page }) => {
  await page.goto("/create");
  await expect(page.getByRole("heading", { level: 1, name: /start a new mine/i })).toBeVisible();
  await page.getByRole("button", { name: /Open launch builder/ }).click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  // 0.009288 SOL: the three accounts a coin is made of plus the estimated network fee. The figure
  // is derived in src/constants.ts and pinned against the contract by src/constants.test.ts.
  await expect(dialog.locator(".launch-cost-total")).toHaveText("0.009288 SOL");
  await expect(dialog.locator(".launch-cost-breakdown")).toContainText("Mint, coin account and vault rent");
  await expect(dialog.locator(".launch-cost-breakdown")).toContainText("0.009158 SOL");
  // With no sponsor event indexed, the form says the creator pays, in as many words, rather than
  // promising a subsidy the chain would not keep.
  await expect(dialog.locator(".launch-cost-note")).toContainText(
    "No sponsorship event is covering launches right now.",
  );
  await expect(dialog.locator(".launch-cost-note")).toContainText("Rent is spent, not deposited");
  await expect(dialog.locator(".launch-sponsored")).toHaveCount(0);
  await expect(dialog.locator(".modal-intro")).toContainText("Diggo never holds user funds");
});

test("the onboarding panel states the wallet's cost before anything is signed", async ({ page }) => {
  // This one also pins the bootstrap handshake: the panel renders only when the Worker's
  // programId reached the client (src/api.ts folds the flat payload into config), so a payload
  // shape change that leaves programId empty fails here rather than silently disabling every
  // chain-dependent surface.
  await page.goto("/mine");
  const panel = page.locator(".onboarding-panel");
  await expect(panel).toBeVisible();

  // No wallet, no chain read: the panel still has to state what playing costs.
  await expect(panel.locator(".onboarding-state")).toContainText("Wallet not connected");
  const play = panel.locator(".onboarding-card").first();
  await expect(play).toContainText("Play");
  await expect(play).toContainText("No ORE, no tokens and no payment are ever required to play.");
  await expect(play).toContainText("0.002394 SOL of rent");

  const walletNeeds = panel.locator(".onboarding-card").nth(1);
  await expect(walletNeeds).toContainText("ordinary network fee");
  await expect(walletNeeds).toContainText("Nothing else is ever locked or taken.");

  // There is no bond in the product: no card, no button and no figure may bring it back.
  await expect(panel.locator(".onboarding-card-bond")).toHaveCount(0);
  await expect(panel).not.toContainText("0.07 SOL");
  await expect(panel.locator(".onboarding-actions")).toContainText("Connect a wallet to create your player.");
});

test("the legal documents render, and the footer carries only the copyright line", async ({ page }) => {
  const documents = [
    { path: "/terms", title: "Terms of Service" },
    { path: "/privacy", title: "Privacy Policy" },
    { path: "/risk", title: "Risk Disclosure" },
    { path: "/cookies", title: "Cookie & Storage Notice" },
  ];

  for (const document of documents) {
    await page.goto(document.path);
    await expect(page.locator(".legal-page")).toBeVisible();
    await expect(page.locator("h1.legal-title")).toHaveText(document.title);
    // Every document cross-links the other three, which is the only navigation they have.
    await expect(page.locator(".legal-nav a")).toHaveCount(4);
  }

  await page.goto("/");
  await expect(page.locator(".site-footer small")).toHaveText("© 2026 Diggo.fun");
  await expect(page.locator(".site-footer")).not.toContainText("Devnet MVP");
});
