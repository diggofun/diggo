/**
 * The signed-in header: the room it has at each width, and the stacking it shares with the consent
 * notice.
 *
 * The header is the one band every page shares, and it is a single row at every width. So a control
 * that leaves the band - pushed past the right edge by a row that does not fit - is a control a
 * player cannot reach, and the page scrolls sideways under it. The first test pins that at the
 * widths the shell is used at, and keeps every control named the way a screen reader reads it.
 *
 * The second test covers the stacking: the notice is fixed at z-index 95 and the header is a
 * stacking context at 80, so a popover hanging off the header was painted underneath the notice in
 * the corner the card occupies. It only showed up once the alert list was long enough to reach that
 * corner - with a handful of alerts the panel and the card miss each other by five pixels - so the
 * test opens a full panel on a window short enough for the two of them to meet.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { signedInButton, startSignedIn } from "./support/app";
import { installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

/** How much wider the document is than the viewport. */
function pageOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

/** Points inside the element's own box that answer with something else, i.e. that something covers. */
function coveredPoints(target: Locator): Promise<string[]> {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const covered: string[] = [];
    for (let across = 0.1; across <= 0.95; across += 0.2) {
      for (let down = 0.05; down <= 0.98; down += 0.15) {
        const x = Math.round(box.left + box.width * across);
        const y = Math.round(box.top + box.height * down);
        const hit = document.elementFromPoint(x, y);
        if (hit === null || !element.contains(hit)) {
          covered.push(x + "," + y + " -> " + (hit === null ? "nothing" : hit.className || hit.tagName));
        }
      }
    }
    return covered;
  });
}

/**
 * What became of the consent notice: out of the document, stepped aside while an overlay is up, up
 * and answerable, or up but covered. The last one is the state that may never happen - a notice whose
 * buttons cannot be reached is a notice that cannot be answered.
 */
function noticeState(page: Page): Promise<string> {
  return page.evaluate(() => {
    const notice = document.querySelector<HTMLElement>(".consent-banner");
    if (notice === null) return "absent";
    if (getComputedStyle(notice).display === "none") return "stepped aside";
    const actions = [
      notice.querySelector<HTMLElement>(".consent-actions .btn"),
      notice.querySelector<HTMLElement>(".consent-dismiss"),
    ];
    const blocked = actions.some((action) => {
      if (action === null) return true;
      const box = action.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return hit === null || !(hit === action || action.contains(hit));
    });
    return blocked ? "covered" : "reachable";
  });
}

function headerZ(page: Page): Promise<string> {
  return page.locator("header.site-header").evaluate((element) => getComputedStyle(element).zIndex);
}

/** The elements in the header that are outside the viewport, by class. */
function outsideHeader(page: Page): Promise<string[]> {
  return page.locator("header.site-header *").evaluateAll((nodes) =>
    nodes
      .filter((node) => {
        const box = node.getBoundingClientRect();
        return (
          box.width > 0 &&
          (box.right > document.documentElement.clientWidth + 0.5 || box.left < -0.5)
        );
      })
      .map((node) => (typeof node.className === "string" ? node.className : node.tagName)),
  );
}

test("the signed-in header holds every control inside the viewport", async ({ page }) => {
  await startSignedIn(page);

  for (const [width, height] of [[1280, 800], [820, 900], [640, 800], [390, 844], [360, 800]] as const) {
    await page.setViewportSize({ width, height });

    expect(await pageOverflow(page), "page overflow at " + width + "px").toBe(0);
    expect(await outsideHeader(page), "header elements outside the viewport at " + width + "px").toEqual([]);

    // Every control a signed-in header carries, addressed the way a player reads it. The queries stay
    // inside the header because the footer carries a brand link of its own with the same name. The wallet
    // button keeps its name through the 820px rule that clips the label, and the brand link keeps
    // its own name below 480px where the wordmark yields to the glyph.
    const header = page.locator("header.site-header");
    const brand = header.getByRole("link", { name: "Diggo.fun home" });
    const bell = header.getByRole("button", { name: /notifications/i });
    const disconnect = header.getByRole("button", { name: "Disconnect wallet" });
    const disclosure = header.getByRole("button", { name: /^(Set username|Public username)$/ });
    const summary = header.getByLabel("Wallet summary");

    await expect(signedInButton(page), "wallet button at " + width + "px").toBeVisible();
    await expect(brand, "brand at " + width + "px").toBeVisible();
    await expect(bell, "bell at " + width + "px").toBeVisible();
    await expect(disconnect, "disconnect at " + width + "px").toBeVisible();
    await expect(disclosure, "username disclosure at " + width + "px").toBeVisible();
    // The drawer button belongs to the widths where the navigation is a drawer.
    await expect(
      header.getByRole("button", { name: "Open navigation" }),
      "drawer button at " + width + "px",
    ).toBeVisible({ visible: width <= 1180 });
    // The wallet readout is not a control, but it is what the row was squeezing out first.
    await expect(summary, "wallet summary at " + width + "px").toBeVisible();

    // Nothing is stacked over a control: each one answers for every point in its own box, so a
    // control that is squeezed under a neighbour fails here rather than looking merely cramped.
    for (const [name, control] of [
      ["wallet button", signedInButton(page)],
      ["disconnect", disconnect],
      ["username disclosure", disclosure],
      ["bell", bell],
      ["brand", brand],
    ] as const) {
      expect(await coveredPoints(control), name + " at " + width + "px").toEqual([]);
    }
  }
});

