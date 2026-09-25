import { Keypair, PublicKey } from "@solana/web3.js";
import {
  ADMIN_WALLET,
  DAMM_V2_PROGRAM_ID,
  DBC_PROGRAM_ID,
  NATIVE_SOL_MINT,
  buildDiggoConfig,
  clientFor,
  connectionFor,
  loadKeypair,
  option,
  parseCluster,
  publicKey,
  requiredOption,
  signAndConfirm,
  solString,
} from "./common.ts";

const args = process.argv.slice(2);
const cluster = parseCluster(option("cluster", args, 0) ?? "devnet");
const miningVault = publicKey(requiredOption("mining-vault", args), "mining vault");
const payer = await loadKeypair(requiredOption("payer", args));
const configKeypair = Keypair.generate();
const config = configKeypair.publicKey;
const connection = connectionFor(cluster, option("rpc-url", args, 0));
const client = clientFor(connection);
const configParameters = buildDiggoConfig(cluster);
console.log(`Cluster: ${cluster}`);
console.log(`Payer: ${payer.publicKey.toBase58()}`);
console.log(`Config: ${config.toBase58()}`);
console.log(`Mining vault: ${miningVault.toBase58()}`);
console.log(`feeClaimer/partner: ${ADMIN_WALLET}`);
console.log(`DBC program: ${DBC_PROGRAM_ID}`);
console.log(`DAMM v2 program: ${DAMM_V2_PROGRAM_ID}`);
console.log(`Quote mint: ${NATIVE_SOL_MINT}`);
const buildConfigTransaction = () =>
  client.partner.createConfig({
    ...configParameters,
    config,
    feeClaimer: new PublicKey(ADMIN_WALLET),
    leftoverReceiver: miningVault,
    quoteMint: new PublicKey(NATIVE_SOL_MINT),
    payer: payer.publicKey,
  });

if (cluster === "mainnet" && option("allow-mainnet", args, 0) === undefined) {
  const transaction = await buildConfigTransaction();
  transaction.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  transaction.feePayer = payer.publicKey;
  transaction.sign(payer, configKeypair);
  const simulation = await connection.simulateTransaction(transaction);
  // The DBC program creates its config account through CPI, so the transaction has no
  // top-level SystemProgram.createAccount instruction to inspect. The pinned SDK's live
  // config account is 1,048 bytes (the 8-byte account discriminator is included).
  const allocation = await connection.getMinimumBalanceForRentExemption(1_048);
  const payerRent = await connection.getMinimumBalanceForRentExemption(0);
  const transactionFee = await connection.getFeeForMessage(transaction.compileMessage(), "confirmed");
  if (transactionFee.value === null) {
    throw new Error("Could not determine the mainnet transaction fee");
  }
  const priorityFee = 0n;
  const configCost = BigInt(allocation) + BigInt(transactionFee.value) + priorityFee;
  const exactFunding = configCost + BigInt(payerRent);
  const recommendedFunding = 10_000_000n > exactFunding ? 10_000_000n : exactFunding;
  console.log(`Mainnet simulation: ${JSON.stringify(simulation.value)}`);
  console.log(`Config account rent exemption (1,048 bytes): ${allocation} lamports`);
  console.log(`New payer account rent exemption: ${payerRent} lamports`);
  console.log(`Transaction fee: ${transactionFee.value} lamports`);
  console.log(`Priority fee: ${priorityFee} lamports (none attached)`);
  console.log(`Estimated one-time config cost: ${configCost} lamports`);
  console.log(`Exact first-funding minimum (payer rent + config cost): ${exactFunding} lamports`);
  console.log(`Recommended payer funding: ${recommendedFunding} lamports (${solString(recommendedFunding)})`);
  console.log("Refusing mainnet create-config: pass --allow-mainnet after reviewing simulation and rent cost.");
  throw new Error("Refusing mainnet create-config: pass --allow-mainnet after review");
}

const result = await signAndConfirm(connection, payer, buildConfigTransaction, [configKeypair]);
console.log(`Signature: ${result.signature}`);
console.log(`Exact payer balance change (negative means spent): ${solString(result.lamports)} (${result.lamports} lamports)`);
const fetched = await client.state.getPoolConfig(config);
if (!fetched) throw new Error("Config account was not visible after confirmation");
console.log(`Config feeClaimer: ${new PublicKey(fetched.feeClaimer).toBase58()}`);
console.log(`Config leftover receiver: ${new PublicKey(fetched.leftoverReceiver).toBase58()}`);
console.log(`Config migration threshold: ${fetched.migrationQuoteThreshold.toString()} lamports`);
console.log(`Config pool creation fee: ${fetched.poolCreationFee.toString()} lamports`);
console.log("Verified: config account is readable on chain.");
