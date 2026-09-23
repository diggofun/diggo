/**
 * User-signed mining claim confirmation tests (spec 53, 57).
 *
 * The endpoint's whole job is to refuse to record a payout it cannot prove and to record exactly
 * once the one it can, so these tests craft the transactions themselves: a real claim_rewards
 * instruction built with shared/program.ts, the token balances a real transfer leaves behind, and
 * then one thing wrong at a time. The chain read is injected, so nothing here touches an RPC.
 */
import { address } from "@solana/kit";
import bs58 from "bs58";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildClaimRewardsInstruction,
  deriveAssociatedTokenAddress,
  deriveMineAddresses,
  derivePositionPda,
} from "../../shared/program";
import {
  confirmRewardClaim,
  type ClaimTransactionReader,
  type RawClaimTransaction,
} from "../mining";
import { createSession, createTestHarness, type TestHarness } from "./d1-sqlite";

/** Structurally valid 32-byte addresses; nothing here depends on them being real accounts. */
function key(fill: number): string {
  return bs58.encode(new Uint8Array(32).fill(fill));
}
const PROGRAM_ID = key(9);
const MINT_A = key(1);
const MINT_B = key(2);
/** One wallet per test scenario, so the per-wallet rate limit is never shared between them. */
const WALLET_A = key(11);
const WALLET_B = key(12);
const WALLET_C = key(13);
const RAW = 10n ** 6n;
const CREDIT = 50n * RAW;
const START = 1_800_000_000;
/** Every crafted vault starts from the same balance so a delta is easy to read. */
const VAULT_BEFORE = 1_000n * RAW;
const OWNER_BEFORE = 7n * RAW;

let h: TestHarness;
let ipCounter = 0;

beforeEach(() => {
  h = createTestHarness();
  (h.env as unknown as { DIGGO_PROGRAM_ID?: string }).DIGGO_PROGRAM_ID = PROGRAM_ID;
});

afterEach(() => {
  h.d1.close();
});

interface CraftOptions {
  wallet: string;
  mint: string;
  /** Raw base units the transaction credited to the wallet's own token account. */
  creditRaw?: bigint;
  /** Raw base units the reserve vault gave up. Defaults to the credit, i.e. a conserved transfer. */
  debitRaw?: bigint;
  walletSigns?: boolean;
  /** Drop one account from the claim_rewards instruction, simulating a payout for elsewhere. */
  omitAccount?: string;
  /** Replace the instruction discriminator, simulating a different instruction entirely. */
  discriminator?: Uint8Array;
  failed?: boolean;
  /**
   * Unix seconds the transaction landed. Defaults to just after the claim settled, which is what a
   * real payout looks like; pass null to model an RPC that reports no block time at all.
   */
  blockTime?: number | null;
  /**
   * Move the accounts a versioned transaction loaded through an address lookup table into
   * meta.loadedAddresses, and index the instruction's accounts, exactly as jsonParsed reports them.
   */
  viaLookupTable?: boolean;
}