/** An alert list long enough to fill the panel to its own maximum height. */
function fullAlertList(): string {
  const now = Math.floor(Date.now() / 1_000);
  return JSON.stringify({
    notifications: Array.from({ length: 14 }, (_, index) => ({
      id: index + 1,
      kind: index % 2 === 0 ? "MINE_EXPIRES_3H" : "RARE_DISCOVERY_FOUND",
      payload: { mine: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", window: "3h" },
      createdAt: now - index * 600,
      readAt: index < 3 ? null : now - 60,
    })),
    unread: 3,
    total: 14,
  });
}

test("an open alerts panel is painted above the consent notice, which is never left covered", async ({ page }) => {
  await page.route("**/api/notifications", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: fullAlertList() }),
  );
  await startSignedIn(page);
  // Short enough for a full panel to reach the corner the notice anchors to.
  await page.setViewportSize({ width: 1280, height: 700 });

  const bell = page.locator("button.notifications-bell");
  const menu = page.locator(".notifications-menu");
  const notice = page.locator(".consent-banner");

  // A first visit has no recorded decision, so the card is up and answerable before anything opens.
  await expect(notice).toBeVisible();
  expect(await noticeState(page)).toBe("reachable");
  expect(await headerZ(page)).toBe("80");

  await bell.click();
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Crew notifications")).toBeVisible();

  // The panel owns every point inside its own box, including the corner the notice sits in.
  expect(await coveredPoints(menu)).toEqual([]);
  // And the notice is not up but unreachable: it stands down while the popover is open.
  expect(await noticeState(page)).not.toBe("covered");
  // The header's own layering only lifts while a popover is open.
  expect(await headerZ(page)).toBe("96");

  await bell.click();
  await expect(menu).toBeHidden();
  expect(await headerZ(page)).toBe("80");

  // Stepping aside decides nothing: the card comes back with both options.
  await expect(notice).toBeVisible();
  expect(await noticeState(page)).toBe("reachable");
  await expect(notice.getByRole("button", { name: "Allow analytics" })).toBeEnabled();
  await expect(notice.getByRole("button", { name: "Essential only" })).toBeEnabled();
});

test("the wallet menu and the navigation drawer stand the notice down the same way", async ({ page }) => {
  await startSignedIn(page);
  await page.setViewportSize({ width: 1280, height: 700 });

  // The username menu hangs off the header's disclosure and covers the same corner the card does on
  // a window this short.
  await page.getByRole("button", { name: /^(Set username|Public username)$/ }).click();
  const menu = page.locator("header .wallet-menu");
  await expect(menu).toBeVisible();
  expect(await coveredPoints(menu)).toEqual([]);
  expect(await noticeState(page)).not.toBe("covered");
  expect(await headerZ(page)).toBe("96");

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  expect(await noticeState(page)).toBe("reachable");

  // The drawer reaches the bottom of the page, so the card sat on its shortcut rows.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const drawer = page.locator(".app-sidebar.is-open");
  await expect(drawer).toBeVisible();
  // It slides in, so the measurements below wait for it to arrive rather than sampling the slide.
  await expect.poll(async () => (await drawer.boundingBox())?.x ?? -1, { message: "drawer slid in" }).toBe(0);
  // The shortcut rows sit at the end of the drawer's own scroll range, and the drawer now ends
  // above the tab bar, so they can be scrolled clear of both the bar and the notice.
  await drawer.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  expect(await noticeState(page)).not.toBe("covered");
  await expect(page.locator(".sidebar-profile")).toBeVisible();
  expect(await coveredPoints(page.locator(".sidebar-profile"))).toEqual([]);
  expect(await coveredPoints(page.locator(".sidebar-shortcuts"))).toEqual([]);

  await page.getByRole("button", { name: "Close navigation" }).first().click();
  await expect(page.locator(".app-sidebar.is-open")).toBeHidden();
  expect(await noticeState(page)).toBe("reachable");
});
