/** One coin's market, as the trade screen shows it (worker/marketData.ts, from Dexscreener). */
export interface MarketToken {
  mint: string;
  symbol: string;
  name: string;
  imageUrl: string | null;
  priceUsd: number | null;
  priceSol: number | null;
  change24h: number | null;
  volume24h: number | null;
  liquidityUsd: number | null;
  marketCap: number | null;
  pairAddress: string | null;
  dexId: string | null;
}

const num = (value: unknown): number | null => {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

type DexPair = {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string };
  priceNative?: string;
  priceUsd?: string;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number };
  fdv?: number;
  marketCap?: number;
  info?: { imageUrl?: string };
};

const SOL = "So11111111111111111111111111111111111111112";

/**
 * Dexscreener pairs to one entry per base token: the most liquid Solana pair wins. priceSol is only
 * filled when that pair is quoted in SOL, since priceNative is in the quote token.
 */
export function marketTokensFromPairs(pairs: unknown): MarketToken[] {
  const best = new Map<string, DexPair>();
  for (const pair of Array.isArray(pairs) ? (pairs as DexPair[]) : []) {
    const mint = pair?.baseToken?.address;
    if (pair?.chainId !== "solana" || typeof mint !== "string" || mint === SOL) continue;
    const current = best.get(mint);
    if (!current || (num(pair.liquidity?.usd) ?? 0) > (num(current.liquidity?.usd) ?? 0)) best.set(mint, pair);
  }
  return [...best.entries()].map(([mint, pair]) => ({
    mint,
    symbol: String(pair.baseToken?.symbol ?? mint.slice(0, 6)).slice(0, 16),
    name: String(pair.baseToken?.name ?? pair.baseToken?.symbol ?? mint).slice(0, 48),
    imageUrl: typeof pair.info?.imageUrl === "string" && /^https:\/\//.test(pair.info.imageUrl) ? pair.info.imageUrl : null,
    priceUsd: num(pair.priceUsd),
    priceSol: pair.quoteToken?.address === SOL ? num(pair.priceNative) : null,
    change24h: num(pair.priceChange?.h24),
    volume24h: num(pair.volume?.h24),
    liquidityUsd: num(pair.liquidity?.usd),
    marketCap: num(pair.marketCap) ?? num(pair.fdv),
    pairAddress: typeof pair.pairAddress === "string" ? pair.pairAddress : null,
    dexId: typeof pair.dexId === "string" ? pair.dexId : null,
  }));
}
