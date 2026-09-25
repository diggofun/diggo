import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { externalPath, requiredOption } from "./common.ts";

const output = externalPath(requiredOption("output", process.argv.slice(2)), "output keypair");
if (existsSync(output)) throw new Error(`refusing to overwrite ${output}`);
const keypair = Keypair.generate();
mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
writeFileSync(output, JSON.stringify(Array.from(keypair.secretKey)), { mode: 0o600 });
console.log(`Mining vault public key: ${keypair.publicKey.toBase58()}`);
console.log(`Keypair written outside the repository: ${output}`);
console.log("Keep this file offline. Set MINING_VAULT_SECRET to its base58 secret in the Worker environment only after backing it up securely.");
