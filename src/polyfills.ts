import { Buffer } from "buffer";

/**
 * The Meteora DBC SDK and @solana/web3.js call Node's global `Buffer` at runtime (for example
 * when deriving a pool PDA in the swap panel). Browsers have no such global, so install the
 * `buffer` package's implementation before any of that code runs. This module must be the first
 * import of the app entry.
 */
export function installBufferGlobal(target: { Buffer?: unknown } = globalThis as { Buffer?: unknown }): void {
  if (typeof target.Buffer === "undefined") target.Buffer = Buffer;
}

installBufferGlobal();
