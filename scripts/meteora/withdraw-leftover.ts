import {
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
const payer = await loadKeypair(requiredOption("payer", args));
const connection = connectionFor(cluster, option("rpc-url", args, 0));
const client = clientFor(connection);
const result = await signAndConfirm(connection, payer, () =>
  client.migration.withdrawLeftover({ payer: payer.publicKey, pool }),
);
console.log(`Pool: ${pool.toBase58()}`);
console.log("Leftover receiver is the mining vault configured at pool creation.");
console.log(`Signature: ${result.signature}`);
console.log(`Exact payer balance change (negative means spent): ${solString(result.lamports)} (${result.lamports} lamports)`);
