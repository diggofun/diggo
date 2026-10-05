/**
 * Sponsored mines: coins other projects put into the mining vault for bots to dig. Each card shows
 * how much is left, so players see the reserve shrink and sponsors see their deposit at work.
 */
import { useEffect, useRef, useState } from "react";
import { getSponsoredMines } from "../api";
import { compact, countdown, tokenAmount } from "../format";
import type { SponsoredMineView } from "../../shared/sponsoredMine";
import { AddCoinModal } from "./AddCoinModal";
import { MiningPeriodEditor } from "./MiningPeriodEditor";
import { TokenOrb } from "./TokenOrb";

export function SponsoredMines({ now, activeMint, viewer = null }: { now: number; activeMint: string | null; viewer?: string | null }) {
  const [mines, setMines] = useState<SponsoredMineView[] | null>(null);
  const reload = useRef<() => void>(() => undefined);
  useEffect(() => {
    let live = true;
    const load = () => getSponsoredMines().then((list) => { if (live) setMines(list); }).catch(() => { if (live) setMines((current) => current ?? []); });
    void load();
    reload.current = load;
    const timer = window.setInterval(load, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  const [adding, setAdding] = useState(false);
  const active = (mines ?? []).filter((mine) => mine.status === "ACTIVE" && mine.remaining > 0);
  if (mines === null) return null;
  return (
    <section className="sponsored-mines" aria-labelledby="sponsored-mines-title">
      <div className="section-heading">
        <div>
          <h2 id="sponsored-mines-title">More mines</h2>
          <small>Created by coin communities. Rewards pay out right away.</small>
        </div>
        <button className="btn btn-primary btn-sm" type="button" onClick={() => setAdding(true)}>Add your coin</button>
      </div>
      {adding && <AddCoinModal onClose={() => setAdding(false)} onAdded={() => reload.current()} />}
      {active.length === 0 && <p className="sponsored-empty">Hold a Solana coin? Put some of it in a mine and Diggo players will dig it.</p>}
      <div className="sponsored-grid">
        {active.map((mine) => {
          const left = mine.reserve > 0 ? Math.max(0, Math.min(1, mine.remaining / mine.reserve)) : 0;
          const ends = mine.endsAt * 1000 > now ? countdown(mine.endsAt, now) + " left" : "Final hours";
          return (
            <article className="payout-card sponsored-card" key={mine.mint}>
              <div className="mine-panel-coin">
                <TokenOrb symbol={mine.symbol} imageUrl={null} />
                <div>
                  <strong>${mine.symbol}</strong>
                  <small>
                    Mine created by{" "}
                    {mine.sponsorUrl ? <a href={mine.sponsorUrl} target="_blank" rel="noopener noreferrer nofollow">{mine.sponsor}</a> : mine.sponsor}
                  </small>
                </div>
                {mine.mint === activeMint && <span className="pill is-on">Your bots</span>}
              </div>
              <strong className="payout-amount">{tokenAmount(mine.remaining)} <small>left</small></strong>
              <div className="progress" role="progressbar" aria-label={"$" + mine.symbol + " remaining"} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left * 100)}>
                <i style={{ width: Math.round(left * 100) + "%" }} />
              </div>
              <div className="payout-foot">
                <span>{compact(mine.mined)} of {compact(mine.reserve)} mined · {mine.miners} {mine.miners === 1 ? "crew" : "crews"}</span>
                <span>{ends}</span>
              </div>
              {viewer && mine.sponsorWallet === viewer && (
                <MiningPeriodEditor mint={mine.mint} endsAt={mine.endsAt} onChanged={() => reload.current()} />
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}
