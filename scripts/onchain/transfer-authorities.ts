/**
 * Transfers the three Diggo authorities — the program upgrade authority, the guardian and
 * the keeper — to a Squads multisig address given on the command line.
 *
 * Why all three at once: they are the complete set of keys that can change the protocol.
 * The upgrade authority is the strongest of them (it can replace the program itself, and
 * therefore any rule in it), the guardian can flip the scoped circuit breakers and tune the
 * bounded parameters, and the keeper can push Crew Power and pay approved discoveries.
 * Nothing else about the deployment is key-controlled: the mining and discovery reserves,
 * the graduated pool and every player balance live in PDAs that no authority can withdraw.
 * See docs/ONCHAIN.md for the full set_upgrade_path runbook.
 *
 * Dry-run by default, and the dry run needs no keys at all: it reads the chain first, prints
 * exactly what it would change and who would sign each step, and only loads keypairs to check
 * that they really are the current authorities. Pass --execute to send. Each step is skipped
 * when the on-chain value already equals the target, so re-running after a partial failure is
 * safe.
 *
 * Usage:
 *   node scripts/onchain/transfer-authorities.ts --multisig <SQUADS_ADDRESS>
 *   node scripts/onchain/transfer-authorities.ts --multisig <SQUADS_ADDRESS> --execute
 */
import { AccountRole, address, type Address, type Instruction, type KeyPairSigner } from "@solana/kit";
import bs58 from "bs58";
import {
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  buildRotateGuardianInstruction,
  buildRotateKeeperInstruction,
  decodeProtocolConfig,
  deriveProgramDataAddress,
  deriveProtocolPda,
} from "../../shared/program.ts";
import {
  DEFAULT_RPC_URL,
  abort,
  flag,
  heading,
  optional,
  parseArgs,
  readAccount,
  required,
  row,
  run,
  rpcFor,
  sendAndConfirm,
  shortAddress,
  tryLoadKeypairSigner,
} from "./lib.ts";

/** The diggo_protocol program id; matches Anchor.toml and wrangler.jsonc. */
const DEFAULT_PROGRAM_ID = "H3Y8GgTnvwv5U1bajfzj386YSPC48vvwjFroXYyHZFj5";

/**
 * Owners that mean "this is an ordinary account, not a multisig". A plain wallet is owned by
 * the system program; the system program's own address is owned by the native loader.
 */
const NOT_A_MULTISIG_OWNERS = new Set<string>([
  SYSTEM_PROGRAM_ADDRESS,
  "NativeLoader1111111111111111111111111111111",
]);

/**
 * Bincode layout of UpgradeableLoaderState::ProgramData: a u32 tag, a u64 slot, then an
 * Option<Pubkey> upgrade authority as a one-byte present flag followed by 32 bytes. So the
 * flag sits at offset 12 and the authority at offset 13.
 */
const PROGRAM_DATA_TAG = 3;
const UPGRADE_AUTHORITY_FLAG_OFFSET = 12;
const UPGRADE_AUTHORITY_OFFSET = 13;

/**
 * Bincode tag of UpgradeableLoaderInstruction::SetAuthority: the fifth variant, after
 * InitializeBuffer, Write, DeployWithMaxDataLen and Upgrade. The new authority comes from the
 * third account key, so the instruction data is only the tag. SetAuthority (rather than
 * SetAuthorityChecked) is used on purpose: the new authority is a multisig, which cannot sign
 * a single transaction as an ordinary keypair.
 */
const SET_AUTHORITY_TAG = 4;

function parseUpgradeAuthority(data: Uint8Array): Address | null {
  if (data.byteLength < UPGRADE_AUTHORITY_OFFSET + 32) abort("program data account is too small");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint32(0, true) !== PROGRAM_DATA_TAG) abort("program data account has an unexpected tag");
  if (data[UPGRADE_AUTHORITY_FLAG_OFFSET] === 0) return null;
  return address(bs58.encode(data.subarray(UPGRADE_AUTHORITY_OFFSET, UPGRADE_AUTHORITY_OFFSET + 32)));
}

interface PlannedStep {
  label: string;
  from: string;
  signerPath: string;
  signer: KeyPairSigner | null;
  instruction: Instruction;
}

