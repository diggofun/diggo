import type { CurveMiningSummary, TokenStatus, TokenSummary } from "../shared/types";

const TOKEN_STATUSES: readonly TokenStatus[] = ["LAUNCHING", "MINING_ACTIVE", "FULLY_MINED", "CURVE_CAP_REACHED"];

type RawToken = Partial<Record<keyof TokenSummary, unknown>> & { mint?: unknown; graduated?: unknown };

function finite(value: unknown, fallback = 0): number {
  const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number) ? number : fallback;
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function status(value: unknown): TokenStatus {
  return TOKEN_STATUSES.includes(value as TokenStatus) ? (value as TokenStatus) : "MINING_ACTIVE";
}

function curveMining(value: unknown, graduated: boolean): CurveMiningSummary {
  const raw = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof CurveMiningSummary, unknown>>;
  return {
    open: raw.open === true,
    disabled: typeof raw.disabled === "boolean" ? raw.disabled : raw.onCurve === undefined,
    onCurve: typeof raw.onCurve === "boolean" ? raw.onCurve : !graduated,
    cap: finite(raw.cap),
    mined: finite(raw.mined),
    remaining: finite(raw.remaining),
    progress: finite(raw.progress),
    blockReward: finite(raw.blockReward),
    unpaid: finite(raw.unpaid),
  };
}

/**
 * Completes a token summary from the API into the full TokenSummary every screen reads.
 *
 * The Meteora list endpoints (bootstrap, token list) serve a slim row - mint, pool, name, symbol,
 * image, reserves - without curve mining, prices or stats. Screens dereference those fields
 * directly (token.curveMining.onCurve, token.status.replaceAll), so a slim row used to crash any
 * view that opened the coin. Missing values become honest "not measured" defaults: zero volume,
 * null 24h change, no curve budget. Present values pass through untouched.
 */
export function normalizeTokenSummary(input: unknown): TokenSummary | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as RawToken;
  if (typeof raw.mint !== "string" || raw.mint === "") return null;
  const mint = raw.mint;
  const graduated = raw.graduated === true;
  const sell = (raw.sellCapacity && typeof raw.sellCapacity === "object" ? raw.sellCapacity : {}) as { sol?: unknown; tokens?: unknown };
  const change = finite(raw.change24h, Number.NaN);
  return {
    ...(input as object),
    mint,
    slug: text(raw.slug, mint),
    name: text(raw.name, mint.slice(0, 6)),
    symbol: text(raw.symbol, mint.slice(0, 6).toUpperCase()),
    description: typeof raw.description === "string" ? raw.description : "",
    creator: typeof raw.creator === "string" ? raw.creator : "",
    imageUrl: typeof raw.imageUrl === "string" && raw.imageUrl !== "" ? raw.imageUrl : null,
    status: status(raw.status),
    priceSol: finite(raw.priceSol),
    priceUsd: finite(raw.priceUsd),
    change24h: raw.change24h === null || raw.change24h === undefined || !Number.isFinite(change) ? null : change,
    volume24hUsd: finite(raw.volume24hUsd),
    trades24h: finite(raw.trades24h),
    curveMining: curveMining(raw.curveMining, graduated),
    sellCapacity: { sol: finite(sell.sol), tokens: sell.tokens === null ? null : finite(sell.tokens) },
    marketCapUsd: finite(raw.marketCapUsd),
    reserveRemaining: finite(raw.reserveRemaining),
    reserveTotal: finite(raw.reserveTotal),
    rewardPerBlock: finite(raw.rewardPerBlock),
    networkPower: finite(raw.networkPower),
    nextBlockAt: finite(raw.nextBlockAt),
    nextEpochAt: finite(raw.nextEpochAt),
    createdAt: finite(raw.createdAt),
    decimals: finite(raw.decimals, 9),
  } as TokenSummary;
}

export function normalizeTokenSummaries(input: unknown): TokenSummary[] {
  if (!Array.isArray(input)) return [];
  return input.map(normalizeTokenSummary).filter((token): token is TokenSummary => token !== null);
}
