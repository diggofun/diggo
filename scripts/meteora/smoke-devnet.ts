import {
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { deriveDbcPoolAddress } from "@meteora-ag/dynamic-bonding-curve-sdk";
import { SwapMode } from "@meteora-ag/dynamic-bonding-curve-sdk";
import BN from "bn.js";
import {
  loadKeypair,
  option,
  parseCluster,
  publicKey,
  requiredOption,
  signAndConfirm,
  sol,
  solString,
  connectionFor,
  clientFor,
} from "./common.ts";

const args = process.argv.slice(2);
const cluster = parseCluster(option("cluster", args, 0) ?? "devnet");
if (cluster !== "devnet") throw new Error("smoke-devnet.ts only runs against devnet");
const payer = await loadKeypair(requiredOption("payer", args));
const config = publicKey(requiredOption("config", args), "config");
const rpcUrl = option<string>("rpc-url", args, 0);
const connection = connectionFor(cluster, rpcUrl);
const client = clientFor(connection);
const baseMint = Keypair.generate();
const pool = deriveDbcPoolAddress(
  new PublicKey("So11111111111111111111111111111111111111112"),
  baseMint.publicKey,
  config,
);
const buyAmount = sol(Number(option<string>("buy-sol", args, 0) ?? 0.02));
const buyAmountBn = new BN(buyAmount.toString());
const requiredBalance = buyAmount + sol(0.01);
let balance = await connection.getBalance(payer.publicKey, "confirmed");
if (BigInt(balance) < requiredBalance) {
  console.log(`Requesting ${solString(requiredBalance - BigInt(balance))} devnet SOL for ${payer.publicKey.toBase58()}`);
  const missing = requiredBalance - BigInt(balance);
  const airdropLamports = Number(missing);
  if (!Number.isSafeInteger(airdropLamports)) throw new Error("airdrop amount exceeds JavaScript safe integer range");
  const signature = await connection.requestAirdrop(payer.publicKey, airdropLamports);
  const blockhash = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...blockhash }, "confirmed");
  balance = await connection.getBalance(payer.publicKey, "confirmed");
}
if (BigInt(balance) < requiredBalance) throw new Error("airdrop did not fund the required devnet balance");

const poolResult = await signAndConfirm(connection, payer, () =>
  client.creator.createPoolWithFirstBuy({
    createPoolParam: {
      baseMint: baseMint.publicKey,
      config,
      name: "Diggo Devnet Smoke",
      symbol: "DGBI",
      uri: "https://diggo.fun/",
      payer: payer.publicKey,
      poolCreator: payer.publicKey,
    },
    firstBuyParam: {
      buyer: payer.publicKey,
      receiver: payer.publicKey,
      buyAmount: buyAmountBn,
      minimumAmountOut: new BN(1),
      referralTokenAccount: null,
    },
  }),
  [baseMint],
);
console.log(`Base mint: ${baseMint.publicKey.toBase58()}`);
console.log(`Pool: ${pool.toBase58()}`);
console.log(`Pool + first buy signature: ${poolResult.signature}`);
console.log(`Pool + first buy exact payer balance change (negative means spent): ${solString(poolResult.lamports)}`);

let state = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  state = await client.state.getPool(pool);
  if (state) break;
  await new Promise((resolve) => setTimeout(resolve, 1_000));
}
if (!state) throw new Error("pool account was not visible after confirmation");
const ata = getAssociatedTokenAddressSync(baseMint.publicKey, payer.publicKey, true, TOKEN_PROGRAM_ID);
const tokenAccount = await connection.getTokenAccountBalance(ata, "confirmed");
const bought = BigInt(tokenAccount.value.amount);
if (bought <= 1n) throw new Error("first buy produced no test tokens");
const sellAmount = bought / 2n;
const configState = await client.state.getPoolConfig(config);
if (!configState) throw new Error("config account was not visible");
const quote = client.pool.swapQuote2({
  virtualPool: state,
  config: configState,
  swapBaseForQuote: true,
  hasReferral: false,
  eligibleForFirstSwapWithMinFee: false,
  currentPoint: new BN(Math.floor(Date.now() / 1_000).toString()),
  slippageBps: 500,
  swapMode: SwapMode.ExactIn,
  amountIn: new BN(sellAmount.toString()),
});
const sellResult = await signAndConfirm(connection, payer, () =>
  client.pool.swap2({
    owner: payer.publicKey,
    payer: payer.publicKey,
    pool,
    swapBaseForQuote: true,
    referralTokenAccount: null,
    swapMode: SwapMode.ExactIn,
    amountIn: new BN(sellAmount.toString()),
    minimumAmountOut: quote.minimumAmountOut ?? new BN(0),
  }),
);
console.log(`Buy amount: ${solString(buyAmount)}`);
console.log(`Tokens bought: ${bought}`);
console.log(`Sold amount: ${sellAmount}`);
console.log(`Quoted sell minimum output: ${quote.minimumAmountOut?.toString() ?? "0"}`);
console.log(`Sell signature: ${sellResult.signature}`);
console.log(`Sell exact payer balance change (positive means received after fees): ${solString(sellResult.lamports)}`);
console.log(`Smoke config: ${config.toBase58()}`);
console.log("Smoke test complete: pool creation, first buy, and sell all confirmed.");
