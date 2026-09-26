import { createHash } from "node:crypto";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { PublicKey } from "@solana/web3.js";
import { NATIVE_SOL_MINT } from "./common.ts";

/**
 * The official Diggo.fun coin launch, pinned end to end.
 *
 * Every value that ends up in immutable on-chain state (mint, config, creator, name, symbol, URI) is
 * a constant here, so the launch command cannot be pointed at anything else by a flag or a typo.
 */
export const LAUNCH = {
  mint: "AvsnWvXkgKqfD1ciFFJyVkgjz3CeGPz38e2KS8uDPawN",
  config: "5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF",
  payer: "GkCYyWzSjhSFEjKNx1ebWThtVLzQj7L84ktAHe31MBSx",
  name: "Diggo.fun",
  symbol: "DIGGO",
  website: "https://diggo.fun",
  twitter: "https://x.com/Diggo_Fun",
  telegram: "https://t.me/DiggoDotFun",
  metadataKey: "official-diggo-fun-metadata-v1.json",
  imageKey: "official-diggo-fun-logo-v2.png",
  metadataUrl: "https://diggo.fun/media/official-diggo-fun-metadata-v1.json",
  imageUrl: "https://diggo.fun/media/official-diggo-fun-logo-v2.png",
  imageSha256: "d5ac4b0620c96aa18aada472fce491a581edc6daed2d0670fff1f58c28f6f016",
  imageBytes: 149_425,
} as const;

export const LAUNCH_MINT = new PublicKey(LAUNCH.mint);
export const LAUNCH_CONFIG = new PublicKey(LAUNCH.config);
export const LAUNCH_PAYER = new PublicKey(LAUNCH.payer);
export const LAUNCH_POOL = deriveDbcPoolAddress(new PublicKey(NATIVE_SOL_MINT), LAUNCH_MINT, LAUNCH_CONFIG);

/** A public, heavily funded system account (a Binance hot wallet), used only as a simulation fee payer. */
export const DEFAULT_SIMULATION_PAYER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** Off-chain Metaplex fungible metadata, hosted verbatim at LAUNCH.metadataUrl. */
export const OFFICIAL_METADATA = {
  name: LAUNCH.name,
  symbol: LAUNCH.symbol,
  description: "The official coin of Diggo.fun, the memecoin mining launchpad on Solana.",
  image: LAUNCH.imageUrl,
  external_url: LAUNCH.website,
  extensions: {
    website: LAUNCH.website,
    twitter: LAUNCH.twitter,
    telegram: LAUNCH.telegram,
  },
  properties: {
    files: [{ uri: LAUNCH.imageUrl, type: "image/png" }],
    category: "image",
  },
} as const;

/** The exact bytes to upload. The launch refuses to send unless the hosted URL serves these bytes. */
export function officialMetadataJson(): string {
  return `${JSON.stringify(OFFICIAL_METADATA, null, 2)}\n`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Throws unless the logo bytes are the pinned artwork. */
export function assertOfficialLogo(bytes: Uint8Array): void {
  const hash = sha256Hex(bytes);
  if (hash !== LAUNCH.imageSha256 || bytes.length !== LAUNCH.imageBytes) {
    throw new Error(`Logo mismatch: got ${bytes.length} bytes sha256 ${hash}, expected ${LAUNCH.imageBytes} bytes sha256 ${LAUNCH.imageSha256}`);
  }
}

export type LaunchOptions = {
  rpcUrl?: string;
  payerKeypair?: string;
  mintKeypair?: string;
  simulationPayer: string;
  priorityMicroLamports: number;
  outDir?: string;
  send: boolean;
  confirmMint?: string;
};

const VALUE_OPTIONS = new Set([
  "--rpc-url",
  "--payer-keypair",
  "--mint-keypair",
  "--simulation-payer",
  "--priority-micro-lamports",
  "--out-dir",
  "--confirm-mint",
]);

/** Parses the CLI. Sending needs both keypair files and the mint typed out again with --confirm-mint. */
export function parseLaunchOptions(args: string[]): LaunchOptions {
  const values = new Map<string, string>();
  let send = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--send") {
      send = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(arg)) throw new Error(`Unknown option ${arg}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} needs a value`);
    values.set(arg, value);
    index += 1;
  }
  const priority = Number(values.get("--priority-micro-lamports") ?? "20000");
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 5_000_000) {
    throw new Error("--priority-micro-lamports must be an integer from 0 to 5000000");
  }
  const options: LaunchOptions = {
    rpcUrl: values.get("--rpc-url"),
    payerKeypair: values.get("--payer-keypair"),
    mintKeypair: values.get("--mint-keypair"),
    simulationPayer: values.get("--simulation-payer") ?? DEFAULT_SIMULATION_PAYER,
    priorityMicroLamports: priority,
    outDir: values.get("--out-dir"),
    send,
    confirmMint: values.get("--confirm-mint"),
  };
  if (send) {
    if (!options.payerKeypair || !options.mintKeypair) {
      throw new Error("--send requires both --payer-keypair and --mint-keypair");
    }
    if (options.confirmMint !== LAUNCH.mint) {
      throw new Error(`--send requires --confirm-mint ${LAUNCH.mint}`);
    }
  }
  return options;
}

