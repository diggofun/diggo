/**
 * The mining period control for a coin's creator or a mine's sponsor: how long the rest of the
 * reserve takes to release, counted from now. What was already released stays released.
 */
import { useState } from "react";
import { setMiningPeriod } from "../api";
import { MINING_PERIOD_MAX_DAYS, MINING_PERIOD_MIN_DAYS, MINING_PERIOD_PRESETS } from "../../shared/miningSchedule";

export function MiningPeriodEditor({ mint, endsAt, onChanged }: { mint: string; endsAt: number | null; onChanged?: () => void }) {
  const [days, setDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const value = Number(days);
  const valid = Number.isInteger(value) && value >= MINING_PERIOD_MIN_DAYS && value <= MINING_PERIOD_MAX_DAYS;

  async function save(): Promise<void> {
    if (!valid) return;
    setBusy(true);
    setMessage("");
    try {
      const result = await setMiningPeriod(mint, value);
      setFailed(false);
      setMessage("Mining now runs until " + new Date(result.endsAt * 1000).toLocaleDateString() + ".");
      onChanged?.();
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : "Could not change the mining period.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mining-period">
      <div className="mining-period-head">
        <strong>Mining period</strong>
        <small>{endsAt ? "Ends " + new Date(endsAt * 1000).toLocaleDateString() : "Not set"} · you can change it once a day</small>
      </div>
      <div className="mining-period-presets" role="group" aria-label="Mining period">
        {MINING_PERIOD_PRESETS.map((preset) => (
          <button key={preset.days} type="button" className={"chip" + (value === preset.days ? " is-met" : "")} aria-pressed={value === preset.days} onClick={() => setDays(String(preset.days))}>
            {preset.label}
          </button>
        ))}
      </div>
      <div className="mining-period-row">
        <label>
          <span className="sr-only">Days from now</span>
          <input type="number" inputMode="numeric" min={MINING_PERIOD_MIN_DAYS} max={MINING_PERIOD_MAX_DAYS} value={days} onChange={(event) => setDays(event.target.value)} />
        </label>
        <span>days from now</span>
        <button className="btn btn-primary btn-sm" type="button" disabled={!valid || busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</button>
      </div>
      <p className="mining-period-note">The rest of the reserve is spread evenly over this time. A shorter period pays your miners faster; nothing already mined changes.</p>
      {message && <p className={"form-message" + (failed ? " admin-job-error" : "")} role="status">{message}</p>}
    </div>
  );
}
