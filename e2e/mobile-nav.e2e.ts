/**
 * The phone layout (below 760px): the desktop nav collapses into the menu panel and the five game
 * destinations move to the thumb-reachable tab bar. Both have to actually navigate.
 */
import { expect, test } from "@playwright/test";
import { installMockWallet } from "./support/mockWallet";

test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

test("the mobile tab bar and menu panel reach the game screens", async ({ page }) => {
  await page.goto("/");

  const tabBar = page.locator(".tab-bar");
  await expect(tabBar).toBeVisible();
  await expect(page.locator("header .main-nav")).toBeHidden();

  for (const label of ["Mine", "Crew", "Finds", "Explore", "Trade"]) {
    await expect(tabBar.getByRole("link", { name: label })).toBeVisible();
  }

  await tabBar.getByRole("link", { name: "Finds" }).click();
  await expect(page).toHaveURL(/\/discoveries$/);
  await expect(page.getByRole("heading", { level: 1, name: /WHAT THE CREW/ })).toBeVisible();

  await page.getByRole("button", { name: "Open menu" }).click();
  const menu = page.locator("#site-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("link", { name: "Leaderboards" })).toBeVisible();

  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(menu).toBeHidden();
});
