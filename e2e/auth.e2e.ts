/**
 * Sign-in: the Wallet Standard handshake the rest of the suite depends on.
 *
 * The header's "Sign in" button signs the Worker's one-use challenge (/api/auth/challenge) with the
 * connected wallet and exchanges it for a session cookie (/api/auth/verify). The second half of the
 * test reloads the page to prove the session is the Worker's HttpOnly cookie plus the wallet's own
 * silent reconnect, not React state.
 */
import { expect, test } from "@playwright/test";
import { shortAddress, wallet } from "./fixtures/wallet";
import { connectMockWallet, headerWallet, signInWithWallet, signedInButton } from "./support/app";
import { MOCK_WALLET_NAME, installMockWallet } from "./support/mockWallet";

test.beforeEach(async ({ page }) => {
  await installMockWallet(page);
});

test("a Wallet Standard wallet connects, signs in, and keeps its session across a reload", async ({ page }) => {
  await page.goto("/");

  // Disconnected: the header offers the connect menu, which lists the injected wallet.
  await connectMockWallet(page);
  await expect(headerWallet(page).getByRole("button", { name: "Sign in", exact: true })).toBeVisible();

  await signInWithWallet(page);
  await expect(signedInButton(page)).toHaveAttribute("title", /Your account/);
  await expect(signedInButton(page)).toHaveText(shortAddress(wallet.address));

  // The session survives a full reload: cookie plus the wallet's silent reconnect.
  await page.reload();
  await expect(signedInButton(page)).toHaveText(shortAddress(wallet.address));
  await expect(page.getByRole("button", { name: MOCK_WALLET_NAME })).toHaveCount(0);
});
