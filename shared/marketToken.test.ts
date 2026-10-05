import { describe, expect, it } from "vitest";
import { marketTokensFromPairs } from "./marketToken";

const SOL = "So11111111111111111111111111111111111111112";
const pair = (mint: string, liquidity: number, extra: Record<string, unknown> = {}) => ({
  chainId: "solana", dexId: "raydium", pairAddress: "pair-" + liquidity,
  baseToken: { address: mint, name: "Bonk", symbol: "BONK" }, quoteToken: { address: SOL },
  priceNative: "0.0000001", priceUsd: "0.00002", volume: { h24: 1000 }, priceChange: { h24: -4.5 },
  liquidity: { usd: liquidity }, marketCap: 123456, info: { imageUrl: "https://img/x.png" }, ...extra,
});

describe("marketTokensFromPairs", () => {
  it("keeps the most liquid Solana pair per coin", () => {
    const tokens = marketTokensFromPairs([pair("A", 10), pair("A", 500), pair("B", 1), { ...pair("C", 999), chainId: "ethereum" }]);
    expect(tokens.map((token) => [token.mint, token.pairAddress])).toEqual([["A", "pair-500"], ["B", "pair-1"]]);
    expect(tokens[0]).toMatchObject({ symbol: "BONK", priceUsd: 0.00002, priceSol: 0.0000001, change24h: -4.5, marketCap: 123456, imageUrl: "https://img/x.png" });
  });

  it("does not report a SOL price for a pair quoted in another coin, and drops unsafe images", () => {
    const [token] = marketTokensFromPairs([pair("A", 5, { quoteToken: { address: "USDC" }, info: { imageUrl: "javascript:x" } })]);
    expect(token).toMatchObject({ priceSol: null, imageUrl: null });
  });

  it("survives junk", () => {
    expect(marketTokensFromPairs(null)).toEqual([]);
    expect(marketTokensFromPairs([{}, { chainId: "solana" }])).toEqual([]);
  });
});
