/**
 * The two economies, kept visibly apart (spec 74).
 *
 * REAL REWARDS is the token side: block rewards the Worker settled into claim rows, each claimable
 * with its own wallet-signed single-use challenge. GAME PROGRESSION is the ORE side: ORE, Mining
 * Level and Crew Tier, which are game state and never a balance, a coin or a tradeable asset.
 *
 * Nothing in this file converts one side into the other, and no screen calls ORE a balance.
 */
import { Award, Coins, ExternalLink, Gem, Layers, Sparkles, TrendingUp } from "lucide-react";
import type { PlayerProfile, TokenSummary } from "../../shared/types";
import type { RewardClaimView } from "../api";
import { DIGGO_CONFIG, crewTier } from "../../shared/economics";
import { CREW_COMPONENTS } from "../crewLabels";
import { money, oreAmount, tokenAmount } from "../format";
import { needsOnChainCollection, useRewardCollection, type CollectionState } from "../rewardsClaim";

export interface EconomyPanelsProps {
  player: PlayerProfile | null;
  tokens: TokenSummary[];
  claims: RewardClaimView[];
  loading: boolean;
  signedIn: boolean;
  claimingId: string | null;
  claimError: string;
  onClaim(claim: RewardClaimView): void;
  onOpenToken(mint: string): void;
  /** Optional: called after a reward's on-chain payout is confirmed, so the ledger can refresh. */
  onCollected?(claim: RewardClaimView): void;
}

/**
 * The badge shown while a reward is being collected on chain. Reuses the existing status classes
 * rather than inventing new ones: pending reads as neutral, confirmed as good, failed as a problem.
 */
function collectionBadge(state: CollectionState): { className: string; label: string } {
  if (state === "pending") return { className: "status-claimed", label: "PENDING" };
  if (state === "confirmed") return { className: "status-eligible", label: "CONFIRMED" };
  if (state === "failed") return { className: "status-held", label: "FAILED" };
  return { className: "status-claimed", label: "READY" };
}

/**
 * What the ledger says about a claim. CLAIMED means the accounting settled, which is not the same
 * as the tokens having moved: they only leave the mine's reserve once the player collects on chain.
 */
function ledgerStatusLabel(claim: RewardClaimView): string {
  if (claim.txSignature) return "COLLECTED";
  if (needsOnChainCollection(claim)) return "SETTLED";
  return claim.status;
}

function symbolOf(tokens: TokenSummary[], mint: string): string {
  return tokens.find((token) => token.mint === mint)?.symbol ?? mint.slice(0, 4);
}

function priceOf(tokens: TokenSummary[], mint: string): number {
  return tokens.find((token) => token.mint === mint)?.priceUsd ?? 0;
}

