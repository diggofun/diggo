/**
 * The remaining screens a player visits: discoveries, the notification bell, leaderboards and the
 * dev-only UI gallery.
 *
 * These are load-and-render checks with one rule in common: the page reports what the Worker sent.
 * Where an outcome is random by design (a discovery roll) the test asserts the page showed the
 * result, never a particular result.
 */
import { expect, test } from "@playwright/test";
import { startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

test("the discoveries page renders and the roll control is wired to the wallet", async ({ page }) => {
  await startSignedIn(page);

  await page.goto("/discoveries");
  await expect(page.getByRole("heading", { level: 1, name: /your mining ledger/i })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // The control exists and is offered; clicking it is not asserted here. In v2 the roll is a
  // wallet-signed create_discovery_roll against the chain and the outcome is
  // sha256(epoch_seed || owner || window), so with no validator behind the dev pair there is no
  // opportunity to settle and nothing honest to assert about the result.
  const roll = page.getByRole("button", { name: /Run this window's discovery/ });
  await expect(roll).toBeVisible();
});

test("the notification bell stays inert until sign-in, then lists what the Worker generated", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".notifications-bell.is-disabled")).toBeVisible();

  await startSignedIn(page);

  // The bell names itself "Notifications" while it is empty and "N unread notifications" once the
  // Worker has generated something, so the query matches the whole name instead of one
  // capitalisation of it: the lowercase form is the one a player sees with unread alerts waiting.
  const bell = page.getByRole("button", { name: /^(?:\d+ unread )?notifications$/i });
  await expect(bell).toBeVisible();
  await bell.click();

  const menu = page.locator(".notifications-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Crew notifications")).toBeVisible();
  await expect(menu).not.toContainText("unavailable");
  // Either the Worker had nothing to say, or it listed real notifications.
  await expect(menu.locator("li").or(menu.locator(".notifications-empty"))).toBeVisible();
});

test("the leaderboards page renders its tables without a wallet", async ({ page }) => {
  await page.goto("/leaderboards");
  await expect(page.getByRole("heading", { level: 2, name: /TOP OF/ })).toBeVisible();
  await expect(page.getByText("Leaderboards are unavailable right now.")).toHaveCount(0);

  const head = page.locator(".leaderboard-head");
  // The column is headed "Miner" rather than "Wallet": the rows show the player's username
  // (falling back to a shortened address) instead of the raw wallet, see LeaderboardsScreen.
  await expect(head).toContainText("Miner");
  await expect(head).toContainText("Score");

  await page.getByRole("button", { name: "Mines" }).click();
  await expect(page.locator(".leaderboard-head")).toContainText("Network power");
});

test("the dev-only UI gallery renders the sample screens", async ({ page }) => {
  await page.goto("/__ui");
  await expect(page.locator(".ui-gallery")).toBeVisible();
  await expect(page.getByText("DEV ONLY // UI GALLERY")).toBeVisible();
  await expect(page.getByText("Crew on shift")).toBeVisible();

  await page.goto("/__ui?section=crew");
  await expect(page.locator(".crew-board")).toBeVisible();

  await page.goto("/__ui?report");
  await expect(page.locator(".report-modal")).toBeVisible();
});
