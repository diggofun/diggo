/**
 * The one Reown network definition this app uses, re-exported so the bundler can drop the rest.
 *
 * `@reown/appkit/networks` is a barrel (`export * from '../src/networks/index.js'`) that carries
 * every chain Reown knows about — close to a megabyte of chain metadata. A *dynamic* import of that
 * barrel keeps the whole module, because the namespace is what gets loaded; importing
 * a single network from it at runtime still ships everything else alongside.
 *
 * Re-exporting the single name from a module of our own gives the bundler a static import it can
 * tree-shake, so the lazily loaded WalletConnect chunk contains only the mainnet definition that
 * src/walletConnect.ts actually passes to `createAppKit`. Nothing else may be added here: every
 * extra export is weight on a path that is only downloaded when a player picks WalletConnect.
 */
export const solanaMainnet = {
  id: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  name: "Solana",
  network: "solana-mainnet",
  nativeCurrency: { name: "Solana", symbol: "SOL", decimals: 9 },
  rpcUrls: { default: { http: ["/api/rpc"] } },
  blockExplorers: { default: { name: "Solscan", url: "https://solscan.io" } },
  testnet: false,
  chainNamespace: "solana",
  caipNetworkId: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  deprecatedCaipNetworkId: "solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ",
} as const;
