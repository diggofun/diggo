import { describe, expect, it } from "vitest";
import {
  ACCOUNT_RENT_LAMPORTS,
  DEFAULT_DISCOVERY_RESERVE_BPS,
  DEFAULT_RESERVE_BPS,
  LAUNCH_RENT_LAMPORTS,
} from "../shared/program";
import {
  LAUNCH_DISCOVERY_RESERVE_BPS,
  LAUNCH_RENT_LAMPORTS_MIRROR,
  LAUNCH_RENT_SOL,
  LAUNCH_RESERVE_BPS,
  LAUNCH_TOTAL_SOL,
  MINING_POSITION_RENT_LAMPORTS_MIRROR,
  MINING_POSITION_SOL,
  PLAYER_ACCOUNT_RENT_LAMPORTS_MIRROR,
  PLAYER_ACCOUNT_SOL,
} from "./constants";

/**
 * src/constants.ts restates the lamport figures the cost copy is built from so that the module
 * stays free of the Solana client. These pin every restated number against the contract, so a
 * change to the account table fails here instead of silently misquoting a price to a creator.
 */

describe("the cost copy mirrors the frozen account table", () => {
  it("agrees with shared/program.ts on every restated lamport figure", () => {
    expect(LAUNCH_RENT_LAMPORTS_MIRROR).toBe(Number(LAUNCH_RENT_LAMPORTS));
    expect(PLAYER_ACCOUNT_RENT_LAMPORTS_MIRROR).toBe(Number(ACCOUNT_RENT_LAMPORTS.playerAccount));
    expect(MINING_POSITION_RENT_LAMPORTS_MIRROR).toBe(Number(ACCOUNT_RENT_LAMPORTS.miningPosition));
    expect(PLAYER_ACCOUNT_RENT_LAMPORTS_MIRROR).toBe(2_394_240);
    expect(MINING_POSITION_RENT_LAMPORTS_MIRROR).toBe(1_245_840);
    expect(LAUNCH_RENT_LAMPORTS_MIRROR).toBe(10_098_960);
    // CCR-F5: the launch form's reserve split reads the program-level source rather than a copy.
    expect(LAUNCH_RESERVE_BPS).toBe(DEFAULT_RESERVE_BPS);
    expect(LAUNCH_DISCOVERY_RESERVE_BPS).toBe(DEFAULT_DISCOVERY_RESERVE_BPS);
    expect(DEFAULT_RESERVE_BPS).toBe(500);
    expect(DEFAULT_DISCOVERY_RESERVE_BPS).toBe(50);
  });
});

describe("the launch cost the form shows", () => {
  it("is the three accounts' rent plus the network fee, about 0.01 SOL", () => {
    expect(LAUNCH_RENT_SOL).toBeCloseTo(0.01009896, 8);
    expect(LAUNCH_TOTAL_SOL).toBeCloseTo(0.01022896, 8);
    // The design's headline figure. A change beyond a rounding error means the account table
    // moved and the launch copy has to move with it.
    expect(LAUNCH_TOTAL_SOL).toBeGreaterThan(0.01);
    expect(LAUNCH_TOTAL_SOL).toBeLessThan(0.011);
  });
});

describe("the player-side costs the onboarding panel shows", () => {
  it("charges one player account's rent and nothing else", () => {
    // There is no bond and no deposit, so the player account's rent is the whole of what a wallet
    // has to be able to cover before it can play.
    expect(PLAYER_ACCOUNT_SOL).toBeCloseTo(0.00239424, 8);
    expect(PLAYER_ACCOUNT_SOL).toBeGreaterThan(0);
    expect(PLAYER_ACCOUNT_SOL).toBeLessThan(0.01);
  });

  it("separates the one-time player rent from the position rent that comes back", () => {
    expect(MINING_POSITION_SOL).toBeCloseTo(0.00124584, 8);
  });
});
