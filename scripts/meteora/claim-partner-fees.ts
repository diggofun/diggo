import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  ADMIN_WALLET,
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
const receiver = publicKey(option("receiver", args, 0) ?? ADMIN_WALLET, "receiver");
const payer = await loadKeypair(requiredOption("payer", args));
const connection = connectionFor(cluster, option("rpc-url", args, 0));
const client = clientFor(connection);
const result = await signAndConfirm(connection, payer, () =>
  client.partner.claimPartnerTradingFeeToReceiver({
    feeClaimer: new PublicKey(ADMIN_WALLET),
    payer: payer.publicKey,
    pool,
    maxBaseAmount: new BN("1000000000000"),
    maxQuoteAmount: new BN("1000000000000"),
    receiver,
  }),
);
console.log(`Pool: ${pool.toBase58()}`);
console.log(`Receiver: ${receiver.toBase58()}`);
console.log(`Signature: ${result.signature}`);
console.log(`Exact payer balance change (negative means spent): ${solString(result.lamports)} (${result.lamports} lamports)`);
