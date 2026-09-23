/**
 * A signed-in walk through the game surfaces with the console watched.
 *
 * The collector ignores anything that leaves localhost (analytics, a devnet RPC) so a missing
 * third-party endpoint cannot masquerade as an app defect; everything the app itself logs, including
 * uncaught page errors, fails the test.
 *
 * /trade and /mines are left out on purpose: they load the swap terminal, which talks to a devnet
 * RPC and is covered by its own work, not by the core loop.
 */
import { expect, test } from "@playwright/test";
import { collectConsoleErrors, startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

test("the game surfaces render without console errors", async ({ page }) => {
  const errors = collectConsoleErrors(page);
  await startSignedIn(page);

  const routes: { path: string; anchor: string }[] = [
    { path: "/", anchor: ".hero" },
    { path: "/mine", anchor: ".dashboard-panel" },
    // The crew board renders only once the player's PlayerAccount has been read from chain, so the
    // anchor here is the page shell: this test is about what the app logs, not about a chain read.
    { path: "/crew", anchor: "main#content" },
    { path: "/discoveries", anchor: ".discoveries" },
    { path: "/leaderboards", anchor: ".leaderboards" },
    { path: "/explore", anchor: "main#content" },
    { path: "/__ui", anchor: ".ui-gallery" },
  ];

  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.locator(route.anchor).first()).toBeVisible();
  }

  expect(errors.read()).toEqual([]);
});
