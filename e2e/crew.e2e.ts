/**
 * Crew upgrades paid for with ORE.
 *
 * Two states matter and both are the Worker's, not the page's: a crew with no ORE cannot buy an
 * upgrade at all (the button is disabled and says why), and a crew with ORE spends exactly the ORE
 * the upgrade costs and comes out with more Mining Power. Real money never enters either path — ORE
 * is mined by keeping the crew active, and the page states that in as many words.
 */
import { expect, test, type Page } from "@playwright/test";
import { firstLine, setPlayerOreBalance } from "./fixtures/d1";
import { wallet } from "./fixtures/wallet";
import { activateCrew, startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
  await startSignedIn(page);
});

test("a crew with no ORE cannot afford an upgrade and is told so", async ({ page }) => {
  await page.goto("/crew");
  await expect(page.locator(".crew-board")).toBeVisible();

  // A fresh crew has banked nothing: every branch is refused, with the reason on the button.
  const upgrades = page.locator(".crew-upgrade-button");
  const branches = await upgrades.count();
  expect(branches).toBeGreaterThan(0);
  for (let index = 0; index < branches; index += 1) {
    await expect(upgrades.nth(index)).toBeDisabled();
    await expect(upgrades.nth(index)).toHaveAttribute("title", "Not enough ORE yet");
  }

  await expect(page.locator(".crew-head")).toContainText("0 ORE banked");
  await expect(page.locator(".crew-note")).toContainText("ORE cannot be bought");
  await expect(page.locator(".crew-screen .form-message:not(.crew-notice)")).toHaveCount(0);

  // Nothing moved: the levels are untouched after a reload.
  await page.reload();
  await expect(page.locator(".crew-card-level").first()).toHaveText("LV. 1");
});

test("an upgrade the crew can afford spends ORE and raises Mining Power", async ({ page }) => {
  // The activation creates this wallet's player row, which is what the fixture then funds.
  await activateCrew(page);
  const funded = setPlayerOreBalance(wallet.address, 250_000);
  test.skip(!funded.ok, "local D1 fixture could not run: " + firstLine(funded.output));

  await page.goto("/crew");
  await expect(page.locator(".crew-board")).toBeVisible();
  const powerBefore = await crewPower(page);

  const upgrade = page.locator(".crew-upgrade-button:not([disabled])").first();
  await expect(upgrade).toBeVisible();
  await upgrade.click();

  // The Worker reports what it spent and what the crew now mines; the page only echoes it.
  await expect(page.locator(".crew-notice")).toHaveText(
    /upgraded for [\d,]+ ORE\. Mining Power is now [\d,]+\./,
  );
  await expect(page.locator(".crew-screen .form-message:not(.crew-notice)")).toHaveCount(0);
  expect(await crewPower(page)).toBeGreaterThan(powerBefore);
});

/** Reads "N Mining Power" out of the crew header, which is the Worker's own number. */
async function crewPower(page: Page): Promise<number> {
  const summary = (await page.locator(".crew-head p").first().textContent()) ?? "";
  const match = /([\d,]+) Mining Power/.exec(summary);
  if (!match) throw new Error("could not read Mining Power from the crew header: " + summary);
  return Number(match[1]!.replaceAll(",", ""));
}
