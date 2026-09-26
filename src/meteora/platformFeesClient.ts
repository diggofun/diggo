/**
 * Network side of the "Claim platform fees" card: reads the DBC config and its pools through the
 * same-origin /api/rpc proxy, builds one claim transaction per pool, checks that the claimer can
 * pay for it, simulates it unsigned, and only then hands it to the connected wallet.
 */
import BN from "bn.js";
import { deriveDbcPoolAddress, type DynamicBondingCurveClient, type PoolConfig, type VirtualPool } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey, Transaction } from "@solana/web3.js";
import { METEORA_WRAPPED_SOL_MINT } from "../../shared/meteora";
import { RPC_ENDPOINT, type DiggoWallet, type SubmissionResult } from "../onchain/tx";
import { createMeteoraClient, sendMeteoraTransaction } from "./client";
import {
  assertClaimTransaction,
  assertPlatformFeeClaimer,
  claimerFunding,
  MAX_CLAIM_AMOUNT,
  partnerClaimAccounts,
  partnerCreationFee,
  planPartnerFeeClaim,
  type ClaimerFunding,
  type PartnerClaimPlan,
  type PartnerFeePool,
} from "./platformFees";

const ASSOCIATED_TOKEN_PROGRAM_ID = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const TOKEN_ACCOUNT_SIZE = 165;
type PoolStateData = VirtualPool["poolState"];
/** Upper bound on pools rendered; the config is ours, so this only guards against surprises. */
export const MAX_LISTED_POOLS = 50;

export interface PlatformFeeConfig {
  config: string;
  feeClaimer: string;
  quoteIsSol: boolean;
  poolCreationFeeLamports: bigint;
  tokenDecimals: number;
}

export interface PlatformFeeOverview {
  pools: PartnerFeePool[];
  /** True when the pool scan failed and only the official pool was read. */
  fallback: boolean;
  balanceLamports: bigint;
}

export interface PreparedPartnerClaim {
  transaction: Transaction;
  pool: PartnerFeePool;
  plan: PartnerClaimPlan;
  funding: ClaimerFunding;
  balanceLamports: bigint;
}

export interface SimulationOutcome {
  err: unknown;
  logs: string[];
  unitsConsumed?: number;
}

export async function loadPlatformFeeConfig(
  configAddress: string,
  client: DynamicBondingCurveClient = createMeteoraClient(),
): Promise<PlatformFeeConfig | null> {
  const config = await client.state.getPoolConfig(new PublicKey(configAddress));
  if (!config) return null;
  return describeConfig(configAddress, config);
}

function describeConfig(configAddress: string, config: PoolConfig): PlatformFeeConfig {
  return {
    config: configAddress,
    feeClaimer: config.feeClaimer.toBase58(),
    quoteIsSol: config.quoteMint.toBase58() === METEORA_WRAPPED_SOL_MINT,
    poolCreationFeeLamports: BigInt(config.poolCreationFee.toString()),
    tokenDecimals: Number(config.tokenDecimal ?? 9),
  };
}

function toPartnerFeePool(address: PublicKey, state: PoolStateData, feeConfig: PlatformFeeConfig): PartnerFeePool {
  const creation = partnerCreationFee(feeConfig.poolCreationFeeLamports, Number(state.creationFeeBits));
  return {
    pool: address.toBase58(),
    baseMint: state.baseMint.toBase58(),
    tradingQuoteLamports: BigInt(state.partnerQuoteFee.toString()),
    tradingBaseUnits: BigInt(state.partnerBaseFee.toString()),
    creationFeeLamports: creation.lamports,
    creationFeeClaimed: creation.claimed,
  };
}

/**
 * Lists every partner-fee pool under the config. If the proxy refuses the pool scan (for example an
 * older Worker), it falls back to the official $DIGGO pool so the main claim still works.
 */
export async function loadPlatformFeeOverview(input: {
  feeConfig: PlatformFeeConfig;
  claimer: string;
  officialMint: string | null;
  client?: DynamicBondingCurveClient;
}): Promise<PlatformFeeOverview> {
  const client = input.client ?? createMeteoraClient();
  assertPlatformFeeClaimer(input.claimer, input.feeConfig.feeClaimer);
  const configKey = new PublicKey(input.feeConfig.config);
  let pools: PartnerFeePool[] = [];
  let fallback = false;
  try {
    const accounts = await client.state.getPoolsByConfig(configKey);
    pools = accounts
      .map((entry) => ({ address: entry.publicKey, state: entry.account.poolState }))
      .filter((entry) => entry.state?.config.equals(configKey))
      .map((entry) => toPartnerFeePool(entry.address, entry.state, input.feeConfig));
  } catch {
    fallback = true;
    if (input.officialMint) {
      const address = deriveDbcPoolAddress(new PublicKey(METEORA_WRAPPED_SOL_MINT), new PublicKey(input.officialMint), configKey);
      const pool = await client.state.getPool(address);
      if (pool && pool.poolState.config.equals(configKey)) pools = [toPartnerFeePool(address, pool.poolState, input.feeConfig)];
    }
  }
  pools.sort((left, right) => {
    const officialFirst = Number(right.baseMint === input.officialMint) - Number(left.baseMint === input.officialMint);
    if (officialFirst !== 0) return officialFirst;
    const difference = planPartnerFeeClaim(right).claimableLamports - planPartnerFeeClaim(left).claimableLamports;
    return difference > 0n ? 1 : difference < 0n ? -1 : 0;
  });
  const balanceLamports = BigInt(await client.connection.getBalance(new PublicKey(input.claimer), "confirmed"));
  return { pools: pools.slice(0, MAX_LISTED_POOLS), fallback, balanceLamports };
}

