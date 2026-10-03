/**
 * The player's share card: the same image their referral link unfurls into on X, Discord and
 * WhatsApp (worker/share), with one tap to post it on X and one to copy the link.
 */
import { useEffect, useState } from "react";
import { track } from "../analytics";
import { getReferrals } from "../api";
import { IconCopy } from "../icons";
import { referralLink } from "../referralLink";

const POST_TEXT = "My bot crew is digging memecoins for free on @Diggo_Fun. Get your own crew:";

export function ShareCard({ code, location }: { code: string; location: string }) {
  const [note, setNote] = useState("");
  const [imageOk, setImageOk] = useState(true);
  const link = referralLink(code);
  const image = `/api/share/${encodeURIComponent(code)}.png`;
  const intent = `https://x.com/intent/post?text=${encodeURIComponent(POST_TEXT)}&url=${encodeURIComponent(link)}`;

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(link);
      setNote("Link copied. Paste it anywhere: it shows your card.");
      track("share_card_shared", { target: "copy", location });
    } catch {
      setNote(link);
    }
  }

  return (
    <article className="share-card">
      <div className="share-card-head">
        <h2>Show off your crew</h2>
        <p>Your link shows this card wherever you post it, and anyone who joins through it earns you ORE.</p>
      </div>
      {imageOk && (
        <img className="share-card-image" src={image} alt="Your share card: your bot and what it dug" width={1200} height={630} loading="lazy" onError={() => setImageOk(false)} />
      )}
      <div className="share-card-actions">
        <a className="btn btn-primary" href={intent} target="_blank" rel="noreferrer" onClick={() => track("share_card_shared", { target: "x", location })}>
          Share on X
        </a>
        <button type="button" className="btn btn-ghost" onClick={() => void copy()}>
          <IconCopy size={16} /> Copy link
        </button>
      </div>
      {note && <p className="share-card-note" role="status">{note}</p>}
    </article>
  );
}

/** The share card for the signed-in player, wherever the referral code is not already loaded. */
export function MyShareCard({ location }: { location: string }) {
  const [code, setCode] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getReferrals(1)
      .then((panel) => { if (current) setCode(panel.code); })
      .catch(() => undefined);
    return () => { current = false; };
  }, []);
  return code ? <ShareCard code={code} location={location} /> : null;
}
