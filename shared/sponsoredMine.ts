/**
 * Sponsored mines: input rules shared by the admin form and the Worker route.
 *
 * A sponsor deposits tokens of a coin that already trades into the mining vault; the admin then
 * registers that deposit as a mine. Everything here is pure validation. The chain checks (the mint
 * is a classic SPL Token mint, the vault really holds the deposit) live in worker/sponsored.ts.
 */

export const SPONSORED_MIN_DAYS = 1;
export const SPONSORED_MAX_DAYS = 3_650;
export const SPONSORED_DEFAULT_DAYS = 30;

export interface SponsoredMineInput {
  mint: string;
  symbol: string;
  name: string;
  sponsor: string;
  sponsorUrl: string | null;
  /** The sponsor's wallet, which may change the mining period later. */
  sponsorWallet: string | null;
  /** Whole tokens, as an integer string. Converted to raw units once the mint's decimals are known. */
  reserveWhole: string;
  days: number;
}

export type SponsoredMineParse = { ok: true; value: SponsoredMineInput } | { ok: false; error: string };

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max + 1) : "";
}

export function parseSponsoredMineInput(body: Record<string, unknown>): SponsoredMineParse {
  const mint = text(body.mint, 44);
  if (!BASE58.test(mint)) return { ok: false, error: "Enter the token's mint address" };
  const symbol = text(body.symbol, 12).replace(/^\$/, "").toUpperCase();
  if (!/^[A-Z0-9]{1,12}$/.test(symbol)) return { ok: false, error: "Symbol must be 1-12 letters or digits" };
  const name = text(body.name, 40);
  if (name.length < 1 || name.length > 40) return { ok: false, error: "Name must be 1-40 characters" };
  const sponsor = text(body.sponsor, 40);
  if (sponsor.length < 1 || sponsor.length > 40) return { ok: false, error: "Creator name must be 1-40 characters" };
  const rawUrl = text(body.sponsorUrl, 200);
  let sponsorUrl: string | null = null;
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (url.protocol !== "https:" || rawUrl.length > 200) throw new Error("not https");
      sponsorUrl = url.toString();
    } catch {
      return { ok: false, error: "Project link must be an https:// URL" };
    }
  }
  const sponsorWallet = text(body.sponsorWallet, 44) || null;
  if (sponsorWallet !== null && !BASE58.test(sponsorWallet)) return { ok: false, error: "Project wallet must be a Solana address" };
  const reserveWhole = typeof body.reserve === "number" && Number.isSafeInteger(body.reserve)
    ? String(body.reserve)
    : text(body.reserve, 20).replace(/[,_ ]/g, "");
  if (!/^[1-9][0-9]{0,17}$/.test(reserveWhole)) return { ok: false, error: "Reserve must be a whole number of tokens" };
  const days = body.days === undefined || body.days === null || body.days === "" ? SPONSORED_DEFAULT_DAYS : Number(body.days);
  if (!Number.isInteger(days) || days < SPONSORED_MIN_DAYS || days > SPONSORED_MAX_DAYS) {
    return { ok: false, error: `Duration must be ${SPONSORED_MIN_DAYS}-${SPONSORED_MAX_DAYS} days` };
  }
  return { ok: true, value: { mint, symbol, name, sponsor, sponsorUrl, sponsorWallet, reserveWhole, days } };
}

/** Whole tokens to raw units for a mint with `decimals` places. */
export function wholeToRaw(whole: string, decimals: number): bigint {
  if (!/^[0-9]+$/.test(whole) || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) throw new Error("invalid amount");
  return BigInt(whole) * 10n ** BigInt(decimals);
}

/** The public view of one sponsored mine. Amounts are whole tokens. */
export interface SponsoredMineView {
  mint: string;
  symbol: string;
  name: string;
  sponsor: string;
  sponsorUrl: string | null;
  /** The wallet allowed to change this mine's mining period, if the sponsor gave one. */
  sponsorWallet: string | null;
  status: "ACTIVE" | "CLOSED";
  startsAt: number;
  endsAt: number;
  reserve: number;
  remaining: number;
  mined: number;
  miners: number;
  /** Unix seconds a paid boost lasts until, or null. */
  boostedUntil: number | null;
}
