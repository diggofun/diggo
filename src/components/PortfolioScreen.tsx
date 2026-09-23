/**
 * Your profile: the portfolio.
 *
 * Everything on this screen comes from `/api/portfolio/:wallet`, which is a projection of the v2
 * index (see worker/portfolio.ts). The screen computes nothing itself: it prints the numbers it is
 * given and renders an em dash wherever the answer is null, which is the whole point of the
 * payload - a value the index cannot attribute to this wallet is reported as unknown rather than as
 * zero.
 *
 * The buttons are the only part of this screen that touches the chain, and each one is an
 * instruction the player signs: claim a coin block rewards, claim a coin creator fees, settle a
 * pending discovery. Nothing here can move a token or a lamport on its own.
 */
import { address, type Address } from "@solana/kit";
import { useCallback, useEffect, useState } from "react";
import { getPortfolio } from "../api";
import { compact, money, shortAddress, solAmount, tokenAmount } from "../format";
import { IconMine, IconProfile, IconUserGroup } from "../icons";
import { claimCreatorFees, claimRewards, settleDiscovery, type DiggoWallet } from "../solanaProgram";
import { usePendingTransaction } from "../onchain";

// --- the payload ---------------------------------------------------------------------------

/** One open position: a token balance this wallet still holds, and what it is worth now. */
export interface PortfolioOpenPosition {
  mint: string;
  coin: string | null;
  slug: string | null;
  symbol: string | null;
  name: string | null;
  balance: string;
  balanceWhole: number;
  withheld: string;
  withheldWhole: number;
  decimals: number;
  priceSol: number | null;
  valueSol: number | null;
  valueUsd: number | null;
  avgEntrySol: number | null;
  costBasisSol: number | null;
  unrealizedPnlSol: number | null;
  unrealizedPnlPct: number | null;
}

/** One closed position: a mint the wallet traded and no longer holds. */
export interface PortfolioClosedPosition {
  mint: string;
  coin: string | null;
  slug: string | null;
  symbol: string | null;
  name: string | null;
  boughtTokens: number;
  boughtSol: number;
  soldTokens: number;
  soldSol: number | null;
  avgEntrySol: number | null;
  realizedPnlSol: number | null;
  realizedPnlPct: number | null;
  lastTradeAt: number;
}

export interface Portfolio {
  wallet: string;
  username: string | null;
  joined: number | null;
  indexed: boolean;
  stats: {
    volumeBoughtSol: number | null;
    volumeSoldSol: number | null;
    trades: number | null;
    tradeAttribution: "signature" | "unavailable";
    tradeHistoryComplete: boolean | null;
    signatureScanLimit: number;
    signaturesScanned: number | null;
    volumeScope: "all-signatures-returned" | "latest-signatures" | "unavailable";
    tradesPriced: number;
    tradesUnpriced: number;
    realizedPnlSol: number | null;
    unrealizedPnlSol: number | null;
    rewardsClaimed: {
      coin: string;
      mint: string | null;
      symbol: string | null;
      amount: string;
      amountWhole: number | null;
      events: number;
    }[];
    coinsCreated: number;
    creatorFeesClaimableLamports: string;
    creatorFeesClaimableSol: number;
    discoveryGrantsPending: number;
    discoveryGrantsPreviewTruncated: boolean;
    discoveryGrantsPreviewLimit: number;
  };
  positions: {
    open: PortfolioOpenPosition[];
    closed: PortfolioClosedPosition[];
    source: "chain" | "unavailable";
  };
  mining: {
    indexed: boolean;
    activation: "NEVER_ACTIVATED" | "ACTIVE" | "PAUSED";
    activeUntil: number;
    activeMine: { coin: string; mint: string | null; slug: string | null; symbol: string | null } | null;
    power: string;
    powerWhole: number;
    ore: string;
    oreWhole: number;
    oreEarned: string;
    oreCapacity: number;
    crew: { miners: number; drills: number; carts: number; foreman: number; storage: number; total: number };
    crewTier: string;
    crewPower: number;
    streak: number;
    longestStreak: number;
    activeDays: number;
    streakFreezes: number;
    rewards: {
      position: string;
      coin: string;
      mint: string | null;
      symbol: string | null;
      pendingReward: string;
      pendingRewardWhole: number | null;
    }[];
    discoveryGrants: {
      opportunity: string;
      coin: string;
      mint: string | null;
      symbol: string | null;
      windowIndex: number;
      dayIndex: number;
      createdAt: number;
    }[];
  };
  creator: {
    coins: {
      coin: string;
      mint: string | null;
      slug: string | null;
      name: string | null;
      symbol: string | null;
      status: string;
      graduated: boolean;
      priceSol: number | null;
      marketCapUsd: number | null;
      creatorFeesClaimableLamports: string;
      creatorFeesClaimableSol: number;
    }[];
    claimableLamports: string;
    claimableSol: number;
  };
  syncedAt: number;
}

