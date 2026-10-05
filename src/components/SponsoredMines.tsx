/**
 * Sponsored mines: coins other projects put into the mining vault for bots to dig. Each card shows
 * how much is left, so players see the reserve shrink and sponsors see their deposit at work.
 */
import { useEffect, useState } from "react";
import { getSponsoredMines } from "../api";
import { compact, countdown, tokenAmount } from "../format";
import type { SponsoredMineView } from "../../shared/sponsoredMine";
import { TokenOrb } from "./TokenOrb";

export function SponsoredMines({ now, activeMint }: { now: number; activeMint: string | null }) {
  const [mines, setMines] = useState<SponsoredMineView[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => getSponsoredMines().then((list) => { if (live) setMines(list); }).catch(() => { if (live) setMines((current) => current ?? []); });
    void load();
    const timer = window.setInterval(load, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, []);
  const active = (mines ?? []).filter((mine) => mine.status === "ACTIVE" && mine.remaining > 0);
  if (active.length === 0) return null;
  return (
    <section className="sponsored-mines" aria-labelledby="sponsored-mines-title">
      <div className="section-heading">
        <h2 id="sponsored-mines-title">Sponsored mines</h2>
        <small>Projects fund these. Rewards pay out right away.</small>
      </div>
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
                    Sponsored by{" "}
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
            </article>
          );
        })}
      </div>
    </section>
  );
}
