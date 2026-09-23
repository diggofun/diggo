import { DEFAULT_DISCOVERY_RESERVE_BPS, DEFAULT_RESERVE_BPS } from "../shared/program";

/** Public Cloudflare Turnstile site key; the Worker may override it via bootstrap config. */
export const TURNSTILE_SITE_KEY = "0x4AAAAAAEzwvf6nnwXvXdMc";

/**
 * The lamport figures the cost copy below is derived from. They are restated here rather than
 * derived from the on-chain account table so that the cost copy remains a small display module.
 * src/constants.test.ts pins every one of them against shared/program.ts, so a contract change
 * fails a test instead of quietly misquoting a price.
 */
export const LAUNCH_RENT_LAMPORTS_MIRROR = 3_939_360 + 4_120_320 + 2_039_280;
export const LAUNCH_TX_FEE_LAMPORTS_MIRROR = 130_000;
export const PLAYER_ACCOUNT_RENT_LAMPORTS_MIRROR = 2_394_240;
/** The MiningPosition's 51 bytes at the cluster's formula: 1,245,840, not the 1,246,440 the
 * contract document's rent column quotes. */
export const MINING_POSITION_RENT_LAMPORTS_MIRROR = 1_245_840;

/**
 * User-facing cost copy, derived from the frozen account table rather than typed in, so the
 * number the launch form promises and the number the chain charges cannot drift.
 *
 * The launch rent is the three accounts a coin is made of: the Token-2022 mint at 3,939,360
 * lamports, the Coin account at 4,120,320 and the coin's single token vault at 2,039,280. Every
 * one of those is spent rather than deposited, because the mint and the Coin can never be closed
 * while supply exists.
 */
export const LAUNCH_RENT_SOL = LAUNCH_RENT_LAMPORTS_MIRROR / 1_000_000_000;
export const LAUNCH_TX_FEE_SOL = LAUNCH_TX_FEE_LAMPORTS_MIRROR / 1_000_000_000;
/** The headline figure the launch form shows a creator. */
export const LAUNCH_TOTAL_SOL = LAUNCH_RENT_SOL + LAUNCH_TX_FEE_SOL;

/**
 * The one-time cost of becoming a player, in whole SOL: the PlayerAccount's rent, and nothing
 * else. Playing costs no bond and no deposit, so this is the whole of what a wallet has to be
 * able to cover before its first mine. The MiningPosition's rent is paid on the first mine a
 * player joins and comes back when they leave.
 */
export const PLAYER_ACCOUNT_SOL = PLAYER_ACCOUNT_RENT_LAMPORTS_MIRROR / 1_000_000_000;
export const MINING_POSITION_SOL = MINING_POSITION_RENT_LAMPORTS_MIRROR / 1_000_000_000;

/**
 * The launch form's default reserve split, in bps of the fixed supply: 5% to the coin's Mining
 * Reserve and 0.5% to its Discovery Reserve. The program-level exports are the single source;
 * these names preserve the client-facing API used by the launch form. Both are launch arguments
 * rather than protocol policy — a creator can name different ones, and the form shows the split
 * it will actually send.
 */
export const LAUNCH_RESERVE_BPS = DEFAULT_RESERVE_BPS;
export const LAUNCH_DISCOVERY_RESERVE_BPS = DEFAULT_DISCOVERY_RESERVE_BPS;
