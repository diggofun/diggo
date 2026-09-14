/**
 * WalletConnect (Reown AppKit) support — lets a mobile browser with no Wallet Standard
 * extension pair with any WalletConnect-compatible Solana wallet via QR code, without
 * navigating away from this page. This is additive: Wallet Standard detection (src/solana.ts)
 * stays the primary, faster path whenever a browser extension is present.
 *
 * The Project ID below is a public identifier, not a secret — it only tells Reown's relay
 * which app is connecting, the same way an OAuth client ID works, so it's safe to ship in the
 * frontend bundle. Free tier limits: docs/ARCHITECTURE.md.
 *
 * createAppKit() must run exactly once, outside any React component (per Reown's own
 * requirement — calling it inside a component causes reinitialization on every render).
 */
import { createAppKit } from "@reown/appkit/react";
import { SolanaAdapter } from "@reown/appkit-adapter-solana/react";
import { solanaDevnet } from "@reown/appkit/networks";

export const WALLETCONNECT_PROJECT_ID = "8efc42ac085298e7bf198ca5679b7e29";

const solanaAdapter = new SolanaAdapter();

createAppKit({
  adapters: [solanaAdapter],
  networks: [solanaDevnet],
  defaultNetwork: solanaDevnet,
  projectId: WALLETCONNECT_PROJECT_ID,
  metadata: {
    name: "Diggo.fun",
    description: "Meme coins worth digging — launch, mine and trade on Solana.",
    url: typeof window !== "undefined" ? window.location.origin : "https://diggo.fun",
    icons: ["https://diggo.fun/favicon.svg"],
  },
  // Diggo has no embedded/custodial wallets, swaps or on-ramp — this modal exists solely to
  // pair an external wallet over WalletConnect, so everything else is switched off.
  features: {
    analytics: false,
    email: false,
    socials: false,
    swaps: false,
    onramp: false,
    send: false,
    receive: false,
    history: false,
  },
});