// --- rendering -----------------------------------------------------------------------------

/** An unknown value, printed as an em dash rather than as a zero. */
const DASH = "—";

function solText(value: number | null): string {
  return value === null ? DASH : solAmount(value) + " SOL";
}

function pnlText(value: number | null): string {
  if (value === null) return DASH;
  return (value >= 0 ? "+" : "−") + solAmount(Math.abs(value)) + " SOL";
}

function dateText(seconds: number | null): string {
  return seconds === null || seconds <= 0 ? DASH : new Date(seconds * 1_000).toLocaleDateString();
}

export interface PortfolioScreenProps {
  wallet: string;
  /** The program id from /api/config; the buttons do nothing without it. */
  programAddress: string;
  /** The connected signer. Every action below is a transaction this wallet signs. */
  signer: DiggoWallet | null;
  /** A portfolio already loaded by a parent, so the screen can render without a second request. */
  initial?: Portfolio | null;
}

export function PortfolioScreen({
  wallet,
  programAddress,
  signer,
  initial = null,
}: PortfolioScreenProps) {
  const [portfolio, setPortfolio] = useState<Portfolio | null>(initial);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(initial === null);
  const [busy, setBusy] = useState("");
  const pendingTransaction = usePendingTransaction();

  const load = useCallback(async () => {
    try {
      setPortfolio(await getPortfolio<Portfolio>(wallet));
      setError("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Your portfolio is unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Runs one signed action, then re-reads the portfolio. The refresh matters: the indexer sees the
   * transaction on its next pass, so the numbers can lag by one sweep and the screen says so.
   */
  const run = useCallback(
    async (key: string, action: (program: Address) => Promise<unknown>, done: string) => {
      if (!signer) {
        setError("Connect a wallet to sign that.");
        return;
      }
      if (!programAddress) {
        setError("The program address is not configured.");
        return;
      }
      if (!pendingTransaction.canSubmit()) return;
      setBusy(key);
      setError("");
      setNotice("");
      try {
        await action(address(programAddress));
        setNotice(done);
        await load();
      } catch (failure) {
        if (!pendingTransaction.record(failure, done.replace(/\.$/, ""))) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } else setError("");
      } finally {
        setBusy("");
      }
    },
    [load, pendingTransaction, programAddress, signer],
  );

  if (loading && !portfolio) {
    return (
      <section className="portfolio-screen page-shell" id="portfolio" aria-busy="true">
        <span className="skeleton" />
        <span className="skeleton" />
        <p className="sr-only">Loading your portfolio…</p>
      </section>
    );
  }

  return (
    <section className="portfolio-screen page-shell" id="portfolio" aria-labelledby="portfolio-title">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <IconProfile size={14} /> Your profile
          </div>
          <h1 id="portfolio-title">
            YOUR COINS,
            <br />
            YOUR CREW, YOUR FEES.
          </h1>
        </div>
        <div className="dash-actions-inline">
          <span className="mono-label">
            {portfolio?.username ?? shortAddress(wallet)}
            {portfolio ? " · joined " + dateText(portfolio.joined) : ""}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => void load()}
            disabled={busy !== ""}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && (
        <p className="form-message">
          {error}
        </p>
      )}
      {notice && <p className="form-message">{notice}</p>}

      {!portfolio ? (
        <div className="empty-state">
          <p>This wallet has no portfolio to show yet.</p>
        </div>
      ) : (
        <>
          <StatsBlock portfolio={portfolio} />
          <a className="card portfolio-referral-card" href="/referrals">
            <span className="eyebrow"><IconUserGroup size={14} /> Referrals</span>
            <strong>Invite players. Earn ORE and an exclusive skin.</strong>
            <span>Qualified referrals earn ORE for you. Referred players receive no welcome bonus.</span>
            <small>Open referrals <span aria-hidden="true">→</span></small>
          </a>
          <PositionsBlock portfolio={portfolio} />
          <MiningBlock portfolio={portfolio} busy={busy} signer={signer} run={run} />
          <CreatorBlock portfolio={portfolio} busy={busy} signer={signer} run={run} />
        </>
      )}
    </section>
  );
}

/** One signed action, keyed so the button that started it can show a busy state. */
type RunAction = (
  key: string,
  action: (program: Address) => Promise<unknown>,
  done: string,
) => Promise<void>;

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="stat">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

function StatsBlock({ portfolio }: { portfolio: Portfolio }) {
  const { stats } = portfolio;
  const attribution =
    stats.tradeAttribution === "unavailable"
      ? "the index could not attribute trades to this wallet"
      : stats.tradesUnpriced > 0
        ? stats.tradesPriced + " priced, " + stats.tradesUnpriced + " with no measured fill"
        : stats.trades + " trades this wallet signed";
  const volumeLabel =
    stats.volumeScope === "latest-signatures"
      ? "volume in the latest " + stats.signatureScanLimit + " wallet signatures"
      : stats.volumeScope === "unavailable"
        ? "volume is unavailable"
        : "volume across indexed trades in all signatures returned";
  return (
    <div className="card portfolio-block">
      <div className="claim-block-head">
        <h2 className="mono-label">Trading</h2>
        <small>{attribution}</small>
      </div>
      {stats.tradeHistoryComplete === false && (
        <p className="form-message">
          History scan reached the {stats.signatureScanLimit}-signature limit. Counts and volume below cover only the latest signatures returned.
        </p>
      )}
      <div className="mining-kpis">
        <Stat label="Bought" value={solText(stats.volumeBoughtSol)} note={volumeLabel} />
        <Stat label="Sold" value={solText(stats.volumeSoldSol)} note={volumeLabel} />
        <Stat label="Trades" value={stats.trades === null ? DASH : String(stats.trades)} />
        <Stat
          label="Realized PnL"
          value={pnlText(stats.realizedPnlSol)}
          note="unknown: transfers and complete lot history are not indexed"
        />
        <Stat
          label="Unrealized"
          value={pnlText(stats.unrealizedPnlSol)}
          note="unknown without a complete cost-basis ledger"
        />
        <Stat label="Coins created" value={String(stats.coinsCreated)} />
        <Stat
          label="Creator fees"
          value={solText(stats.creatorFeesClaimableSol)}
          note="claimable now"
        />
      </div>
    </div>
  );
}

function PositionsBlock({ portfolio }: { portfolio: Portfolio }) {
  const { open, closed, source } = portfolio.positions;
  return (
    <div className="card portfolio-block">
      <div className="claim-block-head">
        <h2 className="mono-label">
          Positions
        </h2>
        {source === "unavailable" ? (
          <small>
            Balances could not be read from the chain, so positions are unknown rather than empty.
          </small>
        ) : (
          <small>{open.length} open, {closed.length} closed</small>
        )}
      </div>

      <div className="leaderboard-table">
        <div className="leaderboard-row leaderboard-head">
          <span>Coin</span>
          <span>Spendable</span>
          <span>Value</span>
          <span>Withheld</span>
        </div>
        {open.map((position) => (
          <div className="leaderboard-row" key={"open-" + position.mint}>
            <span className="leaderboard-name">${position.symbol ?? shortAddress(position.mint)}</span>
            <span>
              {tokenAmount(position.balanceWhole)}
              {position.withheldWhole > 0 ? " (spendable)" : ""}
            </span>
            <strong>{solText(position.valueSol)}</strong>
            <em>{position.withheldWhole > 0 ? tokenAmount(position.withheldWhole) : DASH}</em>
          </div>
        ))}
        {open.length === 0 && source === "chain" && (
          <div className="leaderboard-empty">No token balances in this wallet.</div>
        )}
      </div>

      {closed.length > 0 && (
        <>
          <h3 className="mono-label">Closed positions</h3>
          <div className="leaderboard-table">
            <div className="leaderboard-row leaderboard-head">
              <span>Coin</span>
              <span>Sold</span>
              <span>Proceeds</span>
              <span>Realized PnL</span>
            </div>
            {closed.map((position) => (
              <div className="leaderboard-row" key={"closed-" + position.mint}>
                <span className="leaderboard-name">${position.symbol ?? shortAddress(position.mint)}</span>
                <span>{tokenAmount(position.soldTokens)}</span>
                <span>{solText(position.soldSol)}</span>
                <em>Unknown: complete FIFO evidence is unavailable.</em>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function MiningBlock({
  portfolio,
  busy,
  signer,
  run,
}: {
  portfolio: Portfolio;
  busy: string;
  signer: DiggoWallet | null;
  run: RunAction;
}) {
  const { mining } = portfolio;
  const mineLabel = mining.activeMine
    ? "$" + (mining.activeMine.symbol ?? shortAddress(mining.activeMine.coin))
    : "None";
  return (
    <div className="card portfolio-block">
      <div className="claim-block-head">
        <h2 className="mono-label">
          <IconMine size={14} /> Mining
        </h2>
        <span className={"badge " + (mining.activation === "ACTIVE" ? "badge-active" : "badge-paused")}>
          <i /> {mining.activation}
        </span>
      </div>

      {!mining.indexed ? (
        <p className="form-message">
          This wallet has never initialized a player account, so it has no crew, no ORE and no
          mining position.
        </p>
      ) : (
        <>
          <div className="mining-kpis">
            <Stat label="Active mine" value={mineLabel} />
            <Stat label="Mining power" value={compact(mining.powerWhole)} />
            <Stat
              label="ORE"
              value={tokenAmount(mining.oreWhole)}
              note={"storage " + compact(mining.oreCapacity) + " · earned " + tokenAmount(Number(mining.oreEarned))}
            />
            <Stat
              label="Crew tier"
              value={mining.crewTier}
              note={compact(mining.crewPower) + " crew power · " + mining.crew.total + " levels"}
            />
            <Stat
              label="Streak"
              value={mining.streak + " days"}
              note={"longest " + mining.longestStreak + " · " + mining.activeDays + " active days"}
            />
          </div>

          <h3 className="mono-label">Claimable block rewards</h3>
          <div className="leaderboard-table">
            <div className="leaderboard-row leaderboard-head">
              <span>Coin</span>
              <span>Unpaid</span>
              <span>Position</span>
              <span>Action</span>
            </div>
            {mining.rewards.map((reward) => (
              <div className="leaderboard-row" key={"reward-" + reward.position}>
                <span className="leaderboard-name">
                  ${reward.symbol ?? shortAddress(reward.coin)}
                </span>
                <strong>
                  {reward.pendingRewardWhole === null ? DASH : tokenAmount(reward.pendingRewardWhole)}
                </strong>
                <em>{shortAddress(reward.position)}</em>
                <span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm claim-rewards-button"
                    disabled={!signer || reward.mint === null || busy !== ""}
                    onClick={() =>
                      void run(
                        "reward-" + reward.position,
                        (program) =>
                          claimRewards({
                            programAddress: program,
                            wallet: signer!,
                            mint: address(reward.mint!),
                          }),
                        "Rewards claimed for " + (reward.symbol ?? shortAddress(reward.coin)) + ".",
                      )
                    }
                  >
                    {busy === "reward-" + reward.position ? "Claiming…" : "Claim"}
                  </button>
                </span>
              </div>
            ))}
            {mining.rewards.length === 0 && (
              <div className="leaderboard-empty">No unpaid block rewards right now.</div>
            )}
          </div>

          <h3 className="mono-label">Discovery grants pending</h3>
          <p className="form-message">
            {portfolio.stats.discoveryGrantsPending} pending grant{portfolio.stats.discoveryGrantsPending === 1 ? "" : "s"}
            {portfolio.stats.discoveryGrantsPreviewTruncated
              ? ". Showing the latest " + portfolio.stats.discoveryGrantsPreviewLimit + "."
              : "."}
          </p>
          <div className="leaderboard-table">
            <div className="leaderboard-row leaderboard-head">
              <span>Coin</span>
              <span>Window</span>
              <span>Rolled</span>
              <span>Action</span>
            </div>
            {mining.discoveryGrants.map((grant) => (
              <div className="leaderboard-row" key={"grant-" + grant.opportunity}>
                <span className="leaderboard-name">
                  ${grant.symbol ?? shortAddress(grant.coin)}
                </span>
                <strong>{grant.windowIndex}</strong>
                <em>{dateText(grant.createdAt)}</em>
                <span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={!signer || grant.mint === null || busy !== ""}
                    onClick={() =>
                      void run(
                        "settle-" + grant.opportunity,
                        (program) =>
                          settleDiscovery({
                            programAddress: program,
                            wallet: signer!,
                            mint: address(grant.mint!),
                          }),
                        "Discovery settled for " + (grant.symbol ?? shortAddress(grant.coin)) + ".",
                      )
                    }
                  >
                    {busy === "settle-" + grant.opportunity ? "Settling…" : "Settle"}
                  </button>
                </span>
              </div>
            ))}
            {mining.discoveryGrants.length === 0 && (
              <div className="leaderboard-empty">Nothing to settle.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function CreatorBlock({
  portfolio,
  busy,
  signer,
  run,
}: {
  portfolio: Portfolio;
  busy: string;
  signer: DiggoWallet | null;
  run: RunAction;
}) {
  const { creator } = portfolio;
  return (
    <div className="card portfolio-block">
      <div className="claim-block-head">
        <h2 className="mono-label">
          Creator
        </h2>
        <small>{solText(creator.claimableSol)} claimable across {creator.coins.length} coins</small>
      </div>

      {creator.coins.length === 0 ? (
        <div className="empty-state">
          <p>This wallet has not launched a coin.</p>
        </div>
      ) : (
        <div className="leaderboard-table">
          <div className="leaderboard-row leaderboard-head">
            <span>Coin</span>
            <span>Fees</span>
            <span>Market cap</span>
            <span>Action</span>
          </div>
          {creator.coins.map((coin) => (
            <div className="leaderboard-row" key={"creator-" + coin.coin}>
              <span className="leaderboard-name">
                ${coin.symbol ?? shortAddress(coin.coin)}
                <em className="badge badge-idle">{coin.graduated ? "pool" : "curve"}</em>
              </span>
              <strong>{solAmount(coin.creatorFeesClaimableSol) + " SOL"}</strong>
              <em>{coin.marketCapUsd === null ? DASH : money(coin.marketCapUsd)}</em>
              <span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={
                    !signer ||
                    coin.mint === null ||
                    coin.creatorFeesClaimableSol <= 0 ||
                    busy !== ""
                  }
                  onClick={() =>
                    void run(
                      "creator-" + coin.coin,
                      (program) =>
                        claimCreatorFees({
                          programAddress: program,
                          wallet: signer!,
                          mint: address(coin.mint!),
                        }),
                      "Creator fees claimed for " + (coin.symbol ?? shortAddress(coin.coin)) + ".",
                    )
                  }
                >
                  {busy === "creator-" + coin.coin ? "Claiming…" : "Claim fees"}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
