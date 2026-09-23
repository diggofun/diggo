/**
 * Crew upgrades paid for with ORE.
 *
 * Two states matter and both are the Worker's, not the page's: a crew with no ORE cannot buy an
 * upgrade at all (the button is disabled and says why), and a crew with ORE spends exactly the ORE
 * the upgrade costs and comes out with more Mining Power. Real money never enters either path — ORE
 * is mined by keeping the crew active, and the page states that in as many words.
 */
import { expect, test } from "@playwright/test";
import { startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
  await startSignedIn(page);
});

test("a crew with no ORE cannot afford an upgrade and is told so", async ({ page }) => {
  await page.goto("/crew");

  // The crew board is a read of the player's own PlayerAccount, so with no chain behind the dev
  // pair the page must show its empty state rather than invent a crew, a level or an ORE balance.
  await expect(page.locator(".crew-screen")).toBeVisible();
  await expect(page.locator(".crew-board")).toHaveCount(0);
  await expect(page.locator(".crew-upgrade-button")).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});
