/**
 * The live mine, alone: what the X player card, a Telegram message or any iframe shows. The crew
 * digs the coin in a flat scene, with the numbers that move (what is left, crews digging, the Mine
 * Wars rank) refreshed every few seconds. No wallet, no account: the one action is a button that
 * opens the full mine in a new tab, since a frame inside a post cannot sign anything.
 */
import { useEffect, useState } from "react";
import { BotMine } from "./BotMine";
import { compact } from "../format";

interface Live {
  symbol: string;
  name: string;
  createdBy: string | null;
  open: boolean;
  paysNow: boolean;
  remaining: number;
  reserve: number;
  crews: number;
  rank: number | null;
  boosted: boolean;
}

const MINT = /^\/embed\/mine\/([^/]+)\/?$/;

export function embedMintFromPath(pathname: string): string | null {
  const match = MINT.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]!);
  } catch {
    return null;
  }
}

export function EmbedMine({ mint }: { mint: string }) {
  const [live, setLive] = useState<Live | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let current = true;
    const load = () => fetch("/api/live/mine/" + encodeURIComponent(mint))
      .then(async (response) => {
        if (response.status === 404) { if (current) setMissing(true); return; }
        const data = await response.json() as Live;
        if (current) { setLive(data); setMissing(false); }
      })
      .catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 5_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [mint]);

  const open = "https://diggo.fun/m/" + encodeURIComponent(mint);
  if (missing) {
    return <main className="embed-mine"><p className="embed-note">This mine is not on Diggo yet.</p><a className="embed-cta" href="https://diggo.fun" target="_blank" rel="noreferrer">Open Diggo.fun</a></main>;
  }
  if (!live) return <main className="embed-mine" aria-busy="true"><p className="embed-note">Loading the mine…</p></main>;

  const left = live.reserve > 0 ? Math.max(0, Math.min(1, live.remaining / live.reserve)) : 0;
  return (
    <main className="embed-mine">
      <header className="embed-head">
        <div>
          <strong>${live.symbol}</strong>
          <small>{live.createdBy ? "Mine created by " + live.createdBy : "Launched on Diggo"}</small>
        </div>
        {live.boosted && <span className="boosted-badge">🚀 Boosted</span>}
        {live.rank !== null && <span className="pill is-on">#{live.rank} in Mine Wars</span>}
      </header>
      <BotMine crew={Math.max(1, Math.min(9, live.crews))} active={live.open && live.crews > 0} symbols={[live.symbol]} className="embed-scene" />
      <div className="embed-stats">
        <div><strong>{live.crews}</strong><span>{live.crews === 1 ? "crew" : "crews"} digging</span></div>
        <div><strong>{compact(live.remaining)}</strong><span>${live.symbol} left</span></div>
        <div className="embed-bar" role="progressbar" aria-label="Remaining" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(left * 100)}><i style={{ width: Math.round(left * 100) + "%" }} /></div>
      </div>
      <a className="embed-cta" href={open} target="_blank" rel="noreferrer">Mine ${live.symbol} for free ⛏️</a>
    </main>
  );
}
