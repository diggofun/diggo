/**
 * Launches the official Diggo.fun coin ($DIGGO) through Diggo's mainnet Meteora DBC config.
 *
 * Dry run by default: it verifies the pinned mint, config, payer, URIs and logo, builds the exact
 * create-pool transaction and simulates it (sigVerify off, with a funded public account standing in
 * as fee payer when the real payer is not funded yet), then prints the measured cost and the single
 * SOL amount to send to the payer. Nothing is uploaded by this command, ever.
 *
 * Broadcasting needs --send, both keypair files, --confirm-mint <mint>, a funded payer, and the
 * hosted metadata JSON and logo already serving the exact pinned bytes. See docs/METEORA_OPS.md.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveDbcTokenVaultAddress, deriveMintMetadata } from "@meteora-ag/dynamic-bonding-curve-sdk";
import {
  ComputeBudgetProgram,
  type Connection,
  type Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import { clientFor, connectionFor, DBC_PROGRAM_ID, loadKeypair, NATIVE_SOL_MINT, publicKey, solString } from "./common.ts";
import {
  type AccountChange,
  LAUNCH,
  LAUNCH_CONFIG,
  LAUNCH_MINT,
  LAUNCH_PAYER,
  LAUNCH_POOL,
  assertLaunchSigners,
  assertOfficialLogo,
  measureLaunchCost,
  officialMetadataJson,
  parseLaunchOptions,
  planLaunchBudget,
} from "./launch-official-coin-core.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOGO_PATH = join(REPO_ROOT, "public", "brand", LAUNCH.imageKey);
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const MAX_COMPUTE_UNITS = 1_400_000;

const DBC_PROGRAM = new PublicKey(DBC_PROGRAM_ID);
const BASE_VAULT = deriveDbcTokenVaultAddress(LAUNCH_POOL, LAUNCH_MINT);
const QUOTE_VAULT = deriveDbcTokenVaultAddress(LAUNCH_POOL, new PublicKey(NATIVE_SOL_MINT));
const MINT_METADATA = deriveMintMetadata(LAUNCH_MINT);
const [POOL_METADATA] = PublicKey.findProgramAddressSync(
  [Buffer.from("virtual_pool_metadata"), LAUNCH_POOL.toBuffer()],
  DBC_PROGRAM,
);

const LABELS = new Map<string, string>([
  [LAUNCH.mint, "base mint (SPL)"],
  [MINT_METADATA.toBase58(), "Metaplex mint metadata"],
  [LAUNCH_POOL.toBase58(), "DBC virtual pool"],
  [BASE_VAULT.toBase58(), "DBC base vault"],
  [QUOTE_VAULT.toBase58(), "DBC quote vault"],
  [POOL_METADATA.toBase58(), "DBC virtual pool metadata"],
  [LAUNCH.config, "DBC config"],
  [LAUNCH.payer, "payer / creator"],
]);

function externalKeypairPath(value: string): string {
  const path = realpathSync(value);
  const location = relative(REPO_ROOT, path);
  if (!isAbsolute(location) && location !== ".." && !location.startsWith("..\\") && !location.startsWith("../")) {
    throw new Error("Keypair files must be outside the repository");
  }
  return path;
}

type Built = { transaction: Transaction; writable: PublicKey[] };

async function buildLaunchTransaction(
  connection: Connection,
  feePayer: PublicKey,
  computeUnitLimit: number,
  priorityMicroLamports: number,
): Promise<Built> {
  const client = clientFor(connection);
  const createPool = await client.creator.createPool({
    name: LAUNCH.name,
    symbol: LAUNCH.symbol,
    uri: LAUNCH.metadataUrl,
    payer: feePayer,
    poolCreator: LAUNCH_PAYER,
    config: LAUNCH_CONFIG,
    baseMint: LAUNCH_MINT,
  });
  // The site indexer reads the DBC virtual_pool_metadata PDA for name and logo, wallets read the
  // Metaplex URI; both are written in the same transaction, as for the first official launch.
  const createMetadata = await client.creator.createPoolMetadata({
    virtualPool: LAUNCH_POOL,
    name: LAUNCH.name,
    website: LAUNCH.website,
    logo: LAUNCH.imageUrl,
    creator: LAUNCH_PAYER,
    payer: feePayer,
  });
  const transaction = new Transaction();
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityMicroLamports }),
  );
  for (const instruction of [...createPool.instructions, ...createMetadata.instructions]) {
    if (!instruction.programId.equals(ComputeBudgetProgram.programId)) transaction.add(instruction);
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.feePayer = feePayer;
  transaction.recentBlockhash = latest.blockhash;
  transaction.lastValidBlockHeight = latest.lastValidBlockHeight;
  const message = transaction.compileMessage();
  const writable = message.accountKeys.filter((_, index) => message.isAccountWritable(index));
  return { transaction, writable };
}

type Simulated = { units: number; changes: (AccountChange & { dataLength: number })[]; logs: string[] };

async function simulate(connection: Connection, built: Built, signers: Keypair[] = []): Promise<Simulated> {
  const before = await connection.getMultipleAccountsInfo(built.writable, "confirmed");
  const versioned = new VersionedTransaction(built.transaction.compileMessage());
  const verify = signers.length > 0;
  if (verify) versioned.sign(signers);
  const result = await connection.simulateTransaction(versioned, {
    sigVerify: verify,
    replaceRecentBlockhash: !verify,
    commitment: "confirmed",
    accounts: { encoding: "base64", addresses: built.writable.map((key) => key.toBase58()) },
  });
  const logs = result.value.logs ?? [];
  if (result.value.err) {
    for (const line of logs) console.error(`    ${line}`);
    throw new Error(`Simulation failed: ${JSON.stringify(result.value.err)}`);
  }
  const after = result.value.accounts ?? [];
  const changes = built.writable.map((key, index) => {
    const post = after[index];
    return {
      address: key.toBase58(),
      before: BigInt(before[index]?.lamports ?? 0),
      after: BigInt(post?.lamports ?? 0),
      dataLength: post ? Buffer.from(post.data[0], "base64").length : 0,
    };
  });
  return { units: result.value.unitsConsumed ?? 0, changes, logs };
}

async function networkFee(connection: Connection, built: Built): Promise<bigint> {
  const fee = await connection.getFeeForMessage(built.transaction.compileMessage(), "confirmed");
  if (fee.value === null) throw new Error("RPC could not price the transaction message");
  return BigInt(fee.value);
}

async function verifyHosted(url: string): Promise<Uint8Array> {
  const response = await fetch(`${url}?launch-check=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function writeOnce(path: string, contents: string): void {
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== contents) throw new Error(`${path} exists with different contents; not overwriting`);
    return;
  }
  writeFileSync(path, contents, { encoding: "utf8", flag: "wx" });
}

async function main(): Promise<void> {
  const options = parseLaunchOptions(process.argv.slice(2));
  const connection = connectionFor("mainnet", options.rpcUrl);
  const payerKeypair = options.payerKeypair ? await loadKeypair(externalKeypairPath(options.payerKeypair)) : undefined;
  const mintKeypair = options.mintKeypair ? await loadKeypair(externalKeypairPath(options.mintKeypair)) : undefined;
  assertLaunchSigners(payerKeypair?.publicKey, mintKeypair?.publicKey);

  const logo = readFileSync(LOGO_PATH);
  assertOfficialLogo(logo);
  const metadataJson = officialMetadataJson();

  console.log(`Mode: ${options.send ? "SEND" : "dry run (simulation only)"}`);
  console.log(`Mint: ${LAUNCH.mint}${mintKeypair ? " (keypair verified)" : " (keypair not loaded)"}`);
  console.log(`Payer / creator: ${LAUNCH.payer}${payerKeypair ? " (keypair verified)" : " (keypair not loaded)"}`);
  console.log(`Config: ${LAUNCH.config}`);
  console.log(`Pool: ${LAUNCH_POOL.toBase58()}`);
  console.log(`Name / symbol: ${LAUNCH.name} / ${LAUNCH.symbol}`);
  console.log(`Metadata URI: ${LAUNCH.metadataUrl} (${Buffer.byteLength(metadataJson)} bytes)`);
  console.log(`Logo: ${LAUNCH.imageUrl} (${logo.length} bytes, sha256 ${LAUNCH.imageSha256})`);

  if ((await connection.getGenesisHash()) !== MAINNET_GENESIS) throw new Error("RPC is not Solana mainnet");
  const [mintAccount, poolAccount, configAccount] = await connection.getMultipleAccountsInfo(
    [LAUNCH_MINT, LAUNCH_POOL, LAUNCH_CONFIG],
    "confirmed",
  );
  if (mintAccount || poolAccount) throw new Error("The mint or pool already exists on mainnet; this launch has already happened");
  if (!configAccount?.owner.equals(DBC_PROGRAM)) throw new Error("The DBC config is missing or not owned by the DBC program");
  const poolConfig = await clientFor(connection).state.getPoolConfig(LAUNCH_CONFIG);
  if (!poolConfig?.quoteMint.equals(new PublicKey(NATIVE_SOL_MINT))) throw new Error("Config is unreadable or its quote mint is not wrapped SOL");
  console.log(`Config pool creation fee: ${solString(BigInt(poolConfig.poolCreationFee.toString()))}`);

  const payerBalance = BigInt(await connection.getBalance(LAUNCH_PAYER, "confirmed"));
  const rentExemptMinimum = BigInt(await connection.getMinimumBalanceForRentExemption(0));
  const simulationPayer = payerBalance > 0n ? LAUNCH_PAYER : publicKey(options.simulationPayer, "--simulation-payer");
  console.log(`Payer balance: ${solString(payerBalance)}`);
  console.log(`Simulation fee payer: ${simulationPayer.toBase58()}${simulationPayer.equals(LAUNCH_PAYER) ? "" : " (public stand-in, sigVerify off)"}`);

  // Pass 1 measures compute units; pass 2 is the final shape with a tight compute unit limit.
  const probe = await simulate(connection, await buildLaunchTransaction(connection, simulationPayer, MAX_COMPUTE_UNITS, options.priorityMicroLamports));
  const computeUnitLimit = Math.min(MAX_COMPUTE_UNITS, Math.ceil(probe.units * 1.2) + 10_000);
  const standIn = await buildLaunchTransaction(connection, simulationPayer, computeUnitLimit, options.priorityMicroLamports);
  const measured = await simulate(connection, standIn);
  const real = await buildLaunchTransaction(connection, LAUNCH_PAYER, computeUnitLimit, options.priorityMicroLamports);
  const fee = await networkFee(connection, real);
  const cost = measureLaunchCost(measured.changes, simulationPayer.toBase58(), fee);
  const budget = planLaunchBudget(cost, rentExemptMinimum, payerBalance);

  console.log("\nSimulation: SUCCESS");
  console.log(`Compute units: ${measured.units} (limit ${computeUnitLimit}, price ${options.priorityMicroLamports} micro-lamports)`);
  console.log(`Instructions: ${real.transaction.instructions.length}; transaction size ${real.transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).length} bytes`);
  console.log("\nLamports received by each account:");
  const accounts = [];
  for (const change of measured.changes) {
    if (change.address === simulationPayer.toBase58()) continue;
    const delta = change.after - change.before;
    const rent = change.dataLength > 0 ? BigInt(await connection.getMinimumBalanceForRentExemption(change.dataLength)) : 0n;
    const extra = delta > 0n && change.before === 0n ? delta - rent : 0n;
    const label = LABELS.get(change.address) ?? "other writable account";
    accounts.push({ label, address: change.address, receivedLamports: delta.toString(), dataLength: change.dataLength, aboveRentLamports: extra.toString() });
    console.log(`  ${label.padEnd(28)} ${change.address.padEnd(44)} +${solString(delta)}  data ${change.dataLength} B${extra > 0n ? `  (${solString(extra)} above rent)` : ""}`);
  }
  console.log(`  ${"network fee".padEnd(28)} ${"(real payer message)".padEnd(44)} +${solString(fee)}`);
  console.log(`\nLaunch cost: ${solString(cost)}`);
  console.log(`Payer reserve (rent-exempt minimum + margin): ${solString(budget.reserveLamports)}`);
  console.log(`Required payer balance: ${solString(budget.requiredBalanceLamports)}`);
  console.log(`SEND ${solString(budget.toSendLamports)} to ${LAUNCH.payer}`);
  console.log(`Payer keeps after launch: ${solString(budget.leftoverLamports)}`);

  const report = {
    preparedAt: new Date().toISOString(),
    mode: options.send ? "send" : "dry-run",
    mint: LAUNCH.mint,
    config: LAUNCH.config,
    payer: LAUNCH.payer,
    pool: LAUNCH_POOL.toBase58(),
    baseVault: BASE_VAULT.toBase58(),
    quoteVault: QUOTE_VAULT.toBase58(),
    metaplexMetadata: MINT_METADATA.toBase58(),
    poolMetadata: POOL_METADATA.toBase58(),
    metadataUrl: LAUNCH.metadataUrl,
    imageUrl: LAUNCH.imageUrl,
    imageSha256: LAUNCH.imageSha256,
    simulationPayer: simulationPayer.toBase58(),
    computeUnits: measured.units,
    computeUnitLimit,
    priorityMicroLamports: options.priorityMicroLamports,
    networkFeeLamports: fee.toString(),
    accounts,
    costLamports: cost.toString(),
    payerBalanceLamports: payerBalance.toString(),
    requiredBalanceLamports: budget.requiredBalanceLamports.toString(),
    toSendLamports: budget.toSendLamports.toString(),
  };
  if (options.outDir) {
    mkdirSync(options.outDir, { recursive: true });
    writeOnce(join(options.outDir, LAUNCH.metadataKey), metadataJson);
    const reportPath = join(options.outDir, `launch-report-${report.preparedAt.replace(/[:.]/g, "-")}.json`);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    console.log(`\nMetadata file: ${join(options.outDir, LAUNCH.metadataKey)}`);
    console.log(`Report: ${reportPath}`);
  }

  if (!options.send) {
    console.log("\nDry run only: nothing was signed, uploaded or broadcast.");
    return;
  }

  if (!payerKeypair || !mintKeypair) throw new Error("--send requires both keypairs");
  if (payerBalance < cost + rentExemptMinimum) throw new Error("Refusing to send: the payer balance does not cover the launch");
  const hostedJson = Buffer.from(await verifyHosted(LAUNCH.metadataUrl)).toString("utf8");
  if (hostedJson !== metadataJson) throw new Error("Refusing to send: the hosted metadata JSON differs from the pinned bytes");
  assertOfficialLogo(await verifyHosted(LAUNCH.imageUrl));
  console.log("\nHosted metadata JSON and logo match the pinned bytes.");

  const final = await buildLaunchTransaction(connection, LAUNCH_PAYER, computeUnitLimit, options.priorityMicroLamports);
  await simulate(connection, final, [payerKeypair, mintKeypair]);
  const signed = new VersionedTransaction(final.transaction.compileMessage());
  signed.sign([payerKeypair, mintKeypair]);
  const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed", maxRetries: 5 });
  console.log(`Signature: ${signature}`);
  const confirmation = await connection.confirmTransaction(
    { signature, blockhash: final.transaction.recentBlockhash!, lastValidBlockHeight: final.transaction.lastValidBlockHeight! },
    "confirmed",
  );
  if (confirmation.value.err) throw new Error(`Transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  const [mintAfter, poolAfter] = await connection.getMultipleAccountsInfo([LAUNCH_MINT, LAUNCH_POOL], "confirmed");
  if (!mintAfter || !poolAfter) throw new Error("Confirmed, but the mint or pool is not visible yet; check the signature");
  console.log(`Confirmed. Pool ${LAUNCH_POOL.toBase58()} and mint ${LAUNCH.mint} exist on mainnet.`);
  if (options.outDir) {
    writeFileSync(join(options.outDir, "launch-sent.json"), `${JSON.stringify({ signature, sentAt: new Date().toISOString(), mint: LAUNCH.mint, pool: LAUNCH_POOL.toBase58() }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  }
}

main().catch((error: unknown) => {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
