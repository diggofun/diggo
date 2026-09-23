/**
 * The notification popover: its layout inside the header, and how it reports a failed read.
 *
 * Both tests drive the real dev pair and sign in the way the rest of the suite does, because the
 * popover only exists once the header has a session. The first test is a layout contract: the panel
 * is a scroll container hanging off a control in the sticky header, so it may not leave the
 * viewport at any width the header is used at, nothing inside it may be wider than it, and opening
 * it may not add a horizontal scrollbar to the page. The second makes the Worker fail on purpose,
 * because the reason a read failed is the one thing the panel has to say - and the one thing it
 * used to replace with "Notifications are unavailable right now."
 */
import { expect, test, type Page } from "@playwright/test";
import { startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

/** How far the document is wider than the viewport. */
function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("the alerts popover stays inside the viewport at desktop, tablet and phone widths", async ({ page }) => {
  await startSignedIn(page);

  // The bell is addressed by its own class: once the panel is open its two action buttons carry
  // "notifications" in their accessible names too, so a role query would stop being unique.
  const bell = page.locator("button.notifications-bell");
  const menu = page.locator(".notifications-menu");
  // It names itself "N unread notifications" once there are unread alerts, and "Notifications"
  // while the bell is empty; both are the same control.
  await expect(bell).toHaveAttribute("aria-label", /notifications/i);

  for (const width of [1280, 768, 640, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const before = await pageOverflow(page);

    await bell.click();
    await expect(menu).toBeVisible();

    // The panel hangs off the header, so it is never the reason the page scrolls sideways: whatever
    // the page already overflowed by, it may overflow by no more than that with the panel open.
    expect(await pageOverflow(page), "page overflow added by the panel at " + width + "px").toBeLessThanOrEqual(
      before + 1,
    );

    const box = await menu.boundingBox();
    expect(box, "panel box at " + width + "px").not.toBeNull();
    expect(box!.x, "panel left edge at " + width + "px").toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width, "panel right edge at " + width + "px").toBeLessThanOrEqual(width + 1);

    // The panel scrolls vertically, so its horizontal axis computes to auto: one value the Worker
    // sent without a space to break at used to give the whole popover a horizontal scrollbar.
    expect(
      await menu.evaluate((element) => element.scrollWidth - element.clientWidth),
      "panel content at " + width + "px",
    ).toBeLessThanOrEqual(1);

    await bell.click();
    await expect(menu).toBeHidden();
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await bell.click();
  await expect(menu.getByText("Crew notifications")).toBeVisible();

  // The panel's glyphs are the shipped raster assets, masked into the panel's ink: the alerts mark in
  // the title, and the refresh and mark-all-read actions. No inline SVG, no icon pack.
  await expect(menu.locator(".notifications-title-glyph")).toHaveCount(1);
  await expect(menu.locator(".notifications-action .icon")).toHaveCount(2);
  await expect(menu.locator("svg")).toHaveCount(0);

  const glyphs = await menu.locator(".notifications-action .icon").evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return (node as HTMLElement).style.getPropertyValue("--icon") || style.maskImage;
    }),
  );
  for (const glyph of glyphs) expect(glyph).toContain("/assets/icons/");
});

test("a failed read is reported with its reason instead of an empty bell", async ({ page }) => {
  // The Worker is made to answer the way it does when a query behind it is broken, so the panel's
  // failure copy is asserted without depending on the backend's current state.
  await page.route("**/api/notifications", (route) =>
    route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "D1_ERROR: no such table: discoveries" }),
    }),
  );

  await startSignedIn(page);
  await page.locator("button.notifications-bell").click();

  const menu = page.locator(".notifications-menu");
  const notice = menu.locator(".notifications-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Notifications could not be loaded.");
  // The status and the Worker's own message, not a friendly sentence that fits every failure.
  await expect(notice).toContainText("500");
  await expect(notice).toContainText("no such table: discoveries");
  await expect(notice.getByRole("button", { name: "Try again" })).toBeEnabled();
  await expect(menu).not.toContainText("unavailable");
  // A read that failed is not a mine with nothing to report.
  await expect(menu.locator(".notifications-empty")).toHaveCount(0);
});

test("a read that never reaches the service says that instead of blaming the mine", async ({ page }) => {
  // A dropped connection has no status to report, so the panel has only the browser's own reason to
  // repeat - which is still more than "unavailable right now" told the player.
  await page.route("**/api/notifications", (route) => route.abort("failed"));

  await startSignedIn(page);
  await page.locator("button.notifications-bell").click();

  const notice = page.locator(".notifications-menu .notifications-notice");
  await expect(notice).toBeVisible();
  await expect(notice).toContainText("Notifications could not be loaded.");
  await expect(notice).toContainText("never reached the service");
});
