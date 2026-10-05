/**
 * Share a mine: its /m/ link unfurls as the mine card, and opening it sends the visitor's crew to
 * dig that mine. Used on mine cards, after adding a coin, and on a coin's mine page.
 */
import { useState } from "react";
import { ApiError, preferMine } from "../api";
import { track } from "../analytics";
import { mineLink, rememberMine } from "../mineLink";
import { BoostModal } from "./BoostModal";

export function MineShare({ mint, symbol, location, canDig = false, onBoosted }: { mint: string; symbol: string; location: string; canDig?: boolean; onBoosted?(): void }) {
  const [copied, setCopied] = useState(false);
  const [boosting, setBoosting] = useState(false);
  const [note, setNote] = useState("");
  const link = mineLink(mint);
  const text = `Mine $${symbol} for free on Diggo.fun ⛏️`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      track("mine_link_copied", { mint, location });
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setNote(link);
    }
  }

  async function dig(): Promise<void> {
    try {
      await preferMine(mint);
      setNote(`Your crew digs $${symbol} on its next shift update.`);
      track("mine_link_applied", { mint, location });
    } catch (error) {
      // Not signed in yet: remember it and apply it after sign-in, like an opened link.
      if (error instanceof ApiError && error.status === 401) {
        rememberMine(mint);
        setNote(`Connect your wallet and your crew will dig $${symbol}.`);
      } else {
        setNote(error instanceof Error ? error.message : "Could not switch mines.");
      }
    }
  }

  return (
    <div className="mine-share">
      <div className="mine-share-actions">
        {canDig && <button className="btn btn-primary btn-sm" type="button" onClick={() => void dig()}>Mine this</button>}
        <a className="btn btn-ghost btn-sm" href={intent} target="_blank" rel="noreferrer" onClick={() => track("mine_link_shared", { mint, location, target: "x" })}>Share on X</a>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copy()}>{copied ? "Copied" : "Copy link"}</button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={() => setBoosting(true)}>Boost</button>
      </div>
      {boosting && <BoostModal mint={mint} symbol={symbol} onClose={() => setBoosting(false)} onBoosted={onBoosted} />}
      {note && <small className="mine-share-note">{note}</small>}
    </div>
  );
}
