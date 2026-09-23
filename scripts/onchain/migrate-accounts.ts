/**
 * Migrates the protocol config, every mine and every market to the current account layout.
 *
 * Adding a field to an Anchor account is not free: an account written before the field
 * existed is one byte short, so the current program cannot deserialize it until it has
 * been reallocated. migrate_account does that in place and is guardian-only. It reallocates
 * the account to the current size and stamps the trailing version byte, copying every byte
 * that already existed verbatim — no balance, reserve, fee bucket or timestamp can move.
 *
 * The account must already hold enough lamports for its new rent-exempt minimum, because
 * migrate_account deliberately never touches lamports. This script tops the account up
 * first with a plain system transfer when it needs to, then migrates it.
 *
 * Dry-run by default. Pass --execute to send. See docs/ONCHAIN.md for the runbook.
 *
 * Usage:
 *   node scripts/onchain/migrate-accounts.ts
 *   node scripts/onchain/migrate-accounts.ts --execute --guardian-keypair ~/.config/solana/guardian.json
 *   node scripts/onchain/migrate-accounts.ts --execute --mints <mint1>,<mint2>
 */
import { AccountRole, address, type Address, type Instruction, type Rpc, type SolanaRpcApi } from "@solana/kit";
import bs58 from "bs58";
import {
  ACCOUNT_DISCRIMINATOR,
  ACCOUNT_VERSION,
  MIGRATABLE_ACCOUNT_KIND,
  SYSTEM_PROGRAM_ADDRESS,
  buildMigrateAccountInstruction,
  decodeLaunchMarket,
  decodeMine,
  decodeProtocolConfig,
  deriveMarketPda,
  deriveMinePda,
  deriveProtocolPda,
  type MigratableAccountKind,
} from "../../shared/program.ts";
import {
  DEFAULT_RPC_URL,
  abort,
  flag,
  heading,
  optional,
  parseArgs,
  readAccount,
  row,
  run,
  rpcFor,
  sendAndConfirm,
  shortAddress,
  tryLoadKeypairSigner,
} from "./lib.ts";

/** The diggo_protocol program id; matches Anchor.toml and wrangler.jsonc. */
const DEFAULT_PROGRAM_ID = "48WgfSPnEPitiasXV5B3aLpeAWtUisSt6YSR6djDZebC";

const KIND_BY_NAME: Record<string, MigratableAccountKind> = {
  protocol: MIGRATABLE_ACCOUNT_KIND.protocol,
  mine: MIGRATABLE_ACCOUNT_KIND.mine,
  market: MIGRATABLE_ACCOUNT_KIND.market,
};

const DISCRIMINATOR_BY_KIND: Record<number, readonly number[]> = {
  [MIGRATABLE_ACCOUNT_KIND.protocol]: ACCOUNT_DISCRIMINATOR.protocolConfig,
  [MIGRATABLE_ACCOUNT_KIND.mine]: ACCOUNT_DISCRIMINATOR.mine,
  [MIGRATABLE_ACCOUNT_KIND.market]: ACCOUNT_DISCRIMINATOR.launchMarket,
};

/** The layout version an account currently carries; 0 means it predates the field. */
function readVersion(kind: MigratableAccountKind, data: Uint8Array): number {
  switch (kind) {
    case MIGRATABLE_ACCOUNT_KIND.protocol:
      return decodeProtocolConfig(data).version;
    case MIGRATABLE_ACCOUNT_KIND.mine:
      return decodeMine(data).version;
    case MIGRATABLE_ACCOUNT_KIND.market:
      return decodeLaunchMarket(data).version;
    default:
      return abort("unknown account kind " + kind);
  }
}

/**
 * SystemInstruction::Transfer is variant 2 of the system program instruction enum: a u32
 * little-endian tag followed by the lamports as a u64. The source must sign.
 */
function transferSolInstruction(source: Address, destination: Address, lamports: bigint): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, lamports, true);
  return {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: source, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE },
    ],
    data,
  };
}

interface Target {
  kind: MigratableAccountKind;
  account: Address;
  label: string;
}

async function discoverByKind(
  rpc: Rpc<SolanaRpcApi>,
  programAddress: Address,
  kind: MigratableAccountKind,
): Promise<Target[]> {
  const discriminator = bs58.encode(Uint8Array.from(DISCRIMINATOR_BY_KIND[kind]));
  const accounts = await rpc
    .getProgramAccounts(programAddress, {
      commitment: "confirmed",
      encoding: "base64",
      filters: [
        {
          // The RPC filter types are branded strings in @solana/rpc-types, which these
          // operator scripts deliberately do not depend on directly; at runtime this is an
          // ordinary base58 string, so the brand is erased here and nowhere else.
          memcmp: { offset: 0n, bytes: discriminator as never, encoding: "base58" },
        },
      ],
    })
    .send();
  return accounts.map((entry) => ({
    kind,
    account: entry.pubkey,
    label: "kind " + kind,
  }));
}

