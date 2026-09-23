/**
 * Becoming a player, explained for someone who has never used a crypto game.
 *
 * There is one way to play and this panel states it before anything is signed:
 *
 * - **A player account** is one transaction and 0.00239424 SOL of rent that stays in the player's
 *   own PDA. There is no bond, no deposit, no subscription and no minimum balance. The only other
 *   thing a wallet ever needs is the ordinary network fee on a transaction it signs.
 * - **Activation** opens a 24-hour mining window. It is free, and every wallet mines at the same
 *   efficiency and can roll for discoveries, so there is nothing to post to unlock either.
 *
 * Every button here is a transaction the player's own wallet signs. Nothing on this screen is a
 * server decision, which is why the panel reads the PlayerAccount from chain rather than asking
 * the Worker what the player is allowed to do.
 */
import { useCallback, useEffect, useState } from "react";
import { IconMine, IconOre } from "../icons";
import { PLAYER_ACCOUNT_SOL } from "../constants";
import {
  address,
  fetchPlayer,
  type DecodedPlayerAccount,
  type DiggoWallet,
} from "../solanaProgram";
import { usePendingTransaction } from "../onchain";

export type OnboardingStep = "connect" | "create" | "activate" | "ready";

/** Which step a player is on, from the PlayerAccount alone. */
export function onboardingStep(
  player: DecodedPlayerAccount | null,
  walletConnected: boolean,
  nowSeconds: number,
): OnboardingStep {
  if (!walletConnected) return "connect";
  if (!player) return "create";
  if (player.activeUntil <= BigInt(nowSeconds)) return "activate";
  return "ready";
}

const STEP_BADGE: Record<OnboardingStep, string> = {
  connect: "Wallet not connected",
  create: "No player account yet",
  activate: "Window closed — activate to mine",
  ready: "Window open — mining",
};

/** The state badge, so the four states are named in one place. */
export function onboardingBadge(step: OnboardingStep): string {
  return STEP_BADGE[step];
}

/** The one-time cost of playing, as the panel quotes it. */
export const PLAYER_ACCOUNT_COST = PLAYER_ACCOUNT_SOL.toFixed(6) + " SOL";

/** What playing is, stated once. The game has one tier: nothing is bought, posted or held back. */
export const PLAY_SUMMARY =
  "Everyone plays the same way. A player account and an activation are all it takes — there is " +
  "no bond, no deposit and no minimum balance, and no paid tier to unlock.";

/**
 * What a wallet needs, stated once.
 *
 * The wording is deliberately narrow: the rent stays in the player's own account and the network
 * fee is the ordinary Solana fee, so neither can read as a fee the game locks or keeps.
 */
export const WALLET_REQUIREMENT =
  "Your wallet needs SOL for two things: the one-time " +
  PLAYER_ACCOUNT_COST +
  " of rent, which stays in your own player account, and the ordinary network fee on each " +
  "transaction you sign. Nothing else is ever locked or taken.";

export function PlayerOnboarding({
  programAddress,
  wallet,
  onChanged,
}: {
  programAddress: string;
  wallet: DiggoWallet | null;
  onChanged(): void;
}) {
  const [player, setPlayer] = useState<DecodedPlayerAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const pendingTransaction = usePendingTransaction();

  const refresh = useCallback(async () => {
    if (!wallet || !programAddress) {
      setPlayer(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setPlayer(await fetchPlayer(address(programAddress), address(wallet.address)));
      setError("");
    } catch {
      setError("Could not read your player account from chain.");
    } finally {
      setLoading(false);
    }
  }, [programAddress, wallet]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const step = onboardingStep(player, Boolean(wallet), nowSeconds);

  async function run(label: string, action: (program: string) => Promise<unknown>, done: string) {
    if (!wallet) {
      setError("Connect a wallet that can sign transactions first.");
      return;
    }
    if (!pendingTransaction.canSubmit()) return;
    setBusy(label);
    setError("");
    setMessage("");
    try {
      await action(programAddress);
      setMessage(done);
      await refresh();
      onChanged();
    } catch (failure) {
      if (!pendingTransaction.record(failure, done.replace(/\.$/, ""))) setError(failure instanceof Error ? failure.message : "That transaction failed.");
      else setError("");
    } finally {
      setBusy(null);
    }
  }

  const chain = () => import("../solanaProgram");

  return (
    <section className="page-shell onboarding-panel" id="onboarding">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><IconMine size={14} /> Your player</div>
          <h2>START<br />DIGGING.</h2>
        </div>
        <div className="onboarding-state">
          <span className={"badge " + (step === "ready" ? "badge-curve" : "badge-reserve")}>
            <i aria-hidden="true" />
            {onboardingBadge(step)}
          </span>
        </div>
      </div>

      {loading ? (
        <p className="form-message">Reading your player account from chain…</p>
      ) : (
        <div className="onboarding-grid">
          <article className="onboarding-card">
            <h3><IconOre size={16} /> Play</h3>
            <p>{PLAY_SUMMARY}</p>
            <ul className="onboarding-list">
              <li>One transaction creates your player account: {PLAYER_ACCOUNT_COST} of rent, held by your own account.</li>
              <li>Activation is free — only the network fee every Solana transaction costs.</li>
              <li>No ORE, no tokens and no payment are ever required to play.</li>
            </ul>
          </article>

          <article className="onboarding-card">
            <h3><IconMine size={16} /> What your wallet needs</h3>
            <p>{WALLET_REQUIREMENT}</p>
            <ul className="onboarding-list">
              <li>Nothing is locked: no bond, no deposit and no cooldown to wait out.</li>
              <li>Mining efficiency and discovery eligibility are the same for every wallet — there is no paid tier.</li>
              <li>You can stop at any time, and leaving a mine returns its rent.</li>
            </ul>
          </article>
        </div>
      )}

      <div className="onboarding-actions">
        {step === "connect" && <p className="form-message">Connect a wallet to create your player.</p>}

        {step === "create" && (
          <button
            className="primary-button"
            disabled={busy !== null || !pendingTransaction.canSubmit()}
            onClick={() =>
              void run("create", async (program) => {
                const { createPlayerAccount } = await chain();
                return createPlayerAccount({ programAddress: address(program), wallet: wallet! });
              }, "Player account created on chain.")
            }
          >
            {busy === "create" ? "Creating…" : "Create player account"} <IconMine size={16} />
          </button>
        )}

        {(step === "activate" || step === "ready") && (
          <button
            className="outline-button"
            disabled={busy !== null || !pendingTransaction.canSubmit()}
            onClick={() =>
              void run("activate", async (program) => {
                const { activatePlayer } = await chain();
                return activatePlayer({ programAddress: address(program), wallet: wallet! });
              }, "Activated. Your mining window is open for the next 24 hours.")
            }
          >
            {busy === "activate" ? "Activating…" : "Activate today's window"}
          </button>
        )}
      </div>

      {message && <p className="form-message onboarding-ok">{message}</p>}
      {error && <p className="form-message onboarding-error">{error}</p>}
    </section>
  );
}
