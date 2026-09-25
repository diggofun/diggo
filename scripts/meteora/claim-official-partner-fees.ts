import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PublicKey, sendAndConfirmRawTransaction } from "@solana/web3.js";
import {
  FEE_RECEIVER,
  MAX_CLAIM_AMOUNT,
  OFFICIAL_CONFIG,
  OFFICIAL_MINT,
  OFFICIAL_POOL,
  assertClaimSigners,
  combineClaimTransactions,
  parseClaimOptions,
  planOfficialClaim,
} from "./claim-official-partner-fees-core.ts";
import { clientFor, connectionFor, loadKeypair, solString } from "./common.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ASSOCIATED_TOKEN_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function externalKeypairPath(value: string): string {
  const path = realpathSync(value);
  const location = relative(REPO_ROOT, path);
  if (!isAbsolute(location) && location !== ".." && !location.startsWith(`..\\`) && !location.startsWith("../")) {
    throw new Error("Keypair files must be outside the repository");
  }
  return path;
}

async function main(): Promise<void> {
  const options = parseClaimOptions(process.argv.slice(2));
  // This command is intentionally mainnet-only. Its mint, config, pool, and receiver are fixed.
  const connection = connectionFor("mainnet", options.rpcUrl);
  const payerKeypair = options.payerKeypair ? await loadKeypair(externalKeypairPath(options.payerKeypair)) : undefined;
  const feeClaimerKeypair = options.feeClaimerKeypair ? await loadKeypair(externalKeypairPath(options.feeClaimerKeypair)) : undefined;
  const payer = payerKeypair?.publicKey ?? new PublicKey(options.payerPubkey!);
  if (options.payerPubkey && !payer.equals(new PublicKey(options.payerPubkey))) {
    throw new Error("--payer-pubkey does not match --payer-keypair");
  }
  if (feeClaimerKeypair && !feeClaimerKeypair.publicKey.equals(FEE_RECEIVER)) {
    throw new Error("--fee-claimer-keypair does not match the on-chain fee claimer");
  }

  const client = clientFor(connection);
  const [poolAccount, configAccount, pool, config] = await Promise.all([
    connection.getAccountInfo(OFFICIAL_POOL, "confirmed"),
    connection.getAccountInfo(OFFICIAL_CONFIG, "confirmed"),
    client.state.getPool(OFFICIAL_POOL),
    client.state.getPoolConfig(OFFICIAL_CONFIG),
  ]);
  if (!poolAccount || !configAccount || !pool || !config) throw new Error("Official pool or config is missing on mainnet");
  const plan = planOfficialClaim(OFFICIAL_POOL, poolAccount.owner, configAccount.owner, pool, config);
  console.log(`Cluster: mainnet`);
  console.log(`Pool: ${OFFICIAL_POOL.toBase58()}`);
  console.log(`Mint: ${OFFICIAL_MINT.toBase58()}`);
  console.log(`Config: ${OFFICIAL_CONFIG.toBase58()}`);
  console.log(`Fee claimer and exact destination: ${FEE_RECEIVER.toBase58()}`);
  console.log(`Payer: ${payer.toBase58()}`);
  console.log(`Unclaimed partner trading fees: base ${plan.tradingBase.toString()} units; quote ${plan.tradingQuote.toString()} lamports (${solString(BigInt(plan.tradingQuote.toString()))})`);
  console.log(`Creation fee configured on-chain: ${plan.creationFeeLamports} lamports; partner creation claim: ${plan.claimCreation ? "available" : "already claimed or zero"}`);
  if (!plan.claimTrading && !plan.claimCreation) {
    console.log("Nothing claimable; no transaction built or sent.");
    return;
  }

  const trading = plan.claimTrading ? await client.partner.claimPartnerTradingFeeToReceiver({
    feeClaimer: FEE_RECEIVER,
    payer,
    pool: OFFICIAL_POOL,
    // U64 max makes this an ALL claim even if another trade accrues between the read and send.
    maxBaseAmount: MAX_CLAIM_AMOUNT,
    maxQuoteAmount: MAX_CLAIM_AMOUNT,
    receiver: FEE_RECEIVER,
  }) : undefined;
  const creation = plan.claimCreation ? await client.partner.claimPartnerPoolCreationFee({
    pool: OFFICIAL_POOL,
    feeReceiver: FEE_RECEIVER,
  }) : undefined;
  const transaction = combineClaimTransactions(trading, creation);
  if (!transaction) throw new Error("No claim instructions were built");
  const latest = await connection.getLatestBlockhash("confirmed");
  transaction.recentBlockhash = latest.blockhash;
  transaction.feePayer = payer;
  assertClaimSigners(transaction, payer);
  const fee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  if (fee.value === null) throw new Error("Could not estimate the network transaction fee");
  const balance = await connection.getBalance(payer, "confirmed");
  const ataAddresses = transaction.instructions
    .filter((instruction) => instruction.programId.equals(ASSOCIATED_TOKEN_PROGRAM))
    .map((instruction) => instruction.keys[1]?.pubkey)
    .filter((key): key is PublicKey => key !== undefined);
  const ataAccounts = ataAddresses.length ? await connection.getMultipleAccountsInfo(ataAddresses, "confirmed") : [];
  const missingAtas = ataAccounts.filter((account) => account === null).length;
  const ataRentEach = missingAtas ? await connection.getMinimumBalanceForRentExemption(165, "confirmed") : 0;
  const upfrontCost = fee.value + missingAtas * ataRentEach;
  console.log(`Instructions: ${transaction.instructions.length}; claims: ${[plan.claimTrading ? "trading" : "", plan.claimCreation ? "pool creation" : ""].filter(Boolean).join(" + ")}`);
  console.log(`Estimated network fee: ${fee.value} lamports (${solString(BigInt(fee.value))}); payer balance: ${balance} lamports`);
  console.log(`Potential ATA rent: ${missingAtas} account(s) x ${ataRentEach} lamports; estimated upfront payer cost: ${upfrontCost} lamports (${solString(BigInt(upfrontCost))})`);
  const simulation = await connection.simulateTransaction(transaction);
  console.log(`Simulation: ${simulation.value.err ? JSON.stringify(simulation.value.err) : "success"}; compute units: ${simulation.value.unitsConsumed ?? "unavailable"}`);
  if (simulation.value.err) throw new Error("Simulation failed; no transaction sent");
  if (balance < upfrontCost) throw new Error("Payer balance is below the estimated upfront cost; no transaction sent");
  if (!options.send) {
    console.log("Dry-run complete. No transaction sent. Use --send with both keypair files only after review.");
    return;
  }
  if (!payerKeypair || !feeClaimerKeypair) throw new Error("--send requires both keypair files");
  transaction.sign(payerKeypair, ...(payerKeypair.publicKey.equals(feeClaimerKeypair.publicKey) ? [] : [feeClaimerKeypair]));
  const signature = await sendAndConfirmRawTransaction(connection, transaction.serialize(), {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
    skipPreflight: false,
  });
  console.log(`Signature: ${signature}`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Claim preparation failed: ${message.replace(/https?:\/\/\S+/g, "[RPC URL redacted]")}`);
  process.exitCode = 1;
});