const KNOWN_FLAGS = ["execute", "rpc", "program", "guardian-keypair", "kinds", "mints", "max"];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), KNOWN_FLAGS);
  const execute = flag(options, "execute");
  const rpcUrl = optional(options, "rpc") ?? DEFAULT_RPC_URL;
  const programAddress = address(optional(options, "program") ?? DEFAULT_PROGRAM_ID);
  const rpc = rpcFor(rpcUrl);
  const guardianPath = optional(options, "guardian-keypair") ?? "~/.config/solana/id.json";
  const guardian = await tryLoadKeypairSigner(guardianPath);
  const maxTargets = Number(optional(options, "max") ?? "0");

  const kinds = (optional(options, "kinds") ?? "protocol,mine,market")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .map((name) => {
      const kind = KIND_BY_NAME[name];
      if (kind === undefined) abort("unknown kind " + name + " (expected protocol, mine or market)");
      return kind;
    });

  const protocolPda = await deriveProtocolPda(programAddress);
  const mints = (optional(options, "mints") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const targets: Target[] = [];
  if (kinds.includes(MIGRATABLE_ACCOUNT_KIND.protocol)) {
    targets.push({ kind: MIGRATABLE_ACCOUNT_KIND.protocol, account: protocolPda, label: "protocol config" });
  }

  if (mints.length > 0) {
    for (const mint of mints) {
      const mintAddress = address(mint);
      if (kinds.includes(MIGRATABLE_ACCOUNT_KIND.mine)) {
        targets.push({
          kind: MIGRATABLE_ACCOUNT_KIND.mine,
          account: await deriveMinePda(programAddress, mintAddress),
          label: "mine for " + shortAddress(mint),
        });
      }
      if (kinds.includes(MIGRATABLE_ACCOUNT_KIND.market)) {
        targets.push({
          kind: MIGRATABLE_ACCOUNT_KIND.market,
          account: await deriveMarketPda(programAddress, mintAddress),
          label: "market for " + shortAddress(mint),
        });
      }
    }
  } else {
    for (const kind of kinds) {
      if (kind === MIGRATABLE_ACCOUNT_KIND.protocol) continue;
      try {
        const found = await discoverByKind(rpc, programAddress, kind);
        for (const target of found) {
          targets.push({ ...target, label: "kind " + kind + " " + shortAddress(target.account) });
        }
      } catch (error) {
        abort(
          "getProgramAccounts failed for kind " +
            kind +
            " (" +
            String(error) +
            "). Pass --mints <mint1>,<mint2> to migrate specific mines instead.",
        );
      }
    }
  }

  heading("Diggo account migration plan");
  row("rpc", rpcUrl);
  row("program", programAddress);
  row("guardian", guardian ? guardian.address : "(keypair not loaded — " + guardianPath + ")");
  row("accounts discovered", String(targets.length));

  const planned: Array<{
    target: Target;
    newLength: number;
    topUp: bigint;
    instruction: Instruction;
  }> = [];
  let current = 0;
  let missing = 0;

  for (const target of targets) {
    if (maxTargets > 0 && planned.length >= maxTargets) break;
    const snapshot = await readAccount(rpc, target.account);
    if (!snapshot) {
      missing++;
      continue;
    }
    const version = readVersion(target.kind, snapshot.data);
    if (version >= ACCOUNT_VERSION) {
      current++;
      continue;
    }
    // The migration appends exactly one byte, so the target size is the current size plus
    // one — which is what the previous program version allocated as 8 + INIT_SPACE.
    const newLength = snapshot.dataLength + 1;
    const rentMinimum = await rpc.getMinimumBalanceForRentExemption(BigInt(newLength)).send();
    const topUp = snapshot.lamports < rentMinimum ? rentMinimum - snapshot.lamports : 0n;
    planned.push({
      target,
      newLength,
      topUp,
      instruction: buildMigrateAccountInstruction({
        programAddress,
        guardian: (guardian?.address ?? protocolPda) as Address,
        protocol: protocolPda,
        target: target.account,
        kind: target.kind,
      }),
    });
  }

  heading("Summary");
  row("already current", String(current));
  row("not found (skipped)", String(missing));
  row("to migrate", String(planned.length));
  const totalTopUp = planned.reduce((sum, entry) => sum + entry.topUp, 0n);
  row("rent top-up needed", totalTopUp.toString() + " lamports");

  if (planned.length === 0) {
    console.log("");
    console.log(
      current > 0
        ? "Every discovered account is already on the current layout."
        : "Nothing to migrate: no account of the requested kinds was found at those addresses.",
    );
    return;
  }

  if (!execute) {
    heading("Would migrate");
    for (const entry of planned) {
      console.log(
        "  " +
          entry.target.label.padEnd(52) +
          entry.target.account +
          "  " +
          (entry.topUp > 0n ? "top up " + entry.topUp.toString() + " then realloc to " : "realloc to ") +
          entry.newLength,
      );
    }
    console.log("");
    console.log("Dry run: nothing was sent. Re-run with --execute to apply.");
    console.log("Note that accounts are unreadable by the current program until they are migrated.");
    return;
  }

  if (!guardian) {
    abort(
      "cannot execute without the guardian keypair. Pass --guardian-keypair pointing at the " +
        "current guardian (" +
        guardianPath +
        " was not usable).",
    );
  }

  heading("Migrating");
  let migrated = 0;
  for (const entry of planned) {
    if (entry.topUp > 0n) {
      const topUpSignature = await sendAndConfirm(rpc, guardian, [
        transferSolInstruction(guardian.address, entry.target.account, entry.topUp),
      ]);
      console.log("  funded " + entry.target.account + " -> " + topUpSignature);
    }
    const signature = await sendAndConfirm(rpc, guardian, [entry.instruction]);
    migrated++;
    console.log("  migrated " + entry.target.label + " -> " + signature);
  }

  heading("Verifying");
  let failures = 0;
  for (const entry of planned) {
    const snapshot = await readAccount(rpc, entry.target.account);
    const ok =
      snapshot !== null &&
      snapshot.dataLength === entry.newLength &&
      readVersion(entry.target.kind, snapshot.data) === ACCOUNT_VERSION;
    if (!ok) failures++;
    console.log("  " + (ok ? "ok   " : "FAIL ") + entry.target.account);
  }
  console.log("");
  console.log("Migrated " + migrated + " account(s); " + failures + " failed verification.");
  if (failures > 0) process.exitCode = 1;
}

run(main);
