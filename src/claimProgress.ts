/**
 * How far a player is from collecting their coins, as steps with progress rather than a wall of
 * conditions. The Worker decides what is met (worker/game/rules.ts); this only turns its answer and
 * the counters it already reports into something a player can watch fill up.
 */
export const CLAIM_STEPS = { activeDays: 5, shifts: 5, portfolioUsd: 10 } as const;

export interface ClaimStep {
  key: "walletAge" | "activeDays" | "shifts" | "portfolio";
  label: string;
  met: boolean;
  /** 0..1 */
  progress: number;
  detail: string;
}

export interface ClaimProgress {
  steps: ClaimStep[];
  done: number;
  /** 0..1, the average of the steps' own progress. */
  overall: number;
}

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

export function claimProgress(input: {
  claim: { walletAge: boolean; activeDays: boolean; activations: boolean; portfolio: boolean; portfolioUsd: number | null };
  activeDays: number;
  validActivations: number;
}): ClaimProgress {
  const { claim } = input;
  const days = Math.max(0, Math.floor(input.activeDays));
  const shifts = Math.max(0, Math.floor(input.validActivations));
  const usd = claim.portfolioUsd;
  const steps: ClaimStep[] = [
    {
      key: "walletAge",
      label: "Wallet at least 7 days old",
      met: claim.walletAge,
      progress: claim.walletAge ? 1 : 0,
      detail: claim.walletAge ? "Done" : "Unlocks with time",
    },
    {
      key: "activeDays",
      label: "Active days",
      met: claim.activeDays,
      progress: claim.activeDays ? 1 : clamp01(days / CLAIM_STEPS.activeDays),
      detail: `${Math.min(days, CLAIM_STEPS.activeDays)} / ${CLAIM_STEPS.activeDays}`,
    },
    {
      key: "shifts",
      label: "Shifts started",
      met: claim.activations,
      progress: claim.activations ? 1 : clamp01(shifts / CLAIM_STEPS.shifts),
      detail: `${Math.min(shifts, CLAIM_STEPS.shifts)} / ${CLAIM_STEPS.shifts}`,
    },
    {
      key: "portfolio",
      label: "$10 in your wallet",
      met: claim.portfolio,
      progress: claim.portfolio ? 1 : usd === null ? 0 : clamp01(usd / CLAIM_STEPS.portfolioUsd),
      detail: usd === null ? "Could not read your wallet" : `$${Math.min(usd, 9_999).toFixed(2)} / $${CLAIM_STEPS.portfolioUsd}`,
    },
  ];
  return {
    steps,
    done: steps.filter((step) => step.met).length,
    overall: steps.reduce((sum, step) => sum + step.progress, 0) / steps.length,
  };
}
