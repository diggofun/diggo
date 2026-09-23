/**
 * A mock Wallet Standard wallet, injected into every page before the app boots.
 *
 * The app discovers wallets the standard way: @solana/kit-plugin-wallet calls @wallet-standard/app
 * getWallets(), which listens for "wallet-standard:register-wallet" and announces itself with
 * "wallet-standard:app-ready". This module registers both directions exactly like a real extension
 * does, so the connect menu, the header session and every signed action take the production code
 * path instead of a test-only shortcut.
 *
 * It advertises the two account features the app actually uses: solana:signMessage (sign-in,
 * activation, claims) and solana:signTransaction (the on-chain syncs behind switch/upgrade). Both
 * forward the bytes to Node through a Playwright binding, so the private key never enters the page.
 */
import type { Page } from "@playwright/test";
import { signMessageBytes, signTransactionBytes, wallet } from "../fixtures/wallet";

/** The name the connect menu shows; tests look for this button. */
export const MOCK_WALLET_NAME = "Diggo E2E Wallet";

const SIGN_MESSAGE_BINDING = "__diggoE2eSignMessage";
const SIGN_TRANSACTION_BINDING = "__diggoE2eSignTransaction";

/** Inline mark, so the connect menu renders the same shape a real wallet icon would. */
const WALLET_ICON =
  "data:image/svg+xml;base64," +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#151712"/><path d="M8 21l8-12 8 12z" fill="#d7ff3f"/></svg>',
  ).toString("base64");

interface InjectedWalletConfig {
  address: string;
  publicKey: number[];
  name: string;
  icon: string;
  signMessageBinding: string;
  signTransactionBinding: string;
}

/** Registers the mock wallet and wires its two signing features to Node. */
export async function installMockWallet(page: Page): Promise<void> {
  await page.exposeFunction(SIGN_MESSAGE_BINDING, (bytes: number[]) =>
    Array.from(signMessageBytes(Uint8Array.from(bytes))),
  );
  await page.exposeFunction(SIGN_TRANSACTION_BINDING, (bytes: number[]) =>
    Array.from(signTransactionBytes(Uint8Array.from(bytes))),
  );

  const config: InjectedWalletConfig = {
    address: wallet.address,
    publicKey: Array.from(wallet.publicKey),
    name: MOCK_WALLET_NAME,
    icon: WALLET_ICON,
    signMessageBinding: SIGN_MESSAGE_BINDING,
    signTransactionBinding: SIGN_TRANSACTION_BINDING,
  };

  await page.addInitScript(injectMockWallet, config);
}

/** Runs in the page. It may only read its argument: Playwright serializes this function. */
function injectMockWallet(config: InjectedWalletConfig): void {
  const chains: string[] = ["solana:devnet"];
  const bindings = window as unknown as Record<string, ((input: number[]) => Promise<number[]>) | undefined>;

  const signWith = async (binding: string, bytes: number[]): Promise<Uint8Array> => {
    const call = bindings[binding];
    if (typeof call !== "function") throw new Error("E2E wallet: missing signing binding " + binding);
    return Uint8Array.from(await call(bytes));
  };

  const account = {
    address: config.address,
    publicKey: Uint8Array.from(config.publicKey),
    chains,
    features: ["solana:signMessage", "solana:signTransaction"],
  };
  type Account = typeof account;
  type ChangeListener = (change: { accounts: readonly Account[] }) => void;

  const listeners = new Set<ChangeListener>();
  const emit = (change: { accounts: readonly Account[] }): void => {
    for (const listener of Array.from(listeners)) {
      try {
        listener(change);
      } catch {
        // One failing listener must not break the wallet, exactly as the standard requires.
      }
    }
  };

  const mockWallet = {
    version: "1.0.0",
    name: config.name,
    icon: config.icon,
    chains,
    accounts: [account],
    features: {
      "standard:connect": {
        // A mock has no approval UI, so a silent reconnect (the plugin's page-reload path) resolves
        // the same way an interactive one does.
        connect: async (_input?: { silent?: boolean }) => {
          emit({ accounts: [account] });
          return { accounts: [account] };
        },
      },
      "standard:disconnect": {
        disconnect: async () => {
          emit({ accounts: [] });
        },
      },
      "standard:events": {
        on: (_event: string, listener: ChangeListener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      "solana:signMessage": {
        signMessage: async (...inputs: { message: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ message }) => ({
              signedMessage: message,
              signature: await signWith(config.signMessageBinding, Array.from(message)),
            })),
          ),
      },
      "solana:signTransaction": {
        supportedTransactionVersions: ["legacy", 0],
        signTransaction: async (...inputs: { transaction: Uint8Array }[]) =>
          Promise.all(
            inputs.map(async ({ transaction }) => ({
              signedTransaction: await signWith(config.signTransactionBinding, Array.from(transaction)),
            })),
          ),
      },
    },
  };

  const register = (api: { register: (...wallets: unknown[]) => unknown }): void => {
    api.register(mockWallet);
  };

  // Both directions of the handshake, so registration works whether the app or the wallet is first.
  try {
    window.dispatchEvent(new CustomEvent("wallet-standard:register-wallet", { detail: register }));
  } catch (error) {
    console.warn("E2E wallet: register-wallet dispatch failed", error);
  }
  try {
    window.addEventListener("wallet-standard:app-ready", (event) =>
      register((event as CustomEvent<{ register: (...wallets: unknown[]) => unknown }>).detail),
    );
  } catch (error) {
    console.warn("E2E wallet: app-ready listener failed", error);
  }
}
