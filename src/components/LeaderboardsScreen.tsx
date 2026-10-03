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
import { getLeaderboards, type LeaderboardEntry, type LeaderboardsView } from "../api";
import { compact, oreAmount } from "../format";
import { describeMineStatus } from "../mineView";
import { lookOf, defaultBot } from "../preferences";
import { displayName } from "../username";
import { Bot } from "./Bot";
import { TokenOrb } from "./TokenOrb";

export interface LeaderboardsScreenProps {
  tokens: TokenSummary[];
  onSelectMine(mint: string): void;
}

/** Board keys the Worker ranks, in the order the tabs show them, with a short tab label. */
const BOARD_TABS: { key: string; label: string }[] = [
  { key: "power", label: "Mining power" },
  { key: "ore", label: "ORE" },
  { key: "crew", label: "Crew" },
  { key: "streak", label: "Streak" },
  { key: "discovery", label: "Discoveries" },
];

function valueFor(key: string, entry: LeaderboardEntry): string {
  if (key === "power") return compact(entry.metric) + " power";
  if (key === "ore") return oreAmount(entry.metric) + " ORE";
  if (key === "crew") return entry.metric + " levels";
  if (key === "streak") return entry.metric + (entry.metric === 1 ? " day" : " days");
  if (key === "discovery") return (entry.metric / 1e9).toFixed(3) + " SOL";
  return compact(entry.metric);
}

function detailFor(entry: LeaderboardEntry): string {
  return entry.crewTier.charAt(0) + entry.crewTier.slice(1).toLowerCase() + " crew";
}

function mineSymbol(symbol: string): string {
  return "$" + symbol;
}

export function LeaderboardsScreen({ tokens, onSelectMine }: LeaderboardsScreenProps) {
  const [data, setData] = useState<LeaderboardsView | null>(null);
  const [tab, setTab] = useState<string>("power");
  const [error, setError] = useState("");

  useEffect(() => {
    getLeaderboards()
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch(() => setError("Leaderboards are unavailable right now."));
  }, []);

  const tabs = [
    ...BOARD_TABS.filter((entry) => data?.boards.some((board) => board.key === entry.key)),
    { key: "mines", label: "Mines" },
  ];
  const entries = data?.boards.find((board) => board.key === tab)?.entries ?? [];
  const mines = tokens;
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
          {tabs.map((entry) => (
            <button key={entry.key} className={tab === entry.key ? "active" : ""} onClick={() => setTab(entry.key)}>
              {entry.label}
            </button>
          ))}
        </div>
      </div>

      {data?.season && (
        <p className="leaderboard-season">
          {data.season.name}, ends {new Date(data.season.endsAt * 1_000).toLocaleDateString()}.
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
              <span className="leaderboard-name">
                <Bot {...(entry.bot ? lookOf(entry.bot) : defaultBot(entry.wallet))} size={34} still />
                {displayName(entry.wallet, entry.username)}
              </span>
              <strong>{valueFor(tab, entry)}</strong>
              <em>{detailFor(entry)}</em>
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
