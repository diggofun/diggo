/**
 * Runs an API call that needs a wallet session, signing in once when the session is missing. Used
 * by dialogs that live outside the header's own sign-in flow (adding a coin, boosting a mine).
 */
import bs58 from "bs58";
import { ApiError, getChallenge, verifyWallet } from "./api";

export interface SessionWallet {
  address: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export async function signInWallet(wallet: SessionWallet): Promise<void> {
  const challenge = await getChallenge(wallet.address);
  const signature = await wallet.signMessage(new TextEncoder().encode(challenge.message));
  await verifyWallet(wallet.address, challenge.nonce, bs58.encode(signature), null);
}

export async function withWalletSession<T>(wallet: SessionWallet | null, action: () => Promise<T>, onSigningIn?: () => void): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 401 || !wallet) throw error;
    onSigningIn?.();
    await signInWallet(wallet);
    return action();
  }
}

/** Retries `action` while the Worker answers 425 (a transaction it cannot see yet). */
export async function untilConfirmed<T>(action: () => Promise<T>, attempts = 20, delayMs = 3_000): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 425 || attempt >= attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
