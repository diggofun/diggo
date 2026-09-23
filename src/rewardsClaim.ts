/**
 * Collecting a settled mining reward on chain (spec 53, 57, 74).
 *
 * A mining reward has two steps, and keeping them apart is the point:
 *
 *   1. the backend settles the accounting and the claim becomes CLAIMED with no transaction behind
 *      it yet — that is what `payout.ready` means (see MINING_CLAIM_PAYOUT_ROUTE in worker/mining.ts);
 *   2. the player's own wallet then signs and submits `claim_rewards`, which is the only way tokens
 *      ever leave a mine's program-controlled reserve. The backend is told about the resulting
 *      signature and verifies it on chain before recording it.
 *
 * Nothing here decides an amount or an outcome: the program pays `position.pending_reward`, and the
 * backend refuses any signature it cannot prove is this reward's payout. Collection is idempotent
 * from the player's side — a claim already recorded as paid, or a transaction the backend already
 * knows about, resolves to "collected" rather than an error, and a second click while a submission
 * is in flight cannot start a second transaction.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { RewardClaimPayout } from "../shared/types";
import { ApiError, confirmRewardClaimPayout, type RewardClaimView } from "./api";
import { useDiggoWallet } from "./wallet";

/** A claim's payout as the backend describes it. `ready` means "the player still has to collect". */
export type ClaimPayoutView = RewardClaimPayout;

/** The payout block of a claim, or null when the backend did not send one. */
export function payoutOf(claim: RewardClaimView): RewardClaimPayout | null {
  const payout = claim.payout;
  if (!payout || typeof payout !== "object") return null;
  if (payout.route !== "USER_SIGNED" || typeof payout.ready !== "boolean") return null;
  return payout;
}

/**
 * True when this reward is settled and still waiting on the player's own `claim_rewards`. A claim
 * that already carries a signature has been collected and must not be submitted again.
 */
export function needsOnChainCollection(claim: RewardClaimView): boolean {
  return payoutOf(claim)?.ready === true && claim.txSignature === null;
}

export type CollectionState = "idle" | "pending" | "confirmed" | "failed";

export interface CollectionStatus {
  state: CollectionState;
  signature: string | null;
  /** Player-facing explanation; empty while idle. */
  message: string;
}

const IDLE_STATUS: CollectionStatus = { state: "idle", signature: null, message: "" };

/**
 * The program id the claim_rewards instruction is built against, fetched once per page load.
 * The panel may be opened before anything else has read the config, and this is the lightest call
 * that answers it.
 */
let programIdRequest: Promise<string | null> | null = null;

function loadProgramId(): Promise<string | null> {
  programIdRequest ??= fetch("/api/config", { credentials: "same-origin" })
    .then(async (response) => (response.ok ? ((await response.json()) as { programId?: unknown }) : null))
    .then((config) => (typeof config?.programId === "string" && config.programId ? config.programId : null))
    .catch(() => null);
  return programIdRequest;
}

/** A payout the ledger already considers paid: not a failure, just nothing left to do. */
function isAlreadyCollected(error: unknown): boolean {
  return error instanceof ApiError && error.code === "ALREADY_CLAIMED";
}

function collectionFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === "SIGNATURE_REUSED") {
      return "That transaction is already recorded against another reward. Nothing was changed here.";
    }
    if (error.code === "CLAIMS_HALTED") {
      return "Claims for this mine are paused right now. Your reward is safe — try again later.";
    }
    if (error.code === "PAYOUT_UNVERIFIED") {
      return "The payout could not be verified on chain yet. If your wallet shows the transfer, try again in a moment.";
    }
    if (error.code === "NOT_SETTLED") return "This reward has not finished settling yet.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return "Could not collect this reward.";
}

export interface RewardCollection {
  /** True while this reward still needs the player's own on-chain claim. */
  isCollectable(claim: RewardClaimView): boolean;
  statusOf(claimId: string): CollectionStatus;
  collect(claim: RewardClaimView): Promise<void>;
}

export function useRewardCollection(onCollected?: (claim: RewardClaimView) => void): RewardCollection {
  const connected = useDiggoWallet();
  const [statuses, setStatuses] = useState<Record<string, CollectionStatus>>({});
  // One submission per claim at a time: a double click, or a click while the wallet is already
  // asking for a signature, must not produce a second transaction.
  const inFlight = useRef(new Set<string>());
  const alive = useRef(true);
  const onCollectedRef = useRef(onCollected);

  useEffect(() => {
    onCollectedRef.current = onCollected;
  }, [onCollected]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const statusOf = useCallback(
    (claimId: string): CollectionStatus => statuses[claimId] ?? IDLE_STATUS,
    [statuses],
  );

  const collect = useCallback(
    async (claim: RewardClaimView): Promise<void> => {
      if (inFlight.current.has(claim.id) || !needsOnChainCollection(claim)) return;
      if (!connected) {
        setStatuses((current) => ({
          ...current,
          [claim.id]: {
            state: "failed",
            signature: null,
            message: "Connect your wallet to collect this reward.",
          },
        }));
        return;
      }
      inFlight.current.add(claim.id);
      const update = (status: CollectionStatus) => {
        if (alive.current) setStatuses((current) => ({ ...current, [claim.id]: status }));
      };
      update({
        state: "pending",
        signature: null,
        message: "Waiting for your wallet to sign, then for the network to confirm…",
      });
      let submittedSignature: string | null = null;
      try {
        const programId = await loadProgramId();
        if (!programId) throw new Error("Rewards are unavailable right now. Try again shortly.");
        // v2: the tokens leave the coin's vault only through `claim_rewards`, signed by the
        // player's own wallet. There is no keeper and no server key on this path, so the
        // transaction is the payout and the API call afterwards only records what it verified.
        const { address, claimRewards } = await import("./solanaProgram");
        const submission = await claimRewards({
          programAddress: address(programId),
          wallet: connected.wallet,
          mint: address(claim.mint),
        });
        submittedSignature = submission.signature;
        // The signature is reported even when confirmation polling timed out: the backend checks
        // the transaction itself, and a landed payout must not be lost to a slow RPC.
        await confirmRewardClaimPayout(claim.id, submission.signature);
        update({
          state: submission.confirmed ? "confirmed" : "pending",
          signature: submission.signature,
          message: submission.confirmed
            ? "Collected. The tokens are in your wallet."
            : "Submitted. Confirmation is pending; do not submit this reward again.",
        });
        onCollectedRef.current?.(claim);
      } catch (error) {
        if (isAlreadyCollected(error)) {
          update({
            state: "confirmed",
            signature: null,
            message: "Already collected — this reward has a confirmed payout.",
          });
          onCollectedRef.current?.(claim);
        } else if (submittedSignature &&
          (error instanceof ApiError && (error.code === "PAYOUT_UNVERIFIED" || error.code === "CLAIMS_HALTED"))) {
          update({
            state: "pending",
            signature: submittedSignature,
            message: "The reward transaction was submitted and is still being verified. Do not submit it again.",
          });
        } else {
          update({ state: "failed", signature: null, message: collectionFailureMessage(error) });
        }
      } finally {
        inFlight.current.delete(claim.id);
      }
    },
    [connected],
  );

  return { isCollectable: needsOnChainCollection, statusOf, collect };
}