export function EconomyPanels({
  player,
  tokens,
  claims,
  loading,
  signedIn,
  claimingId,
  claimError,
  onClaim,
  onOpenToken,
  onCollected,
}: EconomyPanelsProps) {
  const collection = useRewardCollection(onCollected);
  const claimable = claims.filter((claim) => claim.status === "ELIGIBLE");
  // Settled rewards whose tokens are still sitting in the mine's program-controlled reserve: the
  // player's own wallet has to submit claim_rewards before anything moves (spec 57).
  const collectable = claims.filter(needsOnChainCollection);
  const claimableUsd = claimable.reduce((sum, claim) => sum + claim.amount * priceOf(tokens, claim.mint), 0);
  // Per-token totals, so the panel reads as balances first and a claim queue second (spec 74).
  const balances = new Map<string, { claimable: number; settled: number }>();
  for (const claim of claims) {
    const entry = balances.get(claim.mint) ?? { claimable: 0, settled: 0 };
    if (claim.status === "ELIGIBLE") entry.claimable += claim.amount;
    if (claim.status === "CLAIMED") entry.settled += claim.amount;
    balances.set(claim.mint, entry);
  }
  const tier = player ? crewTier(player.crewLevels) : null;
  const totalLevel = player
    ? CREW_COMPONENTS.reduce((sum, component) => sum + player.crewLevels[component], 0)
    : 0;
  const nextTier = DIGGO_CONFIG.crew.tiers.find((candidate) => candidate.minTotalLevel > totalLevel) ?? null;

  return (
    <section className="economy-split page-shell">
      <article className="economy-panel real-rewards">
        <header>
          <span className="economy-badge">
            <Coins size={13} /> REAL REWARDS
          </span>
          <h3>Token rewards</h3>
          <p>
            Block rewards your crew actually earned, settled per token. Claiming one signs a
            single-use message; the payout itself is settled from the mine's reserve, never invented
            and never guaranteed to keep paying the same amount. A settled reward then appears in
            your collect list, where your own wallet signs the payout out of that mine's reserve.
          </p>
        </header>

        {!signedIn && <p className="economy-empty">Sign in with your wallet to see your token rewards.</p>}
        {signedIn && loading && <p className="economy-empty">Loading your reward ledger…</p>}
        {signedIn && !loading && claims.length === 0 && (
          <p className="economy-empty">
            No token rewards settled yet. Keep the crew active inside a mine and each block pays your
            share of that mine's reward.
          </p>
        )}

        {balances.size > 0 && (
          <div className="token-balances">
            <span className="claim-block-head-label">TOKEN REWARDS</span>
            <ul>
              {[...balances.entries()].map(([mint, total]) => (
                <li key={mint}>
                  <button className="badge ledger-token" onClick={() => onOpenToken(mint)}>
                    {symbolOf(tokens, mint)} <ExternalLink size={11} />
                  </button>
                  <span>{tokenAmount(total.claimable)} ready</span>
                  <span>{tokenAmount(total.settled)} settled</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {claimable.length > 0 && (
          <div className="claim-block">
            <div className="claim-block-head">
              <span>READY TO CLAIM</span>
              <strong>{money(claimableUsd)} at spot</strong>
            </div>
            <ul>
              {claimable.map((claim) => (
                <li key={claim.id}>
                  <div>
                    <strong>
                      {tokenAmount(claim.amount)} {symbolOf(tokens, claim.mint)}
                    </strong>
                    <small>
                      expires {new Date(claim.eligibleUntil * 1_000).toLocaleString()} · {claim.accounting.label}
                    </small>
                  </div>
                  <button disabled={claimingId === claim.id} onClick={() => onClaim(claim)}>
                    {claimingId === claim.id ? "Claiming…" : "Claim"}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {collectable.length > 0 && (
          <div className="claim-block">
            <div className="claim-block-head">
              <span>COLLECT ON-CHAIN</span>
              <strong>
                {tokenAmount(collectable.reduce((sum, claim) => sum + claim.amount, 0))} tokens
              </strong>
            </div>
            <ul>
              {collectable.map((claim) => {
                const status = collection.statusOf(claim.id);
                const badge = collectionBadge(status.state);
                const busy = status.state === "pending";
                return (
                  <li key={claim.id}>
                    <div>
                      <strong>
                        {tokenAmount(claim.amount)} {symbolOf(tokens, claim.mint)}
                      </strong>
                      <small>
                        <em className={"reward-status " + badge.className}>{badge.label}</em>{" "}
                        {status.message || "Settled. Your wallet signs the payout from the mine's reserve."}
                      </small>
                    </div>
                    <button
                      disabled={busy || status.state === "confirmed"}
                      onClick={() => void collection.collect(claim)}
                    >
                      {busy ? "Collecting…" : status.state === "confirmed" ? "Collected" : "Collect"}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {claims.filter((claim) => claim.status !== "ELIGIBLE").length > 0 && (
          <div className="claim-history">
            <span className="claim-block-head-label">LEDGER</span>
            <ul>
              {claims
                .filter((claim) => claim.status !== "ELIGIBLE")
                .slice(0, 12)
                .map((claim) => (
                  <li key={claim.id}>
                    <button className="badge ledger-token" onClick={() => onOpenToken(claim.mint)}>
                      {symbolOf(tokens, claim.mint)} <ExternalLink size={11} />
                    </button>
                    <strong>{tokenAmount(claim.amount)}</strong>
                    <em className={"reward-status status-" + claim.status.toLowerCase()}>
                      {ledgerStatusLabel(claim)}
                    </em>
                  </li>
                ))}
            </ul>
          </div>
        )}
        {claimError && <p className="form-message">{claimError}</p>}
      </article>

      <article className="economy-panel game-progression">
        <header>
          <span className="economy-badge">
            <Gem size={13} /> GAME PROGRESSION
          </span>
          <h3>Your dug-in progress</h3>
          <p>
            ORE, Mining Level and Crew Tier are game state. They exist to upgrade your crew inside
            Diggo and cannot be bought, sold, transferred or withdrawn.
          </p>
        </header>

        {player ? (
          <div className="progression-grid">
            <div className="progression-cell">
              <span>
                <Gem size={13} /> ORE
              </span>
              <strong>{oreAmount(player.oreBalance)}</strong>
              <small>
                of {oreAmount(player.oreCapacity)} storage
                {player.oreOverflow ? " · " + oreAmount(player.oreOverflow) + " overflowed" : ""}
              </small>
            </div>
            <div className="progression-cell">
              <span>
                <Layers size={13} /> MINING LEVEL
              </span>
              <strong>{totalLevel}</strong>
              <small>levels earned across your five crew branches</small>
            </div>
            <div className="progression-cell">
              <span>
                <Award size={13} /> CREW TIER
              </span>
              <strong>{tier?.name ?? "—"}</strong>
              <small>
                tier {tier?.tier ?? 1} of {DIGGO_CONFIG.crew.tiers.length}
                {nextTier ? " · next at level " + nextTier.minTotalLevel : " · top tier reached"}
              </small>
            </div>
            <div className="progression-cell">
              <span>
                <Sparkles size={13} /> EXPERIENCE
              </span>
              <strong>{oreAmount(player.xp ?? 0)}</strong>
              <small>
                {(player.badges?.length ?? 0)} badges · {(player.titles?.length ?? 0)} titles · longest streak{" "}
                {player.longestStreak ?? player.streak}
              </small>
            </div>
          </div>
        ) : (
          <p className="economy-empty">Sign in to see your ORE, Mining Level and Crew Tier.</p>
        )}

        <p className="economy-footnote">
          <TrendingUp size={12} /> ORE is not a token and has no market price. Your crew's Mining Power
          is earned only by playing.
        </p>
      </article>
    </section>
  );
}
