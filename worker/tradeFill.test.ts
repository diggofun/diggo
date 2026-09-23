/**
 * The received side of a trade.
 *
 * v2 emits no trade event, so the fill comes from the transaction's own balance table. These pin
 * the three things that make that safe: the trader is identified by whose token balance moved, the
 * buy and the sell read different sides of it, and an unreadable or ambiguous transaction yields
 * nothing rather than a number the caller would store as if it were a fill.
 */
import { describe, expect, it } from "vitest";
import { tradeFillFromMeta } from "./indexing";

const MINT = "So11111111111111111111111111111111111111112";
const OTHER_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const TRADER = "Trader1111111111111111111111111111111111111";
const OTHER = "Other11111111111111111111111111111111111111";

const token = (owner: string, amount: string, mint = MINT) => ({
  mint,
  owner,
  uiTokenAmount: { amount },
});

describe("tradeFillFromMeta", () => {
  it("reads a buy as the tokens the trader's balance gained", () => {
    const fill = tradeFillFromMeta({
      side: "BUY",
      mint: MINT,
      accountKeys: [TRADER],
      preTokenBalances: [token(TRADER, "1000")],
      postTokenBalances: [token(TRADER, "31250")],
      preBalances: [1_000_000_000],
      postBalances: [999_000_000],
      fee: 5_000,
    });
    expect(fill).toEqual({ amountOut: 30_250n, source: "meta", trader: TRADER });
  });

  it("reads a sell as the lamports the trader received, before the network fee", () => {
    const fill = tradeFillFromMeta({
      side: "SELL",
      mint: MINT,
      accountKeys: [TRADER],
      preTokenBalances: [token(TRADER, "31250")],
      postTokenBalances: [token(TRADER, "21250")],
      preBalances: [1_000_000_000],
      postBalances: [1_306_925_693],
      fee: 5_000,
    });
    // The wallet's own delta is 306,925,693; the 5,000 lamports of fee are what it paid to send,
    // not part of what the venue paid out, so the gross the trader received is the sum.
    expect(fill).toEqual({ amountOut: 306_930_693n, source: "meta", trader: TRADER });
  });

  it("returns nothing when the response carries no balance table", () => {
    expect(
      tradeFillFromMeta({ side: "BUY", mint: MINT, accountKeys: [TRADER] }),
    ).toBeNull();
  });

  it("returns nothing when the mint did not move, or moved the wrong way", () => {
    expect(
      tradeFillFromMeta({
        side: "BUY",
        mint: MINT,
        accountKeys: [TRADER],
        preTokenBalances: [token(TRADER, "1000")],
        postTokenBalances: [token(TRADER, "1000")],
      }),
    ).toBeNull();
    // A "buy" whose token balance fell is not a buy, and guessing which side is which is worse
    // than recording that the fill is unknown.
    expect(
      tradeFillFromMeta({
        side: "BUY",
        mint: MINT,
        accountKeys: [TRADER],
        preTokenBalances: [token(TRADER, "1000")],
        postTokenBalances: [token(TRADER, "500")],
      }),
    ).toBeNull();
  });

  it("ignores another mint's movement and refuses two traders at once", () => {
    expect(
      tradeFillFromMeta({
        side: "BUY",
        mint: MINT,
        accountKeys: [TRADER, OTHER],
        preTokenBalances: [token(TRADER, "0"), token(OTHER, "0", OTHER_MINT)],
        postTokenBalances: [token(TRADER, "500"), token(OTHER, "900", OTHER_MINT)],
      }),
    ).toEqual({ amountOut: 500n, source: "meta", trader: TRADER });

    expect(
      tradeFillFromMeta({
        side: "BUY",
        mint: MINT,
        accountKeys: [TRADER, OTHER],
        preTokenBalances: [token(TRADER, "0"), token(OTHER, "0")],
        postTokenBalances: [token(TRADER, "500"), token(OTHER, "700")],
      }),
    ).toBeNull();
  });

  it("returns nothing for a sell whose lamport balances are missing", () => {
    expect(
      tradeFillFromMeta({
        side: "SELL",
        mint: MINT,
        accountKeys: [],
        preTokenBalances: [token(TRADER, "1000")],
        postTokenBalances: [token(TRADER, "0")],
      }),
    ).toBeNull();
  });
});
