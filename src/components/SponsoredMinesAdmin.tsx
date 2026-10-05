/**
 * Admin: register a sponsor's deposit as a mine, or close one. The deposit has to be in the mining
 * vault first; the Worker reads the vault and refuses a reserve it cannot cover. Every change is
 * signed by the admin wallet.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { closeSponsoredMine, getSponsoredMines, registerSponsoredMine } from "../api";
import { tokenAmount } from "../format";
import { SPONSORED_DEFAULT_DAYS, type SponsoredMineView } from "../../shared/sponsoredMine";

type Sign = (message: Uint8Array) => Promise<Uint8Array>;

const EMPTY = { mint: "", symbol: "", name: "", sponsor: "", sponsorUrl: "", sponsorWallet: "", reserve: "", days: String(SPONSORED_DEFAULT_DAYS) };

export function SponsoredMinesAdmin({ sign, vault }: { sign: Sign | null; vault: string | null }) {
  const [mines, setMines] = useState<SponsoredMineView[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => getSponsoredMines().then(setMines).catch(() => undefined), []);
  useEffect(() => { void load(); }, [load]);

  const field = (key: keyof typeof EMPTY) => ({
    value: form[key],
    onChange: (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value })),
  });

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!sign) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await registerSponsoredMine({
        mint: form.mint.trim(),
        symbol: form.symbol.trim(),
        name: form.name.trim(),
        sponsor: form.sponsor.trim(),
        ...(form.sponsorUrl.trim() ? { sponsorUrl: form.sponsorUrl.trim() } : {}),
        ...(form.sponsorWallet.trim() ? { sponsorWallet: form.sponsorWallet.trim() } : {}),
        reserve: form.reserve.trim(),
        days: Number(form.days),
      }, sign);
      setFailed(false);
      setMessage(`$${form.symbol.trim().toUpperCase()} is live until ${new Date(result.endsAt * 1000).toLocaleDateString()}.`);
      setForm(EMPTY);
      await load();
    } catch (failure) {
      setFailed(true);
      setMessage(failure instanceof Error ? failure.message : "Could not register that mine.");
    } finally {
      setBusy(false);
    }
  }

  async function close(mine: SponsoredMineView): Promise<void> {
    if (!sign || !window.confirm(`Stop mining $${mine.symbol}? Rewards already earned stay payable.`)) return;
    try {
      await closeSponsoredMine(mine.mint, sign);
      setFailed(false);
      setMessage(`$${mine.symbol} is closed.`);
      await load();
    } catch (failure) {
      setFailed(true);
      setMessage(failure instanceof Error ? failure.message : "Could not close that mine.");
    }
  }

  return (
    <div className="admin-block">
      <div className="admin-block-head"><span>MINES CREATED BY PROJECTS</span><small>{mines.filter((mine) => mine.status === "ACTIVE").length} active</small></div>
      <p className="admin-empty">
        1. The project sends the tokens to the mining vault{vault ? <> (<code>{vault}</code>)</> : null}. 2. Register the
        amount here. Classic SPL tokens only; the reserve is released evenly over the duration.
      </p>
      <form className="admin-restriction-form sponsored-admin-form" onSubmit={(event) => void submit(event)}>
        <input placeholder="Mint address" required {...field("mint")} />
        <input placeholder="Symbol" required maxLength={13} {...field("symbol")} />
        <input placeholder="Name" required maxLength={40} {...field("name")} />
        <input placeholder="Created by (project name)" required maxLength={40} {...field("sponsor")} />
        <input placeholder="Project link (https://…, optional)" {...field("sponsorUrl")} />
        <input placeholder="Project wallet (can change the period, optional)" {...field("sponsorWallet")} />
        <input placeholder="Reserve (whole tokens)" inputMode="numeric" required {...field("reserve")} />
        <input placeholder="Days" type="number" min={1} max={3650} required {...field("days")} />
        <button className="btn btn-primary" type="submit" disabled={busy || !sign}>{busy ? "Signing…" : "Register mine"}</button>
      </form>
      {message && <p className={failed ? "form-message admin-job-error" : "form-message admin-notice"} role="status">{message}</p>}
      {mines.length > 0 && (
        <div className="admin-compact-table">
          <div className="admin-compact-row admin-compact-head"><span>Mine</span><span>Remaining</span><span /></div>
          {mines.map((mine) => (
            <div className="admin-compact-row" key={mine.mint}>
              <span title={mine.mint}>${mine.symbol} · {mine.sponsor}<small>{mine.status} · {mine.miners} crews · ends {new Date(mine.endsAt * 1000).toLocaleDateString()}</small></span>
              <strong>{tokenAmount(mine.remaining)} / {tokenAmount(mine.reserve)}</strong>
              {mine.status === "ACTIVE" ? <button className="btn btn-ghost btn-sm" type="button" disabled={!sign} onClick={() => void close(mine)}>Close</button> : <span />}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
