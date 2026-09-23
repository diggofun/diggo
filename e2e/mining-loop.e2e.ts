/**
 * The core loop: activate, collect, switch - and why it is skipped in v2.
 *
 * In v4 every assertion here was about state the Worker authored: the activation window, the stored
 * mining report, the crew's active mine. v2 moved all three to the program. `activate`,
 * `claim_rewards` and `switch_mine` are instructions the player's own wallet signs against the
 * on-chain PlayerAccount and MiningPosition, and the dashboard's own numbers come from a chain read
 * (design section 2, rows 1, 6, 16, 17). With no validator behind the dev pair there is nothing for
 * the page to display and no instruction that can succeed, so the three tests below are kept but
 * skipped with that reason; docs/DEPLOYMENT.md's "Running the chain-dependent end-to-end specs"
 * is the setup that makes them runnable again.
 *
 * What is still covered without a chain: the wallet handshake (auth.e2e.ts), the surfaces that only
 * read the index (surfaces.e2e.ts), the launch cost and the onboarding copy (launch-v2.e2e.ts).
 */
import { expect, test } from "@playwright/test";
import {
  activateButton,
  activateCrew,
  closeReportModal,
  collectButton,
  gotoMinePage,
  startSignedIn,
} from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
  await startSignedIn(page);
});

test.skip("activating a mine opens a 24h shift with a live countdown", async ({ page }) => {
  await gotoMinePage(page);

  // Playwright reuses a worker process across files, so a sibling file may already have opened this
  // wallet's window: the activation is exercised whenever the crew is still paused.
  await expect(activateButton(page).or(collectButton(page))).toBeVisible({ timeout: 30_000 });
  if (await activateButton(page).isVisible()) {
    await activateButton(page).click();
    await expect(collectButton(page)).toBeVisible({ timeout: 30_000 });
  }

  // ACTIVE: the status band, the collect action and the active-only dashboard.
  await expect(page.locator(".dash-status .badge")).toHaveText("Active");
  await expect(page.getByText("Crew on shift")).toBeVisible();
  await expect(collectButton(page)).toBeVisible();
  await expect(page.locator(".dash-active")).toBeVisible();
  await expect(page.locator(".dash-mine-token h3")).not.toBeEmpty();
  await closeReportModal(page);

  // The countdown is the Worker's activation window, ticking once a second.
  const countdown = page.locator(".dash-countdown").first();
  await expect(countdown).toHaveText(/^2[0-3]:\d{2}:\d{2}$/);
  const firstReading = await countdown.innerText();
  await expect.poll(() => countdown.innerText()).not.toBe(firstReading);

  // The dashboard never claims ORE is worth money.
  await expect(
    page.getByText("ORE is a game currency and cannot be bought, sold or transferred."),
  ).toBeVisible();
});

test.skip("collecting a mining report is idempotent and stays inside the game economy", async ({ page }) => {
  await activateCrew(page);
  await collectButton(page).click();

  const report = page.locator(".report-modal");
  await expect(report).toBeVisible();
  await expect(report.getByText("ORE MINED")).toBeVisible();
  await expect(report.getByText(/game progression/)).toBeVisible();
  await expect(report.getByRole("button", { name: /Collected/ })).toBeDisabled();
  await report.getByRole("button", { name: "Close" }).click();
  await expect(report).toBeHidden();

  // One stored report per activation window: collecting again returns the same report, not a new
  // reward, and never surfaces an error.
  await collectButton(page).click();
  await expect(report).toBeVisible();
  await expect(report.getByRole("button", { name: /Collected/ })).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test.skip("switching mines moves the crew to the mine the player picked", async ({ page }) => {
  await activateCrew(page);
  // textContent, not innerText: the switch list renders its mine names in uppercase.
  const currentMine = (await page.locator(".dash-mine-token h3").textContent())?.trim() ?? "";

  await page.getByRole("button", { name: /Switch mine/ }).click();
  const dialog = page.getByRole("dialog", { name: "Switch mine" });
  await expect(dialog).toBeVisible();

  // The list is the Worker's mine list: an empty one means the page never got its bootstrap data.
  const switchable = dialog.locator("li", { hasText: "Switch crew here" });
  expect(await switchable.count()).toBeGreaterThan(0);

  const target = switchable.first();
  const targetMine = (await target.locator("strong").textContent())?.trim() ?? "";
  expect(targetMine).not.toBe(currentMine);

  await target.getByRole("button", { name: /Switch crew here/ }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".dash-mine-token h3")).toHaveText(targetMine);
});
