/**
 * Client side of the progressive-friction flow (spec 52).
 *
 * When the Worker's risk gate puts an account in UNDER_REVIEW, a gated action answers
 * 403 VERIFICATION_REQUIRED instead of failing outright. The answer is always the same neutral
 * sentence and never a score, weight or signal name, and the player can usually clear the
 * friction immediately: a Turnstile check when the Worker has a Turnstile secret configured, and
 * otherwise one extra wallet signature bound to wallet + action + resource.
 *
 * The UI must never explain more than "Additional verification required" (spec 62), so this
 * module is the only place that knows the difference between the two strategies.
 */
import bs58 from "bs58";
import { ApiError, verifyChallenge } from "./api";

/** The one sentence the UI is allowed to show for friction (spec 62). */
export const NEUTRAL_VERIFICATION_TEXT = "Additional verification required";

/** Raised when a player dismissed the verification prompt or the check did not clear. */
export class VerificationRequiredError extends Error {
  constructor(message: string = NEUTRAL_VERIFICATION_TEXT) {
    super(message);
    this.name = "VerificationRequiredError";
  }
}

export interface GatedActionContext {
  /** Wallet the action belongs to; the challenge is bound to it server-side. */
  wallet: string;
  /** Gated action key, e.g. "activate", "crew_upgrade", "switch_mine", "claim_reward". */
  action: string;
  /** Optional resource the action targets (a mint, a reward id). */
  resource?: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  /** Resolves with a Turnstile token, or rejects when the player gives up. */
  requestTurnstileToken(): Promise<string>;
}

/**
 * Clears friction for wallet + action, using whichever strategy the Worker reports.
 *
 * Throws VerificationRequiredError when the player dismisses the check or the check is refused,
 * so callers only ever have one neutral message to render.
 */
export async function clearVerification(context: GatedActionContext): Promise<void> {
  const base = { wallet: context.wallet, action: context.action, resource: context.resource };
  const first = await verifyChallenge(base);
  if (first.cleared) return;

  if (first.strategy === "turnstile") {
    const turnstileToken = await context.requestTurnstileToken();
    const cleared = await verifyChallenge({ ...base, turnstileToken });
    if (!cleared.cleared) throw new VerificationRequiredError();
    return;
  }

  if (!first.nonce || !first.message) throw new VerificationRequiredError();
  const signature = bs58.encode(await context.signMessage(new TextEncoder().encode(first.message)));
  const cleared = await verifyChallenge({ ...base, nonce: first.nonce, signature });
  if (!cleared.cleared) throw new VerificationRequiredError();
}

/**
 * Runs a gated action, clearing friction once if the Worker asks for it and then retrying.
 *
 * The retry is deliberately bounded: friction clears for a short window (see
 * RISK_OPS.challenge.clearedSeconds), so a second VERIFICATION_REQUIRED means the account is
 * being slowed down rather than verified, and the caller shows the neutral message.
 */
export async function runGated<T>(
  context: GatedActionContext,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ApiError) || !error.verificationRequired) throw error;
  }
  await clearVerification(context);
  return run();
}

/**
 * Signed-challenge flow for actions that carry real value (reward and discovery claims, spec 46,
 * 47). Both endpoints already bind the challenge to one id, so this is the same shape as
 * runGated without the risk-gate branch.
 */
export async function signChallenge(
  message: string,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<string> {
  return bs58.encode(await signMessage(new TextEncoder().encode(message)));
}
