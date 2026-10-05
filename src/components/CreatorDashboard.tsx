/**
 * "Your mines": the coins this wallet added or launched, with the numbers worth posting - crews
 * digging, players this week, new holders paid out - plus share, boost and the mining period.
 */
import { useCallback, useEffect, useState } from "react";
import { getCreatorMines } from "../api";
import { compact, tokenAmount } from "../format";
import type { CreatorMineView } from "../../shared/creatorMines";
import { AddCoinModal } from "./AddCoinModal";
import { MineShare } from "./MineShare";
import { MiningPeriodEditor } from "./MiningPeriodEditor";
import { TokenOrb } from "./TokenOrb";

export function CreatorDashboard({ wallet }: { wallet: string }) {
  const [mines, setMines] = useState<CreatorMineView[] | null>(null);
  const [adding, setAdding] = useState(false);
  // Read when the list loads, not during render, so a boost badge reflects the time of the fetch.
  const [loadedAt, setLoadedAt] = useState(0);
  const load = useCallback(() => {
    getCreatorMines().then((result) => { setMines(result.mines); setLoadedAt(Date.now()); }).catch(() => setMines([]));
  }, []);
  useEffect(() => { load(); }, [load, wallet]);
  if (mines === null) return null;
  return (
    <section className="creator-dashboard" aria-labelledby="creator-title">
      <div className="section-heading">
        <div>
          <h2 id="creator-title">Your mines</h2>
          <small>{mines.length > 0 ? "Share your link: whoever opens it digs your coin." : "Have a coin? Turn it into a mine and bring your community."}</small>
        </div>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setAdding(true)}>Add a coin</button>
      </div>
      {adding && <AddCoinModal onClose={() => setAdding(false)} onAdded={load} />}
      {mines.map((mine) => {
        const left = mine.reserve > 0 ? Math.max(0, Math.min(1, mine.remaining / mine.reserve)) : 0;
        const boosted = mine.boostedUntil !== null && mine.boostedUntil * 1000 > loadedAt;
        return (
          <article className="payout-card creator-mine" key={mine.mint}>
            <div className="mine-panel-coin">
              <TokenOrb symbol={mine.symbol} imageUrl={null} />
              <div>
                <strong>${mine.symbol}</strong>
                <small>{mine.kind === "added" ? "Coin you added" : "Coin you launched"}{mine.open ? "" : " · closed"}</small>
              </div>
              {boosted && <span className="boosted-badge">🚀 Boosted</span>}
            </div>
            {mine.rank !== null && <a className="wars-rank" href="/leaderboards?tab=wars">#{mine.rank} in Mine Wars</a>}
            <div className="creator-stats">
              <div><strong>{compact(mine.crews)}</strong><span>crews digging now</span></div>
              <div><strong>{compact(mine.minersThisWeek)}</strong><span>players this week</span></div>
              <div><strong>{compact(mine.holdersPaid)}</strong><span>new holders paid</span></div>
              <div><strong>{compact(mine.paidOut)}</strong><span>${mine.symbol} paid out</span></div>
            </div>
            <div className="progress" aria-label={"$" + mine.symbol + " remaining"}><i style={{ width: Math.round(left * 100) + "%" }} /></div>
            <div className="payout-foot">
              <span>{tokenAmount(mine.remaining)} of {compact(mine.reserve)} left</span>
              {mine.endsAt && <span>Ends {new Date(mine.endsAt * 1000).toLocaleDateString()}</span>}
            </div>
            {mine.open && <MineShare mint={mine.mint} symbol={mine.symbol} location="creator" onBoosted={load} />}
            {mine.open && <MiningPeriodEditor mint={mine.mint} endsAt={mine.endsAt} onChanged={load} />}
          </article>
        );
      })}
    </section>
  );
}
