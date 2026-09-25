/**
 * The optional crank bot.
 *
 * A permissionless crank replaces the v4 keeper, and the difference is not cosmetic: the keeper
 * held an authority the program trusted, while every instruction below is one a stranger could
 * send with their own wallet. The only thing this key does is pay the network fee.
 *
 * Consequences worth stating plainly:
 *
 *  - a leaked crank key costs its holder the fees it was already paying, and nothing else;
 *  - turning the crank off changes nothing about correctness: every user-signed instruction
 *    opportunistically advances the coin it touches, so the protocol converges without it;
 *  - the crank cannot choose a rate, an amount or a recipient. `advance_mine` walks a bounded,
 *    deterministic number of segments, `commit_epoch_seed` reads the sysvar entry at exactly the
 *    target slot the coin recorded, and `sweep_fees` pays fixed destinations held in
 *    `ProtocolConfig`.
 */
import {
  address,
  createKeyPairSignerFromBytes,
  type KeyPairSigner,
} from "@solana/kit";
import bs58 from "bs58";
import { crankEnabled, type RuntimeEnv } from "./env";
import { nowSeconds } from "./indexStore";
import { getProgramAddress, sendWithFeePayer, type ChainEnv } from "./chainV2";

/** Instructions one crank pass may send. Bounded so a pass cannot run past its budget. */
export const CRANK_MAX_INSTRUCTIONS = 12;

export interface CrankOutcome {
  kind: string;
  mint: string;
  signature: string;
}

export interface CrankReport {
  enabled: boolean;
  feePayer: string | null;
  sent: CrankOutcome[];
  skipped: string[];
}

/**
 * Loads the crank's fee payer.
 *
 * The key is stored as a JSON array of bytes (the format `solana-keygen` writes) or as a base58
 * string, because both are what an operator realistically has to hand. Neither form gives the key
 * any authority: see the module comment.
 */
export async function crankSigner(env: RuntimeEnv): Promise<KeyPairSigner | null> {
  const raw = env.DIGGO_CRANK_SECRET_KEY;
  if (!raw) return null;
  try {
    const bytes = raw.trim().startsWith("[")
      ? Uint8Array.from(JSON.parse(raw) as number[])
      : bs58.decode(raw.trim());
    if (bytes.length !== 64) return null;
    return await createKeyPairSignerFromBytes(bytes);
  } catch {
    return null;
  }
}

/** One coin the crank has work for, and what that work is. */
interface CrankTarget {
  mint: string;
  coin: string;
  creator: string;
  nextBlockAt: number;
  epochSeedTargetSlot: string;
  epochSeedRecordedSlot: string;
  graduationTarget: string;
  solReserve: string;
  graduated: number;
  creatorFeeClaimable: string;
  platformFeeClaimable: string;
}

/**
 * Runs one crank pass.
 *
 * Every decision is read from the index, and every action is re-checked by the program: the
 * index only says which coin is worth a transaction, never what the transaction does.
 */
export async function runCrank(
  env: RuntimeEnv,
  options: { now?: number; max?: number } = {},
): Promise<CrankReport> {
  if (!crankEnabled(env)) return { enabled: false, feePayer: null, sent: [], skipped: [] };
  const signer = await crankSigner(env);
  if (!signer) {
    return { enabled: false, feePayer: null, sent: [], skipped: ["crank key unusable"] };
  }
  const now = options.now ?? nowSeconds();
  const max = Math.min(CRANK_MAX_INSTRUCTIONS, Math.max(1, options.max ?? CRANK_MAX_INSTRUCTIONS));
  const targets = await env.DB.prepare(
    "SELECT mint, coin, creator, next_block_at AS nextBlockAt," +
      " epoch_seed_target_slot AS epochSeedTargetSlot," +
      " epoch_seed_recorded_slot AS epochSeedRecordedSlot," +
      " graduation_target AS graduationTarget, sol_reserve AS solReserve, graduated," +
      " creator_fee_claimable AS creatorFeeClaimable," +
      " platform_fee_claimable AS platformFeeClaimable" +
      " FROM coins ORDER BY indexed_at DESC LIMIT 50",
  ).all<CrankTarget>();
  const sent: CrankOutcome[] = [];
  const skipped: string[] = [];
  for (const target of targets.results ?? []) {
    if (sent.length >= max) break;
    const actions = await planActions(env, target, now);
    if (actions.length === 0) {
      skipped.push(target.mint);
      continue;
    }
    for (const action of actions) {
      if (sent.length >= max) break;
      try {
        const signature = await action.send(signer);
        sent.push({ kind: action.kind, mint: target.mint, signature });
        await recordCrankRun(env, action.kind, target.coin, signature, "SENT");
      } catch (error) {
        // A failed crank transaction is a cost, not a fault: the program refused it, which is
        // exactly the safety property the design relies on. It is logged and never retried in a
        // tight loop.
        await recordCrankRun(env, action.kind, target.coin, null, "FAILED", String(error));
        console.error(
          JSON.stringify({ event: "crank.failed", kind: action.kind, mint: target.mint, error: String(error) }),
        );
      }
    }
  }
  return { enabled: true, feePayer: signer.address, sent, skipped };
}

