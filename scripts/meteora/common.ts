import {
  LAMPORTS_PER_SOL,
  type Commitment,
  Keypair,
  Connection,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  ActivationType,
  BaseFeeMode,
  CollectFeeMode,
  DammV2BaseFeeMode,
  DammV2DynamicFeeMode,
  DynamicBondingCurveClient,
  MigratedCollectFeeMode,
  MigrationFeeOption,
  MigrationOption,
  TokenAuthorityOption,
  TokenDecimal,
  TokenType,
  buildCurve,
  type BuildCurveBaseParams,
} from "@meteora-ag/dynamic-bonding-curve-sdk";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export type Cluster = "devnet" | "mainnet";

export const PLATFORM_FEE_WALLET =
  "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
export const DBC_PROGRAM_ID =
  "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN";
export const DAMM_V2_PROGRAM_ID =
  "cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG";
export const NATIVE_SOL_MINT =
  "So11111111111111111111111111111111111111112";

export const PARAMS = {
  totalTokenSupply: 1_000_000_000,
  leftover: 200_000_000,
  poolCreationFeeSol: 0.01,
  migrationFeePercentage: 1,
  migrationThresholdSol: { devnet: 2, mainnet: 85 } as const,
  migratedPoolFeeBps: 100,
} as const;

export function parseCluster(value: string | undefined): Cluster {
  if (value === "devnet" || value === "mainnet") return value;
  throw new Error("--cluster must be devnet or mainnet");
}

export function rpcUrlFor(cluster: Cluster, explicit?: string): string {
  if (explicit) return explicit;
  if (cluster === "devnet") {
    return process.env.DIGGO_DEVNET_RPC_URL ?? "https://api.devnet.solana.com";
  }
  return process.env.DIGGO_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com";
}

export function connectionFor(
  cluster: Cluster,
  explicitRpcUrl?: string,
  commitment: Commitment = "confirmed",
): Connection {
  return new Connection(rpcUrlFor(cluster, explicitRpcUrl), commitment);
}

export function clientFor(
  connection: Connection,
  commitment: Commitment = "confirmed",
): DynamicBondingCurveClient {
  return DynamicBondingCurveClient.create(connection, commitment);
}

export function publicKey(value: string, label: string): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} is not a valid Solana public key`);
  }
}

export function externalPath(value: string, label = "keypair path"): string {
  const path = isAbsolute(value) ? value : resolve(value);
  const repoScripts = resolve("scripts");
  if (path === repoScripts || path.startsWith(`${repoScripts}\\`) || path.startsWith(`${repoScripts}/`)) {
    throw new Error(`${label} must be outside the repository`);
  }
  return path;
}

export async function loadKeypair(path: string): Promise<Keypair> {
  const resolved = externalPath(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(resolved, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${label(path)}: ${errorMessage(error)}`);
  }
  if (
    !Array.isArray(value) ||
    value.length !== 64 ||
    !value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
  ) {
    throw new Error(`${label(path)} must be a JSON byte array with 64 entries`);
  }
  return Keypair.fromSecretKey(Uint8Array.from(value as number[]));
}

export function sol(amount: number | bigint): bigint {
  if (amount < 0) throw new Error("SOL amount cannot be negative");
  const value = typeof amount === "bigint" ? amount : BigInt(Math.round(amount * LAMPORTS_PER_SOL));
  return value;
}

export function solString(lamports: bigint): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const whole = absolute / BigInt(LAMPORTS_PER_SOL);
  const fraction = (absolute % BigInt(LAMPORTS_PER_SOL)).toString().padStart(9, "0");
  return `${negative ? "-" : ""}${whole}.${fraction} SOL`;
}

export function buildDiggoCurveBase(): BuildCurveBaseParams {
  return {
    token: {
      tokenType: TokenType.SPLToken,
      tokenBaseDecimal: TokenDecimal.NINE,
      tokenQuoteDecimal: TokenDecimal.NINE,
      tokenAuthorityOption: TokenAuthorityOption.Immutable,
      totalTokenSupply: PARAMS.totalTokenSupply,
      leftover: PARAMS.leftover,
    },
    fee: {
      baseFeeParams: {
        baseFeeMode: BaseFeeMode.FeeSchedulerLinear,
        feeSchedulerParam: {
          startingFeeBps: 300,
          endingFeeBps: 100,
          numberOfPeriod: 60,
          totalDuration: 60 * 60,
        },
      },
      dynamicFeeEnabled: true,
      collectFeeMode: CollectFeeMode.QuoteToken,
      creatorTradingFeePercentage: 0,
      // poolCreationFee is expressed in whole SOL by the pinned SDK.
      poolCreationFee: PARAMS.poolCreationFeeSol,
      enableFirstSwapWithMinFee: false,
    },
    migration: {
      migrationOption: MigrationOption.MET_DAMM_V2,
      migrationFeeOption: MigrationFeeOption.Customizable,
      migrationFee: {
        feePercentage: PARAMS.migrationFeePercentage,
        creatorFeePercentage: 0,
      },
      migratedPoolFee: {
        collectFeeMode: MigratedCollectFeeMode.QuoteToken,
        dynamicFee: DammV2DynamicFeeMode.Disabled,
        poolFeeBps: PARAMS.migratedPoolFeeBps,
        baseFeeMode: DammV2BaseFeeMode.FeeTimeSchedulerLinear,
      },
    },
    liquidityDistribution: {
      partnerPermanentLockedLiquidityPercentage: 10,
      partnerLiquidityPercentage: 90,
      creatorPermanentLockedLiquidityPercentage: 0,
      creatorLiquidityPercentage: 0,
    },
    lockedVesting: {
      totalLockedVestingAmount: 0,
      numberOfVestingPeriod: 0,
      cliffUnlockAmount: 0,
      totalVestingDuration: 0,
      cliffDurationFromMigrationTime: 0,
    },
    activationType: ActivationType.Timestamp,
  };
}

export function buildDiggoConfig(
  cluster: Cluster,
) {
  return buildCurve({
    ...buildDiggoCurveBase(),
    // buildCurve requires an explicit curve split. Diggo has not specified a market-cap
    // migration allocation, so keep 25% of circulating supply on the curve and flag it in ops.
    percentageSupplyOnMigration: 25,
    migrationQuoteThreshold: PARAMS.migrationThresholdSol[cluster],
  });
}

export async function signAndConfirm(
  connection: Connection,
  payer: Keypair,
  build: () => Promise<Transaction>,
  additionalSigners: Keypair[] = [],
): Promise<{ signature: string; lamports: bigint }> {
  const before = await connection.getBalance(payer.publicKey, "confirmed");
  const transaction = await build();
  transaction.feePayer = payer.publicKey;
  transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  transaction.sign(payer, ...additionalSigners);
  const signature = await sendAndConfirmTransaction(connection, transaction, [payer, ...additionalSigners], {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  const after = await connection.getBalance(payer.publicKey, "confirmed");
  return { signature, lamports: BigInt(after - before) };
}

export function option<T>(name: string, args: string[], index: number): T | undefined {
  const flag = `--${name}`;
  const equals = args.indexOf(`${flag}=`);
  if (equals >= 0) return args[equals + 1] as T;
  const at = args.indexOf(flag);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  return value as T;
}

export function requiredOption<T>(name: string, args: string[]): T {
  const value = option<T>(name, args, 0);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function label(path: string): string {
  return `keypair ${path}`;
}
