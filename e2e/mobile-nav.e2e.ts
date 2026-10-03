/**
 * The phone layout (below 760px): the header carries no navigation of its own any more, so the full
 * destination list lives in the off-canvas drawer behind "Open navigation", and the five game
 * shortcuts move to the thumb-reachable tab bar. Both have to actually navigate.
 *
 * The drawer is the part that catches people out. The panel is mounted at every width and merely
 * translated off-canvas, so a shut drawer still answers a visibility check - its closed state is the
 * `is-open` class, which is also what the styles key the slide and the consent notice off. Every
 * query below is scoped to the drawer or the bar, because both carry a link named "Home", "Mine" and
 * "Explore coins".
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installMockWallet } from "./support/mockWallet";
test.use({ viewport: { width: 390, height: 844 } });

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

/** The five shortcuts the tab bar carries, in the order it lays them out. */
const TAB_SHORTCUTS = ["Home", "Mine", "Crew", "Discoveries", "Explore coins"] as const;

/** Opens the drawer and waits for the slide to settle, so callers measure a panel at rest. */
async function openDrawer(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.locator(".app-sidebar.is-open");
  await expect(drawer).toBeVisible();
  await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1, { message: "drawer slid in" }).toBe(0);
  return drawer;
}

test("the tab bar carries the five game shortcuts and they navigate", async ({ page }) => {
  await page.goto("/");

  const tabBar = page.locator(".tab-bar");
  await expect(tabBar).toBeVisible();
  for (const label of TAB_SHORTCUTS) {
    await expect(tabBar.getByRole("link", { name: label, exact: true })).toBeVisible();
  }

  // The desktop navigation has left the header altogether, so on a phone the drawer and the bar are
  // the only ways to a destination - and the bar is the one that is on screen to begin with.
  await expect(page.locator("header.site-header nav")).toHaveCount(0);
  await expect(page.locator(".app-sidebar")).not.toHaveClass(/is-open/);
  await expect(page.locator(".sidebar-toggle")).toHaveAttribute("aria-expanded", "false");

  await tabBar.getByRole("link", { name: "Mine", exact: true }).click();
  await expect(page).toHaveURL(/\/mine$/);
  await expect(page.getByRole("heading", { level: 1, name: /your crew/i })).toBeVisible();
  // With the drawer shut, the bar is the only thing that can say where the player landed.
  await expect(tabBar.getByRole("link", { name: "Mine", exact: true })).toHaveAttribute("aria-current", "page");
});

test("the drawer holds the destinations the tab bar leaves out, and they navigate", async ({ page }) => {
  await page.goto("/");

  const drawer = await openDrawer(page);
  await expect(drawer).toHaveAttribute("aria-label", "Main navigation");
  for (const label of ["Leaderboards", "$DIGGO", "Referrals", "Settings", "Watchlist"]) {
    await expect(drawer.getByRole("link", { name: label, exact: true })).toBeVisible();
  }
  await expect(drawer.getByRole("button", { name: "Create coin", exact: true })).toBeVisible();

  await drawer.getByRole("link", { name: "Leaderboards", exact: true }).click();
  await expect(page).toHaveURL(/\/leaderboards$/);
  await expect(page.getByRole("heading", { level: 2, name: /top of/i })).toBeVisible();
  // Following a drawer link is a real page load, so the panel is shut again on arrival.
  await expect(page.locator(".app-sidebar.is-open")).toHaveCount(0);

  // Leaderboards is not one of the five shortcuts, so the drawer is the only navigation that can
  // mark it as the page the player is on.
  const reopened = await openDrawer(page);
  await expect(reopened.getByRole("link", { name: "Leaderboards", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("the drawer closes from its own button, Escape, and a tap on the backdrop", async ({ page }) => {
  await page.goto("/");

  const closed = page.locator(".app-sidebar.is-open");

  // "Close navigation" names two controls while the drawer is open - the panel's own button and the
  // backdrop - so the button is addressed inside the panel.
  const drawer = await openDrawer(page);
  await drawer.getByRole("button", { name: "Close navigation" }).click();
  await expect(closed).toHaveCount(0);

  await openDrawer(page);
  await page.keyboard.press("Escape");
  await expect(closed).toHaveCount(0);

  // The backdrop answers the tap a phone player makes to get out, but its centre sits behind the
  // panel: a plain click lands on the drawer and never reaches it. Tap the strip the panel leaves.
  const reopened = await openDrawer(page);
  const panel = await reopened.boundingBox();
  if (panel === null) throw new Error("the open drawer has no box to measure");
  await page.locator(".sidebar-backdrop").click({ position: { x: panel.x + panel.width + 24, y: 300 } });
  await expect(closed).toHaveCount(0);
  await expect(page.locator(".sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
});