/** Throws unless the signer files resolve to the pinned payer and mint. */
export function assertLaunchSigners(payer: PublicKey | undefined, mint: PublicKey | undefined): void {
  if (payer && !payer.equals(LAUNCH_PAYER)) throw new Error(`Payer keypair is ${payer.toBase58()}, expected ${LAUNCH.payer}`);
  if (mint && !mint.equals(LAUNCH_MINT)) throw new Error(`Mint keypair is ${mint.toBase58()}, expected ${LAUNCH.mint}`);
}

export type AccountChange = { address: string; before: bigint; after: bigint };

/**
 * The launch cost from a simulation: every lamport that lands in another account plus the network
 * fee. Counting the receivers instead of the payer's own balance keeps the figure exact even when a
 * stand-in payer's balance moves between the pre-read and the simulated slot.
 */
export function measureLaunchCost(changes: AccountChange[], payer: string, networkFee: bigint): bigint {
  let received = 0n;
  for (const change of changes) {
    if (change.address === payer) continue;
    const delta = change.after - change.before;
    if (delta < 0n) throw new Error(`${change.address} lost lamports in the simulation; refusing to price the launch`);
    received += delta;
  }
  if (networkFee < 0n) throw new Error("Network fee cannot be negative");
  return received + networkFee;
}

export const BUDGET_STEP_LAMPORTS = 1_000_000n;
export const BUDGET_MARGIN_LAMPORTS = 1_000_000n;

export type LaunchBudget = {
  costLamports: bigint;
  reserveLamports: bigint;
  requiredBalanceLamports: bigint;
  toSendLamports: bigint;
  leftoverLamports: bigint;
};

/**
 * The balance the payer needs: the measured cost, the rent-exempt minimum so the payer account stays
 * valid after paying (a system account may not end between 0 and that minimum), and a 0.001 SOL
 * margin for fee drift, rounded up to the next 0.001 SOL.
 */
export function planLaunchBudget(costLamports: bigint, rentExemptMinimum: bigint, payerBalance: bigint): LaunchBudget {
  if (costLamports <= 0n) throw new Error("Launch cost must be positive");
  const reserveLamports = rentExemptMinimum + BUDGET_MARGIN_LAMPORTS;
  const floor = costLamports + reserveLamports;
  const requiredBalanceLamports = ((floor + BUDGET_STEP_LAMPORTS - 1n) / BUDGET_STEP_LAMPORTS) * BUDGET_STEP_LAMPORTS;
  const toSendLamports = requiredBalanceLamports > payerBalance ? requiredBalanceLamports - payerBalance : 0n;
  return {
    costLamports,
    reserveLamports,
    requiredBalanceLamports,
    toSendLamports,
    leftoverLamports: payerBalance + toSendLamports - costLamports,
  };
}
