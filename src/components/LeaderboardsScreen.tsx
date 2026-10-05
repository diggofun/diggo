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
import { getLeaderboards, getMineWars, type LeaderboardEntry, type LeaderboardsView } from "../api";
import type { MineWarsEntry } from "../../shared/mineWars";
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
  // ?tab=wars opens Mine Wars directly (linked from mine cards).
  const [tab, setTab] = useState<string>(() => new URLSearchParams(window.location.search).get("tab") ?? "power");
  const [error, setError] = useState("");
  const [wars, setWars] = useState<MineWarsEntry[] | null>(null);

  useEffect(() => {
    if (tab !== "wars" || wars !== null) return;
    getMineWars().then((result) => setWars(result.mines)).catch(() => setWars([]));
  }, [tab, wars]);

  useEffect(() => {
    getLeaderboards()
      .then((result) => {
        setData(result);
        setError("");
      })
      .catch(() => setError("Leaderboards are unavailable right now."));
  }, []);

  // Mine Wars ranks the mines the game is digging, so it only exists where the game boards do.
  const hasGameBoards = Boolean(data?.boards.some((board) => board.key === "power"));
  const tabs = [
    ...(hasGameBoards ? [{ key: "wars", label: "Mine Wars" }] : []),
    ...BOARD_TABS.filter((entry) => data?.boards.some((board) => board.key === entry.key)),
    { key: "mines", label: "Mines" },
  ];
  const entries = data?.boards.find((board) => board.key === tab)?.entries ?? [];
  const mines = tokens;
  const rows = tab === "mines" ? mines.length : tab === "wars" ? (wars?.length ?? 1) : entries.length;
  const listed = new Set(tokens.map((token) => token.mint));

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
          <span>{tab === "mines" || tab === "wars" ? "Mine" : "Miner"}</span>
          <span>{tab === "mines" ? "Network power" : tab === "wars" ? "Crews now" : "Score"}</span>
          <span>{tab === "mines" ? "Status" : tab === "wars" ? "This week" : "Detail"}</span>
        </div>

        {tab === "wars" &&
          (wars ?? []).map((mine) => {
            const name = (
              <span className="leaderboard-name">
                <TokenOrb symbol={mine.symbol} imageUrl={tokens.find((token) => token.mint === mine.mint)?.imageUrl ?? null} />
                <span className="wars-name">
                  {mineSymbol(mine.symbol)} {mine.boosted && <span className="boosted-badge">🚀</span>}
                  {mine.createdBy && <small>by {mine.createdBy}</small>}
                </span>
              </span>
            );
            const cells = (
              <>
                <b>{mine.rank}</b>
                {name}
                <strong>{mine.crews} {mine.crews === 1 ? "crew" : "crews"}</strong>
                <em>{mine.minersThisWeek} {mine.minersThisWeek === 1 ? "miner" : "miners"}</em>
              </>
            );
            return listed.has(mine.mint)
              ? <button className="leaderboard-row is-clickable" key={"wars-" + mine.mint} onClick={() => onSelectMine(mine.mint)}>{cells}</button>
              : <a className="leaderboard-row is-clickable" key={"wars-" + mine.mint} href={"/m/" + encodeURIComponent(mine.mint)} title="Send your crew to this mine">{cells}</a>;
          })}
        {tab === "wars" && wars === null && <div className="leaderboard-empty">Counting crews…</div>}

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

        {tab !== "mines" && tab !== "wars" &&
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
