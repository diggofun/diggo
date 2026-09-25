import BN from "bn.js";
import {
  PLATFORM_FEE_WALLET,
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
const pool = publicKey(requiredOption("pool", args), "pool");
const receiver = publicKey(PLATFORM_FEE_WALLET, "receiver");
const requestedReceiver = option("receiver", args, 0);
if (requestedReceiver && requestedReceiver !== receiver.toBase58()) {
  throw new Error(`--receiver must be the canonical platform fee wallet: ${PLATFORM_FEE_WALLET}`);
}
const feeClaimer = await loadKeypair(requiredOption("fee-claimer", args));
const expectedFeeClaimer = receiver.toBase58();
if (feeClaimer.publicKey.toBase58() !== expectedFeeClaimer) {
  throw new Error(`--fee-claimer must match the canonical platform fee wallet: ${expectedFeeClaimer}`);
}
const payer = await loadKeypair(requiredOption("payer", args));
const connection = connectionFor(cluster, option("rpc-url", args, 0));
const client = clientFor(connection);
const virtualPool = await client.state.getPool(pool);
if (!virtualPool) throw new Error("Pool account was not found");
const poolConfig = await client.state.getPoolConfig(virtualPool.poolState.config);
if (!poolConfig) throw new Error("Pool config account was not found");
const configuredFeeClaimer = poolConfig.feeClaimer.toBase58();
if (configuredFeeClaimer !== expectedFeeClaimer) {
  throw new Error(
    `Pool config fee claimer is ${configuredFeeClaimer}; expected ${expectedFeeClaimer}`,
  );
}
const result = await signAndConfirm(
  connection,
  payer,
  () =>
    client.partner.claimPartnerTradingFeeToReceiver({
      feeClaimer: feeClaimer.publicKey,
      payer: payer.publicKey,
      pool,
      maxBaseAmount: new BN("1000000000000"),
      maxQuoteAmount: new BN("1000000000000"),
      receiver,
    }),
  feeClaimer.publicKey.equals(payer.publicKey) ? [] : [feeClaimer],
);
console.log(`Pool: ${pool.toBase58()}`);
console.log(`Config: ${virtualPool.poolState.config.toBase58()}`);
console.log(`Receiver: ${receiver.toBase58()}`);
console.log(`Signature: ${result.signature}`);
console.log(`Exact payer balance change (negative means spent): ${solString(result.lamports)} (${result.lamports} lamports)`);