/**
 * Re-reads the pool and config, then builds ONE transaction that claims the partner trading fee
 * to the claimer and, when still unclaimed, the partner pool creation fee to the claimer.
 */
export async function preparePartnerClaim(input: {
  configAddress: string;
  poolAddress: string;
  claimer: string;
  client?: DynamicBondingCurveClient;
}): Promise<PreparedPartnerClaim> {
  const client = input.client ?? createMeteoraClient();
  const configKey = new PublicKey(input.configAddress);
  const poolKey = new PublicKey(input.poolAddress);
  const claimer = new PublicKey(input.claimer);
  const [pool, config] = await Promise.all([client.state.getPool(poolKey), client.state.getPoolConfig(configKey)]);
  if (!pool || !config) throw new Error("The pool or its Meteora config could not be read. Try again.");
  if (!pool.poolState.config.equals(configKey)) throw new Error("This pool does not belong to the platform config.");
  const feeConfig = describeConfig(input.configAddress, config);
  assertPlatformFeeClaimer(input.claimer, feeConfig.feeClaimer);
  if (!feeConfig.quoteIsSol) throw new Error("Only SOL-quoted pools can be claimed here.");

  const snapshot = toPartnerFeePool(poolKey, pool.poolState, feeConfig);
  const plan = planPartnerFeeClaim(snapshot);
  if (!plan.claimTrading && !plan.claimCreation) throw new Error("There are no platform fees to claim in this pool right now.");

  const accounts = partnerClaimAccounts(claimer);
  const max = new BN(MAX_CLAIM_AMOUNT);
  const transaction = new Transaction();
  if (plan.claimTrading) {
    transaction.add(
      await client.partner.claimPartnerTradingFeeToReceiver({
        feeClaimer: accounts.feeClaimer,
        payer: accounts.payer,
        pool: poolKey,
        maxBaseAmount: max,
        maxQuoteAmount: max,
        receiver: accounts.receiver,
      }),
    );
  }
  if (plan.claimCreation) {
    transaction.add(await client.partner.claimPartnerPoolCreationFee({ pool: poolKey, feeReceiver: accounts.feeReceiver }));
  }
  const latest = await client.connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  transaction.feePayer = claimer;
  assertClaimTransaction(transaction, claimer);

  const tokenAccounts = transaction.instructions
    .filter((instruction) => instruction.programId.toBase58() === ASSOCIATED_TOKEN_PROGRAM_ID)
    .map((instruction) => instruction.keys[1]?.pubkey)
    .filter((key): key is PublicKey => key !== undefined);
  const [balance, existing, rent] = await Promise.all([
    client.connection.getBalance(claimer, "confirmed"),
    tokenAccounts.length ? client.connection.getMultipleAccountsInfo(tokenAccounts, "confirmed") : Promise.resolve([]),
    tokenAccounts.length ? client.connection.getMinimumBalanceForRentExemption(TOKEN_ACCOUNT_SIZE, "confirmed") : Promise.resolve(0),
  ]);
  const balanceLamports = BigInt(balance);
  const funding = claimerFunding({
    balanceLamports,
    missingTokenAccounts: existing.filter((account) => account === null).length,
    rentPerTokenAccountLamports: BigInt(rent),
  });
  return { transaction, pool: snapshot, plan, funding, balanceLamports };
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/**
 * Simulates the claim before the wallet sees it. The transaction is unsigned, so the proxy only
 * accepts it for the signed-in session wallet, which must also be its fee payer.
 */
export async function simulateUnsignedClaim(transaction: Transaction): Promise<SimulationOutcome> {
  const wire = bytesToBase64(new Uint8Array(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })));
  const response = await fetch(RPC_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: [wire, { encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true }],
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    | { result?: { value?: { err?: unknown; logs?: string[] | null; unitsConsumed?: number } }; error?: { message?: string } }
    | null;
  if (!response.ok || !payload?.result?.value) {
    throw new Error(payload?.error?.message ?? "The claim simulation could not run (" + response.status + ").");
  }
  const value = payload.result.value;
  return { err: value.err ?? null, logs: value.logs ?? [], unitsConsumed: value.unitsConsumed };
}

export async function sendPartnerClaim(wallet: DiggoWallet, prepared: PreparedPartnerClaim): Promise<SubmissionResult> {
  if (wallet.address !== prepared.transaction.feePayer?.toBase58()) {
    throw new Error("The connected wallet changed. Refresh and try again.");
  }
  return sendMeteoraTransaction(wallet, prepared.transaction, { action: "claim", timeoutMs: 90_000 });
}
