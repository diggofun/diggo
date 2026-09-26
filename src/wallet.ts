/**
 * The one wallet hook every screen uses.
 *
 * Unifies the two ways a player can connect: a Wallet Standard extension (desktop, most mobile
 * in-app browsers — see src/solana.ts) or a WalletConnect-paired wallet via QR code (see
 * src/walletConnect.ts, for browsers with no extension to detect at all). Every component talks to
 * this hook instead of either underlying SDK directly, so on-chain actions and message-signing work
 * identically regardless of which path the player used to connect.
 *
 * This file never imports @reown/appkit: WalletConnect state arrives through the tiny
 * useSyncExternalStore-backed store in src/walletConnect.ts, so the AppKit chunk stays out of the
 * main bundle and is fetched only when a player picks WalletConnect. Only the *type* of
 * DiggoWallet comes from src/solanaProgram.ts, so the program client (and @solana/web3.js behind
 * it) stays in the lazily loaded chunks that actually send transactions.
 */
import { address } from "@solana/kit";
import { useConnectedWallet, useSignMessage } from "@solana/kit-plugin-wallet/react";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { solanaClient } from "./solana";
import type { DiggoWallet } from "./solanaProgram";
import { getWalletConnectSession, subscribeWalletConnect } from "./walletConnect";

export interface ConnectedDiggoWallet {
  kind: "kit" | "walletconnect";
  /** Base58 wallet address — always a plain string, unlike @solana/kit's branded Address. */
  address: string;
  /** Pass this to src/solanaProgram.ts on-chain actions (buyOnChain, assignPowerOnChain, …). */
  wallet: DiggoWallet;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
}

export function useDiggoWallet(): ConnectedDiggoWallet | null {
  const standard = useConnectedWallet(solanaClient);
  const standardSignMessage = useSignMessage(solanaClient);
  const walletConnect = useSyncExternalStore(
    subscribeWalletConnect,
    getWalletConnectSession,
    getWalletConnectSession,
  );

  /**
   * The returned connection is memoized on the values that actually identify it — the address, the
   * signer, and the WalletConnect session — and never on the hook results themselves. `useSignMessage`
   * and the AppKit store both hand back wrapper objects, and depending on those directly gave every
   * consumer a new `connected` object on every render. That in turn changed the identity of every
   * callback and effect that listed `connected` as a dependency, so src/App.tsx refetched
   * /api/player/:wallet, /api/rewards and /api/discoveries on every render until React aborted with
   * "Maximum update depth exceeded".
   *
   * `signMessage` still has to reach the newest dispatch function, so the action handle is kept in a
   * ref and read when the closure actually runs. Handlers only ever call it after a commit, which is
   * also why the ref is updated from an effect rather than during render.
   */
  const latestSignMessage = useRef(standardSignMessage);
  useEffect(() => {
    latestSignMessage.current = standardSignMessage;
  });

  const standardSigner = standard?.signer ?? null;
  const standardAddress = standardSigner && standard ? String(standard.account.address) : null;

  return useMemo((): ConnectedDiggoWallet | null => {
    if (standardSigner && standardAddress) {
      return {
        kind: "kit",
        address: standardAddress,
        wallet: standardSigner,
        signMessage: (message) => latestSignMessage.current.dispatchAsync(message),
      };
    }
    if (walletConnect) {
      return {
        kind: "walletconnect",
        address: walletConnect.address,
        wallet: {
          kind: "walletconnect",
          address: address(walletConnect.address),
          provider: walletConnect.provider,
        },
        signMessage: (message) => walletConnect.provider.signMessage(message),
      };
    }
    return null;
  }, [standardAddress, standardSigner, walletConnect]);
}

/** Event the header's wallet control listens for, so any "Connect wallet" CTA can open it. */
export const OPEN_WALLET_EVENT = "diggo:open-wallet";

/** Opens the header's wallet menu. `location` names the CTA for analytics (wallet_connect_clicked). */
export function requestWalletMenu(location: string): void {
  window.dispatchEvent(new CustomEvent<{ location: string }>(OPEN_WALLET_EVENT, { detail: { location } }));
}
