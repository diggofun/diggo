/**
 * WalletConnect (Reown AppKit) support — loaded on demand, never in the main bundle.
 *
 * Pairing a WalletConnect-compatible Solana wallet over a QR code is the minority path: Wallet
 * Standard detection (src/solana.ts) already covers browser extensions and most mobile in-app
 * browsers. AppKit drags in the WalletConnect relay client and its whole UI kit, by far the
 * heaviest dependency in the frontend, so this module deliberately imports none of it at module
 * scope. src/wallet.ts reads the small store below through useSyncExternalStore, and
 * ensureWalletConnect() pulls the AppKit chunk the first time a player actually picks
 * WalletConnect.
 *
 * The Project ID below is a public identifier, not a secret — it only tells Reown's relay which
 * app is connecting, the same way an OAuth client ID works, so it's safe to ship in the frontend
 * bundle. Free tier limits: docs/ARCHITECTURE.md.
 *
 * createAppKit() must run exactly once per page (per Reown's own requirement — calling it twice
 * reinitializes the modal), which the module-level promise below guarantees even when two clicks
 * race while the chunk is still downloading.
 */
import type { AppKit } from "@reown/appkit/react";
import type { Provider as WalletConnectSolanaProvider } from "@reown/appkit-adapter-solana/react";

export const WALLETCONNECT_PROJECT_ID = "8efc42ac085298e7bf198ca5679b7e29";

/** Key prefixes AppKit and the WalletConnect client leave in localStorage once a wallet paired. */
const PAIRED_STORAGE_MARKERS = ["wc@2:", "@appkit"] as const;

/** What src/wallet.ts needs from a paired wallet: its address and the signing provider. */
export interface WalletConnectSession {
  address: string;
  provider: WalletConnectSolanaProvider;
}

let session: WalletConnectSession | null = null;
const listeners = new Set<() => void>();

/** Snapshot for useSyncExternalStore: the same object until the session genuinely changes. */
export function getWalletConnectSession(): WalletConnectSession | null {
  return session;
}

/** Subscribe to paired-wallet changes; the AppKit chunk publishes into this store once loaded. */
export function subscribeWalletConnect(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: WalletConnectSession | null): void {
  if (next?.address === session?.address && next?.provider === session?.provider) return;
  session = next;
  for (const listener of listeners) listener();
}

let appKitRequest: Promise<AppKit> | null = null;

/**
 * Loads the AppKit chunk and creates the modal once. Every caller shares one promise, so the
 * modal exists at most once no matter how many components ask for it.
 */
export function ensureWalletConnect(): Promise<AppKit> {
  appKitRequest ??= createWalletConnect().catch((error: unknown) => {
    // A failed download must not poison every later attempt: the next click retries.
    appKitRequest = null;
    throw error;
  });
  return appKitRequest;
}

/**
 * Opens the QR/connect modal, fetching the AppKit chunk first when this is the first use. Returns
 * false when the chunk could not be loaded, so the caller can say so instead of doing nothing.
 */
export async function openWalletConnect(): Promise<boolean> {
  try {
    const appKit = await ensureWalletConnect();
    await appKit.open({ view: "Connect", namespace: "solana" });
    return true;
  } catch {
    return false;
  }
}

/** Disconnects a paired WalletConnect wallet; a no-op when the chunk was never loaded. */
export async function disconnectWalletConnect(): Promise<void> {
  try {
    const appKit = await appKitRequest;
    if (appKit) await appKit.disconnect("solana");
  } catch {
    // Nothing to disconnect if the chunk never loaded or the modal failed to start.
  }
}

async function createWalletConnect(): Promise<AppKit> {
  const [{ createAppKit }, { SolanaAdapter }, { solanaMainnet }] = await Promise.all([
    import("@reown/appkit/react"),
    import("@reown/appkit-adapter-solana/react"),
    // Not "@reown/appkit/networks" directly: that barrel carries every chain Reown knows about, and
    // a dynamic import of it keeps the whole thing (a dedicated ~520 kB chunk). src/appkitNetworks.ts
    // re-exports only devnet so the rest is tree-shaken out.
    import("./appkitNetworks"),
  ]);

  const appKit = createAppKit({
    adapters: [new SolanaAdapter()],
    networks: [solanaMainnet],
    defaultNetwork: solanaMainnet,
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

  // Mirror AppKit's account and provider state into the store src/wallet.ts reads. Reading fresh
  // state on every notification keeps this independent of AppKit's own payload shape, and covers
  // the provider arriving just after (or just before) the account.
  const sync = () => syncSession(appKit);
  appKit.subscribeAccount(sync, "solana");
  appKit.subscribeProviders(sync);
  sync();

  return appKit;
}

function syncSession(appKit: AppKit): void {
  const account = appKit.getAccount("solana");
  if (!account?.isConnected || !account.address) {
    publish(null);
    return;
  }
  const provider = appKit.getProvider<WalletConnectSolanaProvider>("solana");
  publish(provider ? { address: account.address, provider } : null);
}

/**
 * A player who paired over WalletConnect before has that session in localStorage, and only
 * createAppKit() itself can restore it. Restoring once the browser goes idle keeps returning
 * players signed in without putting AppKit back on the critical path. Players who have never used
 * WalletConnect download nothing.
 */
export function preloadPairedWalletConnect(): void {
  if (typeof window === "undefined" || !hasPairedBefore()) return;
  const start = () => {
    void ensureWalletConnect().catch(() => {
      // A failed restore is not worth surfacing: the Connect wallet button retries on demand.
    });
  };
  const idle = window.requestIdleCallback?.bind(window);
  if (idle) idle(start, { timeout: 4_000 });
  else window.setTimeout(start, 2_000);
}

function hasPairedBefore(): boolean {
  try {
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (key && PAIRED_STORAGE_MARKERS.some((marker) => key.startsWith(marker))) return true;
    }
  } catch {
    // Blocked or unavailable storage (private mode, partitioned iframe): skip the preload.
  }
  return false;
}

// Runs once when src/App.tsx imports this module, and only ever fetches the chunk for a browser
// that has paired over WalletConnect before.
preloadPairedWalletConnect();