const KNOWN_FLAGS = [
  "multisig",
  "execute",
  "rpc",
  "program",
  "upgrade-authority-keypair",
  "guardian-keypair",
  "keeper-keypair",
  "expect-owner",
];

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2), KNOWN_FLAGS);
  const execute = flag(options, "execute");
  const rpcUrl = optional(options, "rpc") ?? DEFAULT_RPC_URL;
  const programAddress = address(optional(options, "program") ?? DEFAULT_PROGRAM_ID);
  const multisig = address(required(options, "multisig"));
  const rpc = rpcFor(rpcUrl);

  const upgradeAuthorityPath = optional(options, "upgrade-authority-keypair") ?? "~/.config/solana/id.json";
  const guardianPath = optional(options, "guardian-keypair") ?? "~/.config/solana/id.json";
  const keeperPath = optional(options, "keeper-keypair") ?? "~/.config/solana/id.json";

  const programData = await deriveProgramDataAddress(programAddress);
  const protocolPda = await deriveProtocolPda(programAddress);
  const [multisigAccount, programDataAccount, protocolAccount] = await Promise.all([
    readAccount(rpc, multisig),
    readAccount(rpc, programData),
    readAccount(rpc, protocolPda),
  ]);

  heading("Diggo authority transfer plan");
  row("rpc", rpcUrl);
  row("program", programAddress);
  row("program data", programData);
  row("protocol config", protocolPda);
  row("target multisig", multisig);

  if (!multisigAccount) abort("there is no account at " + multisig + " — a Squads multisig must exist first");
  row("multisig owner", multisigAccount.owner);
  const expectOwner = optional(options, "expect-owner");
  if (expectOwner && multisigAccount.owner !== expectOwner) {
    abort("multisig owner is " + multisigAccount.owner + " but --expect-owner says " + expectOwner);
  }
  if (NOT_A_MULTISIG_OWNERS.has(multisigAccount.owner)) {
    abort("the target is a plain system account, not a multisig — refusing to hand over control");
  }

  if (!programDataAccount) abort("no program data account at " + programData + " — is the program deployed?");
  const currentUpgradeAuthority = parseUpgradeAuthority(programDataAccount.data);
  if (!protocolAccount) abort("no protocol config at " + protocolPda + " — is the protocol initialized?");
  const protocol = decodeProtocolConfig(protocolAccount.data);

  heading("Current authorities");
  row("upgrade authority", currentUpgradeAuthority ?? "(none — immutable program)");
  row("guardian", protocol.guardian);
  row("keeper", protocol.keeper);
  row("treasury (unchanged)", protocol.treasury);
  row("layout version", String(protocol.version));

  const needsUpgradeSigner = currentUpgradeAuthority !== null && currentUpgradeAuthority !== multisig;
  const needsGuardianSigner = protocol.guardian !== multisig;
  const needsKeeperSigner = protocol.keeper !== multisig;

  const upgradeSigner = needsUpgradeSigner ? await tryLoadKeypairSigner(upgradeAuthorityPath) : null;
  const guardianSigner = needsGuardianSigner ? await tryLoadKeypairSigner(guardianPath) : null;
  const keeperSigner = needsKeeperSigner ? await tryLoadKeypairSigner(keeperPath) : null;

  const steps: PlannedStep[] = [];

  if (!needsUpgradeSigner) {
    row("upgrade authority", currentUpgradeAuthority === null ? "already immutable" : "already the multisig");
  } else {
    if (upgradeSigner && currentUpgradeAuthority !== upgradeSigner.address) {
      abort(
        "the keypair at " +
          upgradeAuthorityPath +
          " (" +
          upgradeSigner.address +
          ") is not the on-chain upgrade authority (" +
          currentUpgradeAuthority +
          ")",
      );
    }
    steps.push({
      label: "program upgrade authority",
      from: currentUpgradeAuthority,
      signerPath: upgradeAuthorityPath,
      signer: upgradeSigner,
      instruction: {
        programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
        accounts: [
          { address: programData, role: AccountRole.WRITABLE },
          { address: (upgradeSigner?.address ?? currentUpgradeAuthority) as Address, role: AccountRole.READONLY_SIGNER },
          { address: multisig, role: AccountRole.READONLY },
        ],
        data: Uint8Array.from([SET_AUTHORITY_TAG, 0, 0, 0]),
      },
    });
  }

  if (!needsGuardianSigner) {
    row("guardian", "already the multisig");
  } else {
    if (guardianSigner && protocol.guardian !== guardianSigner.address) {
      abort(
        "the keypair at " +
          guardianPath +
          " (" +
          guardianSigner.address +
          ") is not the on-chain guardian (" +
          protocol.guardian +
          ")",
      );
    }
    steps.push({
      label: "protocol guardian",
      from: protocol.guardian,
      signerPath: guardianPath,
      signer: guardianSigner,
      instruction: buildRotateGuardianInstruction({
        programAddress,
        guardian: (guardianSigner?.address ?? protocol.guardian) as Address,
        protocol: protocolPda,
        newGuardian: multisig,
      }),
    });
  }

  if (!needsKeeperSigner) {
    row("keeper", "already the multisig");
  } else {
    if (keeperSigner && protocol.keeper !== keeperSigner.address) {
      abort(
        "the keypair at " +
          keeperPath +
          " (" +
          keeperSigner.address +
          ") is not the on-chain keeper (" +
          protocol.keeper +
          ")",
      );
    }
    steps.push({
      label: "protocol keeper",
      from: protocol.keeper,
      signerPath: keeperPath,
      signer: keeperSigner,
      instruction: buildRotateKeeperInstruction({
        programAddress,
        keeper: (keeperSigner?.address ?? protocol.keeper) as Address,
        protocol: protocolPda,
        newKeeper: multisig,
      }),
    });
  }

  heading("Steps");
  if (steps.length === 0) {
    console.log("  every authority is already the multisig; nothing to do");
    return;
  }
  for (const [index, step] of steps.entries()) {
    console.log("  " + (index + 1) + ". " + step.label + "  ->  " + multisig);
    console.log("       from      " + step.from);
    console.log("       signed by " + (step.signer ? shortAddress(step.signer.address) : "NOT LOADED — " + step.signerPath));
  }

  if (!execute) {
    console.log("");
    console.log("Dry run: nothing was sent. Re-run with --execute to apply the plan above.");
    const unloaded = steps.filter((step) => !step.signer);
    if (unloaded.length > 0) {
      console.log("Before executing, make sure these are the current authorities:");
      for (const step of unloaded) console.log("  --" + step.label.split(" ").slice(-1)[0] + "-keypair  (currently " + step.from + ")");
    }
    console.log("Afterwards the deployer key holds no authority over the protocol at all.");
    return;
  }

  const missing = steps.filter((step) => !step.signer);
  if (missing.length > 0) {
    abort(
      "cannot execute: no keypair loaded for " +
        missing.map((step) => step.label).join(", ") +
        ". Pass the matching --*-keypair flags.",
    );
  }

  heading("Executing");
  for (const [index, step] of steps.entries()) {
    const signature = await sendAndConfirm(rpc, step.signer as KeyPairSigner, [step.instruction]);
    console.log("  " + (index + 1) + ". " + step.label + " -> " + signature);
  }

  heading("Verifying");
  const [programDataAfter, protocolAfter] = await Promise.all([
    readAccount(rpc, programData),
    readAccount(rpc, protocolPda),
  ]);
  const upgradeAfter = programDataAfter ? parseUpgradeAuthority(programDataAfter.data) : null;
  const protocolAfterDecoded = protocolAfter ? decodeProtocolConfig(protocolAfter.data) : null;
  row("upgrade authority", upgradeAfter ?? "(none)");
  row("guardian", protocolAfterDecoded?.guardian ?? "(missing)");
  row("keeper", protocolAfterDecoded?.keeper ?? "(missing)");
  const ok =
    upgradeAfter === multisig &&
    protocolAfterDecoded?.guardian === multisig &&
    protocolAfterDecoded?.keeper === multisig;
  console.log("");
  console.log(ok ? "All three authorities are the multisig." : "NOT all authorities moved — inspect above.");
  if (!ok) process.exitCode = 1;
}

run(main);
