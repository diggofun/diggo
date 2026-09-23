/**
 * The remaining screens a player visits: discoveries, the notification bell, leaderboards and the
 * dev-only UI gallery.
 *
 * These are load-and-render checks with one rule in common: the page reports what the Worker sent.
 * Where an outcome is random by design (a discovery roll) the test asserts the page showed the
 * result, never a particular result.
 */
import { expect, test } from "@playwright/test";
import { activateCrew, startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

test("the discoveries page loads and the crew can ask for an opportunity", async ({ page }) => {
  await startSignedIn(page);
  await activateCrew(page);

  await page.goto("/discoveries");
  await expect(page.getByRole("heading", { level: 1, name: /WHAT THE CREW/ })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  const roll = page.getByRole("button", { name: /Ask for an opportunity|Roll this window/ });
  await expect(roll).toBeEnabled();
  await roll.click();

  // The Worker authors the opportunity and rolls the outcome; the page can only report it.
  const notice = page.locator(".discovery-notice");
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice).not.toBeEmpty();

  const rollThisWindow = page.getByRole("button", { name: /Roll this window/ });
  if (await rollThisWindow.isVisible().catch(() => false)) {
    await rollThisWindow.click();
    await expect(notice).toBeVisible();
  }
});

test("the notification bell stays inert until sign-in, then lists what the Worker generated", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".notifications-bell.is-disabled")).toBeVisible();

  await startSignedIn(page);

  const bell = page.getByRole("button", { name: /Notifications/ });
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
  await expect(head).toContainText("Wallet");
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