/** Builds the transaction a real claim_rewards payout produces, with one thing adjustable at a time. */
async function craftTransaction(options: CraftOptions): Promise<RawClaimTransaction> {
  const programAddress = address(PROGRAM_ID);
  const mintAddress = address(options.mint);
  const owner = address(options.wallet);
  const { mine, reserveVault } = await deriveMineAddresses(programAddress, mintAddress);
  const [position, ownerTokens] = await Promise.all([
    derivePositionPda(programAddress, mine, owner),
    deriveAssociatedTokenAddress(owner, mintAddress),
  ]);
  const instruction = buildClaimRewardsInstruction({
    programAddress,
    owner,
    mine,
    mint: mintAddress,
    reserveVault,
    ownerTokens,
    position,
  });
  const accounts = (instruction.accounts ?? []).map((account) => String(account.address));
  const used = options.omitAccount === undefined
    ? accounts
    : accounts.filter((account) => account !== options.omitAccount);
  const keys = [options.wallet, ...used.filter((account) => account !== options.wallet)];
  const indexOf = new Map(keys.map((key, index) => [key, index]));

  const credit = options.creditRaw ?? CREDIT;
  const debit = options.debitRaw ?? credit;
  const vaultIndex = indexOf.get(String(reserveVault)) ?? 0;
  const tokensIndex = indexOf.get(String(ownerTokens)) ?? 0;

  const useLoaded = options.viaLookupTable === true;
  const instructionAccounts: readonly unknown[] = useLoaded
    ? (instruction.accounts ?? []).map((account) => keys.indexOf(String(account.address)))
    : used;

  return {
    blockTime: options.blockTime === undefined ? START + 120 : options.blockTime,
    meta: {
      err: options.failed ? { InstructionError: [0, "Custom"] } : null,
      preTokenBalances: [
        { accountIndex: vaultIndex, mint: options.mint, owner: String(mine), uiTokenAmount: { amount: VAULT_BEFORE.toString() } },
        { accountIndex: tokensIndex, mint: options.mint, owner: options.wallet, uiTokenAmount: { amount: OWNER_BEFORE.toString() } },
      ],
      postTokenBalances: [
        { accountIndex: vaultIndex, mint: options.mint, owner: String(mine), uiTokenAmount: { amount: (VAULT_BEFORE - debit).toString() } },
        { accountIndex: tokensIndex, mint: options.mint, owner: options.wallet, uiTokenAmount: { amount: (OWNER_BEFORE + credit).toString() } },
      ],
      innerInstructions: [],
      ...(useLoaded
        ? {
            loadedAddresses: {
              writable: keys.slice(1).map((pubkey) => ({ pubkey, signer: false })),
              readonly: [],
            },
          }
        : {}),
    },
    transaction: {
      message: {
        // A versioned transaction's message carries only its static signer; everything else came
        // from the lookup table above.
        accountKeys: (useLoaded ? keys.slice(0, 1) : keys).map((pubkey) => ({
          pubkey,
          signer: options.walletSigns !== false && pubkey === options.wallet,
        })),
        instructions: [
          {
            programId: PROGRAM_ID,
            accounts: instructionAccounts,
            data: bs58.encode(options.discriminator ?? Uint8Array.from(instruction.data ?? [])),
          },
        ],
      },
    },
  };
}

function readerOf(transaction: RawClaimTransaction | null): ClaimTransactionReader {
  return {
    async getTransaction(): Promise<RawClaimTransaction | null> {
      return transaction;
    },
  };
}

function seedClaim(options: {
  id: string;
  wallet: string;
  mint: string;
  amountTokens?: number;
  status?: string;
  seq?: number;
  signature?: string;
  /** When the reward settled; null forces a row with no settlement instant at all. */
  claimedAt?: number | null;
}): void {
  h.db
    .prepare(
      "INSERT INTO reward_claims (id, wallet, mint, amount, status, created_at, eligible_until," +
        " claimed_at, settlement_seq, authority, tx_signature)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'ONCHAIN_INDEXED', ?10)",
    )
    .run(
      options.id,
      options.wallet,
      options.mint,
      String(options.amountTokens ?? 50),
      options.status ?? "CLAIMED",
      START,
      START + 86_400,
      options.claimedAt !== undefined
        ? options.claimedAt
        : options.status === undefined || options.status === "CLAIMED"
          ? START + 60
          : null,
      options.seq ?? 1,
      options.signature ?? null,
    );
}

function claimRow(id: string): Record<string, unknown> | undefined {
  return h.db.prepare("SELECT * FROM reward_claims WHERE id = ?1").get(id) as Record<string, unknown> | undefined;
}

function confirmRequest(session: string, body: unknown): Request {
  ipCounter += 1;
  return new Request("https://diggo.fun/api/rewards/claim/confirm", {
    method: "POST",
    headers: {
      authorization: "Bearer " + session,
      "content-type": "application/json",
      "cf-connecting-ip": "10.30.0." + ipCounter,
    },
    body: JSON.stringify(body),
  });
}

const SIGNATURE = bs58.encode(new Uint8Array(64).fill(3));

