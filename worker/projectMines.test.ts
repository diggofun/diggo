import { describe, expect, it } from "vitest";
import type { MeteoraTransaction } from "./meteora/rpc";
import { depositFromTransaction } from "./projectMines";

const MINT = "So11111111111111111111111111111111111111112";
const OTHER_MINT = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const WALLET = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const STRANGER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const VAULT = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const WALLET_ATA = "WalletAta1111111111111111111111111111111111";
const VAULT_ATA = "VaultAta11111111111111111111111111111111111";
const expected = { mint: MINT, wallet: WALLET, vaultAccount: VAULT_ATA };

/** A transfer of `amount` from `from` (owned by `owner`) into the vault account. */
function transfer(amount: bigint, overrides: Partial<MeteoraTransaction> = {}, owner = WALLET, mint = MINT): MeteoraTransaction {
  return {
    signature: "sig", slot: 1n, blockTime: 1, failed: false, signatures: ["sig"], instructions: [], logs: [],
    accountKeys: [owner, WALLET_ATA, VAULT_ATA],
    preTokenBalances: [
      { accountIndex: 1, mint, owner, amount: "1000" },
      { accountIndex: 2, mint, owner: VAULT, amount: "50" },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint, owner, amount: (1000n - amount).toString() },
      { accountIndex: 2, mint, owner: VAULT, amount: (50n + amount).toString() },
    ],
    ...overrides,
  };
}

describe("depositFromTransaction", () => {
  it("counts exactly what moved from the wallet into the vault", () => {
    expect(depositFromTransaction(transfer(400n), expected)).toBe(400n);
  });

  it("counts a deposit that created the vault's account in the same transaction", () => {
    const created = transfer(400n);
    created.preTokenBalances = created.preTokenBalances.filter((row) => row.accountIndex !== 2);
    created.postTokenBalances = created.postTokenBalances.map((row) => row.accountIndex === 2 ? { ...row, amount: "400" } : row);
    expect(depositFromTransaction(created, expected)).toBe(400n);
  });

  it("refuses someone else's deposit", () => {
    expect(depositFromTransaction(transfer(400n, {}, STRANGER), expected)).toBeNull();
  });

  it("refuses a failed transaction, another coin, and a transfer to another account", () => {
    expect(depositFromTransaction(transfer(400n, { failed: true }), expected)).toBeNull();
    expect(depositFromTransaction(transfer(400n, {}, WALLET, OTHER_MINT), expected)).toBeNull();
    expect(depositFromTransaction(transfer(400n), { ...expected, vaultAccount: "Elsewhere111111111111111111111111111111111" })).toBeNull();
  });

  it("refuses when the vault grew by more than the wallet paid in", () => {
    // Someone else's tokens landing in the vault in the same transaction cannot be claimed.
    const padded = transfer(400n);
    padded.postTokenBalances = padded.postTokenBalances.map((row) => row.accountIndex === 2 ? { ...row, amount: "1450" } : row);
    expect(depositFromTransaction(padded, expected)).toBeNull();
  });

  it("refuses a transaction where nothing reached the vault", () => {
    expect(depositFromTransaction(transfer(0n), expected)).toBeNull();
  });
});
