/**
 * The one Reown network definition this app uses, re-exported so the bundler can drop the rest.
 *
 * `@reown/appkit/networks` is a barrel (`export * from '../src/networks/index.js'`) that carries
 * every chain Reown knows about — close to a megabyte of chain metadata. A *dynamic* import of that
 * barrel keeps the whole module, because the namespace is what gets loaded; importing
 * `{ solanaDevnet }` from it at runtime still ships everything else alongside.
 *
 * Re-exporting the single name from a module of our own gives the bundler a static import it can
 * tree-shake, so the lazily loaded WalletConnect chunk contains only the devnet definition that
 * src/walletConnect.ts actually passes to `createAppKit`. Nothing else may be added here: every
 * extra export is weight on a path that is only downloaded when a player picks WalletConnect.
 */
export { solanaDevnet } from "@reown/appkit/networks";
