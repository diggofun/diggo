import { describe, expect, it } from "vitest";
import type { MeteoraTransaction } from "./meteora/rpc";
import { depositFromTransaction, mineFee } from "./projectMines";
import type { RuntimeEnv } from "./env";
import { feeFor, feeLabel, splitDeposit } from "../shared/projectMineFee";

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
    expect(depositFromTransaction(transfer(400n), expected)).toEqual({ reserve: 400n, fee: 0n });
  });

  it("counts a deposit that created the vault's account in the same transaction", () => {
    const created = transfer(400n);
    created.preTokenBalances = created.preTokenBalances.filter((row) => row.accountIndex !== 2);
    created.postTokenBalances = created.postTokenBalances.map((row) => row.accountIndex === 2 ? { ...row, amount: "400" } : row);
    expect(depositFromTransaction(created, expected)).toEqual({ reserve: 400n, fee: 0n });
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

const FEE_ATA = "FeeAta111111111111111111111111111111111111";
const FEE_OWNER = "Fee1111111111111111111111111111111111111111";

/** One transaction: `reserve` to the vault and `fee` to the fee wallet, both out of the depositor's account. */
function withFee(reserve: bigint, fee: bigint): MeteoraTransaction {
  const base = transfer(reserve + fee);
  return {
    ...base,
    accountKeys: [...base.accountKeys, FEE_ATA],
    preTokenBalances: [...base.preTokenBalances, { accountIndex: 3, mint: MINT, owner: FEE_OWNER, amount: "0" }],
    postTokenBalances: base.postTokenBalances
      .map((row) => (row.accountIndex === 2 ? { ...row, amount: (50n + reserve).toString() } : row))
      .concat([{ accountIndex: 3, mint: MINT, owner: FEE_OWNER, amount: fee.toString() }]),
  };
}

describe("platform fee", () => {
  const withFeeExpected = { ...expected, feeAccount: FEE_ATA, feeBps: 200 };

  it("splits 2% of the deposit to the fee, rounded down", () => {
    expect(splitDeposit(1_000_000n, 200)).toEqual({ fee: 20_000n, reserve: 980_000n });
    expect(splitDeposit(49n, 200)).toEqual({ fee: 0n, reserve: 49n });
    expect(splitDeposit(1_000n, 0)).toEqual({ fee: 0n, reserve: 1_000n });
    expect(feeFor(1_000n, 5_000)).toBe(100n);
    expect(feeLabel(200)).toBe("2%");
    expect(feeLabel(150)).toBe("1.5%");
  });

  it("accepts a deposit that paid the fee, and opens the mine with the rest", () => {
    const { fee, reserve } = splitDeposit(1_000n, 200);
    expect(depositFromTransaction(withFee(reserve, fee), withFeeExpected)).toEqual({ reserve: 980n, fee: 20n });
  });

  it("refuses a deposit that skipped or underpaid the fee", () => {
    expect(depositFromTransaction(transfer(980n), withFeeExpected)).toBeNull();
    expect(depositFromTransaction(withFee(980n, 10n), withFeeExpected)).toBeNull();
    // 19 on a 999 deposit is exactly 2% rounded down, so it is a full fee.
    expect(depositFromTransaction(withFee(980n, 19n), withFeeExpected)).toEqual({ reserve: 980n, fee: 19n });
  });

  it("refuses a fee paid by somebody else", () => {
    const tx = withFee(980n, 20n);
    // The depositor only sent the reserve; the fee came from a third account.
    tx.postTokenBalances = tx.postTokenBalances.map((row) => (row.accountIndex === 1 ? { ...row, amount: "20" } : row));
    expect(depositFromTransaction(tx, withFeeExpected)).toBeNull();
  });

  it("reads the rate and wallet from the environment, with safe defaults", () => {
    expect(mineFee({} as RuntimeEnv)).toEqual({ bps: 200, wallet: "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ" });
    expect(mineFee({ PROJECT_MINE_FEE_BPS: "0" } as unknown as RuntimeEnv).bps).toBe(0);
    expect(mineFee({ PROJECT_MINE_FEE_BPS: "150" } as unknown as RuntimeEnv).bps).toBe(150);
    expect(mineFee({ PROJECT_MINE_FEE_BPS: "abc" } as unknown as RuntimeEnv).bps).toBe(200);
    expect(mineFee({ PROJECT_MINE_FEE_BPS: "5000" } as unknown as RuntimeEnv).bps).toBe(200);
    expect(mineFee({ PROJECT_MINE_FEE_WALLET: "nope" } as unknown as RuntimeEnv).wallet).toBe("6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ");
  });
});
