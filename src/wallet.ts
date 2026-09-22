/**
 * The one wallet hook every screen uses.
 *
 * Unifies the two ways a player can connect: a Wallet Standard extension (desktop, most mobile
 * in-app browsers — see src/solana.ts) or a WalletConnect-paired wallet via QR code (see
 * src/walletConnect.ts, for browsers with no extension to detect at all). Every component talks to
 * this hook instead of either underlying SDK directly, so on-chain actions and message-signing work
 * identically regardless of which path the player used to connect.
 *
 * It imports `address` from @solana/kit and only the *type* of DiggoWallet from
 * src/solanaProgram.ts, so the program client (and @solana/web3.js behind it) stays in the lazily
 * loaded chunks that actually send transactions.
 */
import { address } from "@solana/kit";
import { useConnectedWallet, useSignMessage } from "@solana/kit-plugin-wallet/react";
import { useAppKitAccount, useAppKitProvider } from "@reown/appkit/react";
import type { Provider as WalletConnectSolanaProvider } from "@reown/appkit-adapter-solana/react";
import { solanaClient } from "./solana";
import type { DiggoWallet } from "./solanaProgram";

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
  const wcAccount = useAppKitAccount({ namespace: "solana" });
  const { walletProvider: wcProvider } = useAppKitProvider<WalletConnectSolanaProvider>("solana");

  if (standard?.signer) {
    return {
      kind: "kit",
      address: String(standard.account.address),
      wallet: standard.signer,
      signMessage: (message) => standardSignMessage.dispatchAsync(message),
    };
  }
  if (wcAccount.isConnected && wcAccount.address && wcProvider) {
    const wcAddress = wcAccount.address;
    return {
      kind: "walletconnect",
      address: wcAddress,
      wallet: { kind: "walletconnect", address: address(wcAddress), provider: wcProvider },
      signMessage: (message) => wcProvider.signMessage(message),
    };
  }
  return null;
}

/** Event the header's wallet control listens for, so any "Connect wallet" CTA can open it. */
export const OPEN_WALLET_EVENT = "diggo:open-wallet";

export function requestWalletMenu(): void {
  window.dispatchEvent(new CustomEvent(OPEN_WALLET_EVENT));
}
