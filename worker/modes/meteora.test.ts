/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from "vitest";
import bs58 from "bs58";
import { deriveAssociatedTokenAddress } from "../meteora/rpc";
import * as rpc from "../meteora/rpc";
import { meteoraPayout } from "./meteora";

// A deterministic 32-byte vault address; the read never needs the matching secret.
const VAULT = bs58.encode(Uint8Array.from({ length: 32 }, (_, index) => (index * 7 + 3) % 256));
const MINT = "So11111111111111111111111111111111111111112";

/** A 165-byte SPL token account whose u64 amount is `amount`, as decodeTokenAccountAmount reads it. */
function tokenAccount(amount: bigint): Uint8Array {
  const data = new Uint8Array(165);
  // The amount is a little-endian u64 at offset 48.
  data.set([0, 0, 0, 0, 0, 0, 0, 0].map((_, index) => Number((amount >> BigInt(index * 8)) & 0xffn)), 48);
  return data;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("vault inventory proof", () => {
  it("reports the vault real token balance for a mint", async () => {
    const amount = 4_200n;
    vi.spyOn(rpc, "readAccount").mockResolvedValue({ pubkey: "ata", lamports: 1n, data: tokenAccount(amount), owner: "token" });
    const result = await meteoraPayout({ MINING_VAULT_PUBLIC_KEY: VAULT } as never).vaultInventory(MINT);
    expect(result).toEqual({ available: amount, account: deriveAssociatedTokenAddress(MINT, VAULT) });
  });

  it("treats a missing token account as a provable zero, not as unknown", async () => {
    // A pre-graduation mint has no vault ATA at all. That is a real, provable shortfall and must
    // be reportable as zero so the batch filter can hold the reward deterministically.
    vi.spyOn(rpc, "readAccount").mockResolvedValue(null);
    const result = await meteoraPayout({ MINING_VAULT_PUBLIC_KEY: VAULT } as never).vaultInventory(MINT);
    expect(result).toEqual({ available: 0n, account: deriveAssociatedTokenAddress(MINT, VAULT) });
  });

  it("returns unknown when the chain read fails, so a transient RPC error is not a shortfall", async () => {
    vi.spyOn(rpc, "readAccount").mockRejectedValue(new Error("rpc unavailable"));
    expect(await meteoraPayout({ MINING_VAULT_PUBLIC_KEY: VAULT } as never).vaultInventory(MINT)).toBeNull();
  });

  it("returns unknown when the token account cannot be decoded", async () => {
    vi.spyOn(rpc, "readAccount").mockResolvedValue({ pubkey: "ata", lamports: 1n, data: new Uint8Array(8), owner: "token" });
    expect(await meteoraPayout({ MINING_VAULT_PUBLIC_KEY: VAULT } as never).vaultInventory(MINT)).toBeNull();
  });

  it("returns unknown when no vault address is configured", async () => {
    const read = vi.spyOn(rpc, "readAccount");
    expect(await meteoraPayout({} as never).vaultInventory(MINT)).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});
