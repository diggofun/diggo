/**
 * Leaderboards (spec 68).
 *
 * Four progression boards — Crew Power, streak, achievements and seasonal points — plus the mines
 * board. Every ranked number is gameplay progression: nothing here ranks token holdings, claimed
 * value or trade volume, because a board that pays for farmed quantity is what a bot farm
 * optimises. Prizes stay non-financial while real-value prizes would need stronger anti-Sybil
 * protection.
 */
import { useEffect, useState } from "react";
import { IconLeaderboards } from "../icons";
import type { TokenSummary } from "../../shared/types";
import { getLeaderboards, type LeaderboardsView, type RankedEntry } from "../api";
import { compact } from "../format";
import { describeMineStatus } from "../mineView";
import { displayName } from "../username";
import { TokenOrb } from "./TokenOrb";

export interface LeaderboardsScreenProps {
  tokens: TokenSummary[];
  onSelectMine(mint: string): void;
}

type Tab = "crew" | "streak" | "achievements" | "seasonal" | "mines";

const TABS: { id: Tab; label: string }[] = [
  { id: "crew", label: "Crew power" },
  { id: "streak", label: "Streak" },
  { id: "achievements", label: "Achievements" },
  { id: "seasonal", label: "Season" },
  { id: "mines", label: "Mines" },
];

function valueFor(tab: Tab, entry: RankedEntry): string {
  if (tab === "crew") return compact(entry.power) + " power";
  if (tab === "streak") return entry.streak + " days";
  if (tab === "achievements") return entry.achievementCount + " earned";
  return entry.seasonalPoints.toLocaleString() + " pts";
}

function detailFor(tab: Tab, entry: RankedEntry): string {
  if (tab === "crew") return "tier " + entry.crewTier + ", " + entry.crewTotalLevel + " levels";
  if (tab === "streak") return "longest " + entry.longestStreak + ", " + entry.activeDays + " active days";
  if (tab === "achievements") return entry.activeDays + " active days";
  return entry.achievementCount + " achievements";
}

function mineSymbol(symbol: string): string {
  return "$" + symbol;
}

export function LeaderboardsScreen({ tokens, onSelectMine }: LeaderboardsScreenProps) {
  const [data, setData] = useState<LeaderboardsView | null>(null);
  const [tab, setTab] = useState<Tab>("crew");
  const [error, setError] = useState("");

  useEffect(() => {
    getLeaderboards()
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch(() => setError("Leaderboards are unavailable right now."));
  }, []);

  const entries: RankedEntry[] = data && tab !== "mines" ? data[tab] ?? [] : [];
  const mines = data?.mines ?? tokens;
  const rows = tab === "mines" ? mines.length : entries.length;

  return (
    <section className="leaderboards page-shell" id="leaderboards">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <IconLeaderboards size={14} /> Leaderboards
          </div>
          <h2>
            Top of
            <br />
            the shaft.
          </h2>
        </div>
        <div className="filter-tabs">
          {TABS.map((entry) => (
            <button key={entry.id} className={tab === entry.id ? "active" : ""} onClick={() => setTab(entry.id)}>
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {data?.season && (
        <p className="leaderboard-season">
          {data.season.name}, ends {new Date(data.season.endsAt * 1_000).toLocaleDateString()}. Prizes are
          cosmetic and capped; token amounts are never a prize.
        </p>
      )}
      {error && <p className="form-message">{error}</p>}

      <div className="leaderboard-table">
        <div className="leaderboard-row leaderboard-head">
          <span>#</span>
          <span>{tab === "mines" ? "Mine" : "Miner"}</span>
          <span>{tab === "mines" ? "Network power" : "Score"}</span>
          <span>{tab === "mines" ? "Status" : "Detail"}</span>
        </div>

        {tab === "mines" &&
          mines.map((mine, index) => (
            <button className="leaderboard-row is-clickable" key={mine.mint} onClick={() => onSelectMine(mine.mint)}>
              <b>{index + 1}</b>
              <span className="leaderboard-name">
                <TokenOrb symbol={mine.symbol} imageUrl={mine.imageUrl} /> {mineSymbol(mine.symbol)}
              </span>
              <strong>{compact(mine.networkPower)}</strong>
              <em>{describeMineStatus(mine.status).badge}</em>
            </button>
          ))}

        {tab !== "mines" &&
          entries.map((entry) => (
            <div className="leaderboard-row" key={tab + "-" + entry.wallet}>
              <b>{entry.rank}</b>
              <span>{displayName(entry.wallet, entry.username)}</span>
              <strong>{valueFor(tab, entry)}</strong>
              <em>{detailFor(tab, entry)}</em>
            </div>
          ))}

        {rows === 0 && (
          <div className="leaderboard-empty">
            No verified activity yet. The first on-chain miner takes the top spot.
          </div>
        )}
      </div>
    </section>
  );
}