interface CrankAction {
  kind: string;
  send: (signer: KeyPairSigner) => Promise<string>;
}

/**
 * What this coin needs right now, in the order that matters: seed, then walk, then graduate, then
 * sweep. A coin with nothing to do costs one D1 row read and no transaction at all.
 */
async function planActions(env: RuntimeEnv, target: CrankTarget, now: number): Promise<CrankAction[]> {
  const program = env.DIGGO_PROGRAM_ID ? address(env.DIGGO_PROGRAM_ID) : getProgramAddress(env as ChainEnv);
  const mint = address(target.mint);
  const {
    buildAdvanceMineInstruction,
    buildCommitEpochSeedInstruction,
    buildGraduateMarketInstruction,
    buildSweepFeesInstruction,
  } = await import("../shared/program");
  const actions: CrankAction[] = [];
  const seedDue =
    BigInt(target.epochSeedTargetSlot) > 0n && BigInt(target.epochSeedRecordedSlot) === 0n;
  const advanceDue = target.nextBlockAt > 0 && target.nextBlockAt < now;
  const graduateDue =
    target.graduated !== 1 &&
    BigInt(target.graduationTarget) > 0n &&
    BigInt(target.solReserve) >= BigInt(target.graduationTarget);
  const feesDue =
    BigInt(target.creatorFeeClaimable) > 0n || BigInt(target.platformFeeClaimable) > 0n;
  if (seedDue) {
    actions.push({
      kind: "commit_epoch_seed",
      send: (signer) =>
        sendWithFeePayer(env as ChainEnv, signer, [
          buildCommitEpochSeedInstruction({ programAddress: program, payer: signer.address, mint }),
        ]),
    });
  }
  if (advanceDue) {
    actions.push({
      kind: "advance_mine",
      send: (signer) =>
        sendWithFeePayer(env as ChainEnv, signer, [
          buildAdvanceMineInstruction({ programAddress: program, payer: signer.address, mint }),
        ]),
    });
  }
  if (graduateDue) {
    actions.push({
      kind: "graduate_market",
      send: (signer) =>
        sendWithFeePayer(env as ChainEnv, signer, [
          buildGraduateMarketInstruction({ programAddress: program, payer: signer.address, mint }),
        ]),
    });
  }
  if (feesDue && target.creator) {
    actions.push({
      kind: "sweep_fees",
      send: (signer) =>
        sendWithFeePayer(env as ChainEnv, signer, [
          buildSweepFeesInstruction({
            programAddress: program,
            payer: signer.address,
            mint,
            creator: address(target.creator),
          }),
        ]),
    });
  }
  return actions;
}

async function recordCrankRun(
  env: RuntimeEnv,
  kind: string,
  coin: string,
  signature: string | null,
  status: string,
  detail?: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO crank_runs (id, kind, coin, signature, status, detail, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(crypto.randomUUID(), kind, coin, signature, status, detail ?? null, nowSeconds())
    .run();
}

/** The most recent crank activity, for the status endpoint. */
export async function crankHistory(env: RuntimeEnv, limit = 20): Promise<Record<string, unknown>[]> {
  const rows = await env.DB.prepare(
    "SELECT id, kind, coin, signature, status, detail, created_at FROM crank_runs" +
      " ORDER BY created_at DESC LIMIT ?1",
  )
    .bind(Math.min(100, Math.max(1, limit)))
    .all<Record<string, unknown>>();
  return rows.results ?? [];
}