describe("confirming a user-signed mining claim payout", () => {
  it("records the payout the chain actually shows", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:1", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session-1");
    const transaction = await craftTransaction({ wallet, mint: MINT_A, blockTime: START + 120 });

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:1", signature: SIGNATURE }),
      h.env,
      readerOf(transaction),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "CONFIRMED", idempotent: false, settledAmount: "50" });
    expect(body.paidAmountRaw).toBe(CREDIT.toString());
    const row = claimRow("claim:1");
    expect(row?.tx_signature).toBe(SIGNATURE);
    // The measured payout is stored in raw units, so reconciliation can compare it to the chain.
    expect(row?.paid_amount).toBe(CREDIT.toString());
  });

  it("is idempotent when the same signature is reported again", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:2", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session-2");
    const transaction = await craftTransaction({ wallet, mint: MINT_A });

    await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:2", signature: SIGNATURE }),
      h.env,
      readerOf(transaction),
    );
    const again = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:2", signature: SIGNATURE }),
      h.env,
      readerOf(transaction),
    );

    expect(again.status).toBe(200);
    const body = (await again.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "CONFIRMED", idempotent: true });
    expect(claimRow("claim:2")?.paid_amount).toBe(CREDIT.toString());
  });

  it("rejects a signature that is already recorded against another reward", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:3a", wallet, mint: MINT_A, signature: SIGNATURE, seq: 1 });
    seedClaim({ id: "claim:3b", wallet, mint: MINT_A, seq: 2 });
    const session = await createSession(h, wallet, "session-3");
    const transaction = await craftTransaction({ wallet, mint: MINT_A });

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:3b", signature: SIGNATURE }),
      h.env,
      readerOf(transaction),
    );

    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.code).toBe("SIGNATURE_REUSED");
    // Nothing was recorded for the second reward, even though the transaction itself verifies.
    expect(claimRow("claim:3b")?.tx_signature).toBeNull();
    expect(claimRow("claim:3b")?.paid_amount).toBeNull();
  });

  it("rejects a different signature for a reward that is already paid", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:4", wallet, mint: MINT_A, signature: "already-recorded" });
    const session = await createSession(h, wallet, "session-4");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:4", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("ALREADY_CLAIMED");
    expect(claimRow("claim:4")?.tx_signature).toBe("already-recorded");
  });

  it("refuses a reward that has not finished settling", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:5", wallet, mint: MINT_A, status: "ELIGIBLE" });
    const session = await createSession(h, wallet, "session-5");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:5", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("NOT_SETTLED");
    expect(claimRow("claim:5")?.tx_signature).toBeNull();
  });

  it("refuses a transaction that is not this program's claim_rewards", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:6", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session-6");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:6", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({
        wallet,
        mint: MINT_A,
        discriminator: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
    expect(claimRow("claim:6")?.tx_signature).toBeNull();
  });

  it("refuses a payout against another mine's reserve", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:7", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session-7");
    const otherMine = await craftTransaction({ wallet, mint: MINT_B });
    const { reserveVault } = await deriveMineAddresses(address(PROGRAM_ID), address(MINT_B));

    // The transaction is a real, wallet-signed claim_rewards - just not for this reward's mine.
    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:7", signature: SIGNATURE }),
      h.env,
      readerOf({
        ...otherMine,
        transaction: {
          message: {
            accountKeys: [
              { pubkey: wallet, signer: true },
              ...(otherMine.transaction?.message?.accountKeys ?? []).slice(1),
            ],
            instructions: otherMine.transaction?.message?.instructions,
          },
        },
      }),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
    expect(String(reserveVault)).not.toBe("");
    expect(claimRow("claim:7")?.tx_signature).toBeNull();
  });

  it("refuses a transaction the wallet did not sign", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:8", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session-8");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:8", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, walletSigns: false })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
  });

  it("refuses a payout whose reserve vault was never debited", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:9", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session-9");

    // Tokens arrived in the wallet's account, but not out of the mine's reserve.
    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:9", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, debitRaw: 0n })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
    expect(claimRow("claim:9")?.tx_signature).toBeNull();
  });

  it("refuses a transaction that credited the wallet nothing", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:10", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:10");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:10", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, creditRaw: 0n })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
  });

  it("refuses a transaction that failed on chain", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:11", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:11");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:11", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, failed: true })),
    );

    expect(response.status).toBe(409);
    expect(claimRow("claim:11")?.tx_signature).toBeNull();
  });

  it("refuses a signature the chain does not know", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:12", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:12");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:12", signature: SIGNATURE }),
      h.env,
      readerOf(null),
    );

    expect(response.status).toBe(409);
    expect(claimRow("claim:12")?.tx_signature).toBeNull();
  });

  it("requires a wallet session", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:13", wallet, mint: MINT_A });

    const response = await confirmRewardClaim(
      confirmRequest("not-a-session", { rewardId: "claim:13", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A })),
    );

    expect(response.status).toBe(401);
    expect(claimRow("claim:13")?.tx_signature).toBeNull();
  });

  it("reports another wallet's reward exactly like a missing one", async () => {
    seedClaim({ id: "claim:14", wallet: WALLET_B, mint: MINT_A });
    const session = await createSession(h, WALLET_C, "session:14");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:14", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet: WALLET_B, mint: MINT_A })),
    );

    expect(response.status).toBe(404);
    expect(claimRow("claim:14")?.tx_signature).toBeNull();
  });

  it("refuses a transaction that predates the settled reward", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:17", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:17");

    // A real claim_rewards transaction - but produced before this reward settled, so it cannot be
    // this reward's payout.
    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:17", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, blockTime: START - 3_600 })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
    expect(claimRow("claim:17")?.tx_signature).toBeNull();
  });

  it("refuses a payout for a claim with no settlement instant to anchor it", async () => {
    const wallet = WALLET_A;
    // A claim row that never recorded when it settled. Without the anchor there is nothing to
    // compare a transaction against, so every old claim_rewards signature for this wallet and mine
    // would count as proof for this reward.
    seedClaim({ id: "claim:20", wallet, mint: MINT_A, claimedAt: null });
    const session = await createSession(h, wallet, "session:20");

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:20", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
    expect(claimRow("claim:20")?.tx_signature).toBeNull();
  });

  it("rejects a malformed signature before any chain call", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:15", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:15");
    let read = 0;
    const reader: ClaimTransactionReader = {
      async getTransaction() {
        read += 1;
        return null;
      },
    };

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:15", signature: "not-a-signature" }),
      h.env,
      reader,
    );

    expect(response.status).toBe(400);
    expect(read).toBe(0);
  });

  it("refuses a payout whose transaction reports no block time", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:18", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:18");

    // Without a block time there is no way to tell this transaction apart from one that landed
    // before the reward settled, so "the RPC did not say" cannot be read as "it is recent".
    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:18", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, blockTime: null })),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("PAYOUT_UNVERIFIED");
    expect(claimRow("claim:18")?.tx_signature).toBeNull();
  });

  it("matches an instruction through the accounts the transaction loaded from a lookup table", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:19", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:19");

    // A versioned transaction: the message declares the signer, and the mine, reserve vault and
    // token accounts arrive as loaded addresses with the instruction naming them by index. This is
    // what a real claim_rewards from a normal wallet looks like. Before the loaded addresses were
    // resolved, every account the claim needs looked absent and the payout was refused.
    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:19", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A, viaLookupTable: true })),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: "CONFIRMED", idempotent: false });
    expect(body.paidAmountRaw).toBe(CREDIT.toString());
    expect(claimRow("claim:19")?.paid_amount).toBe(CREDIT.toString());
  });

  it("halts recording once a claims breaker is open for that mine", async () => {
    const wallet = WALLET_A;
    seedClaim({ id: "claim:16", wallet, mint: MINT_A });
    const session = await createSession(h, wallet, "session:16");
    h.db
      .prepare(
        "INSERT INTO circuit_breakers (id, scope, mint, open, reason, actor, updated_at)" +
          " VALUES (?1, 'claims', ?2, 1, 'reserve_divergence', 'reconcile-cron', ?3)",
      )
      .run("claims:" + MINT_A, MINT_A, START);

    const response = await confirmRewardClaim(
      confirmRequest(session, { rewardId: "claim:16", signature: SIGNATURE }),
      h.env,
      readerOf(await craftTransaction({ wallet, mint: MINT_A })),
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as Record<string, unknown>).code).toBe("CLAIMS_HALTED");
    expect(claimRow("claim:16")?.tx_signature).toBeNull();
  });
});
