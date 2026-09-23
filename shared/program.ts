/**
 * Thin, dependency-free client for the diggo_protocol Anchor program, built directly on
 * @solana/kit primitives (already a project dependency, isomorphic between the browser
 * frontend and the Cloudflare Worker keeper — no @coral-xyz/anchor, no Buffer).
 *
 * Account layouts, PDA seeds and instruction discriminators are transcribed from
 * programs/diggo-protocol/src/lib.rs and its generated IDL. If the program changes,
 * this file must change with it — there is no code generation step.
 */
import {
  type Address,
  address,
  type Instruction,
  type ReadonlyUint8Array,
  AccountRole,
  getProgramDerivedAddress,
  getU8Encoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getI64Encoder,
  getAddressEncoder,
} from "@solana/kit";
// Used only by the synchronous PDA helper below. @noble/curves is a declared dependency
// (the worker already imports its ed25519 module) and it pins @noble/hashes.
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

type IInstruction = Instruction;
type Bytes = Uint8Array | ReadonlyUint8Array;

export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const BPF_LOADER_UPGRADEABLE_ADDRESS = address("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Anchor's own base for `#[error_code]` enums: every variant is this plus its declaration index.
 * The program pins the index it relies on in a Rust test (lib.rs:
 * sync_behind_is_the_error_code_the_worker_matches), so the two can only drift deliberately.
 */
export const ERROR_CODE_OFFSET = 6_000;

/**
 * `DiggoError::SyncBehind` (variant 44): the program's retryable "this mine's ledger is still
 * behind" refusal. It is the authority a caller reacts to rather than a condition to predict:
 * the keeper attempts graduate_market and treats this answer as "advance the mine and ask
 * again", instead of guessing from its own model whether the mine is caught up.
 */
export const SYNC_BEHIND_ERROR_CODE = ERROR_CODE_OFFSET + 44;

const DISCRIMINATOR = {
  initializeProtocol: [188, 233, 252, 106, 134, 146, 202, 91],
  rotateKeeper: [201, 88, 117, 249, 81, 101, 255, 55],
  launchToken: [10, 128, 86, 171, 3, 137, 161, 244],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  initializePlayer: [79, 249, 88, 177, 220, 62, 56, 128],
  assignPower: [91, 85, 179, 221, 48, 238, 125, 89],
  removePower: [156, 78, 134, 240, 166, 100, 199, 228],
  advanceMine: [219, 100, 97, 253, 117, 231, 58, 7],
  claimRewards: [4, 144, 132, 71, 116, 23, 151, 80],
  syncCrewPower: [69, 12, 225, 37, 147, 155, 26, 111],
  claimDiscovery: [82, 247, 137, 110, 42, 233, 221, 207],
  // spec 19/23/35/37/65 hardening: scoped circuit breakers, guardian rotation, bounded
  // keeper power, explicit trading fees.
  pauseDiscoveryPayouts: [75, 20, 112, 149, 127, 54, 56, 174],
  pauseRewardClaims: [42, 72, 213, 117, 127, 179, 47, 157],
  pauseMineDiscovery: [89, 93, 22, 73, 178, 169, 66, 219],
  rotateGuardian: [71, 22, 223, 22, 230, 118, 101, 114],
  updatePowerBounds: [50, 202, 219, 213, 8, 191, 131, 216],
  updateFeeConfig: [104, 184, 103, 242, 88, 151, 107, 20],
  // Corrected against the generated IDL: sha256("global:update_discovery_limits")[..8].
  // The previous value here did not match the program, so every update_discovery_limits
  // transaction built by this client failed with InstructionFallbackNotFound.
  updateDiscoveryLimits: [53, 37, 162, 152, 210, 168, 44, 6],
  claimCreatorFees: [0, 23, 125, 234, 156, 118, 134, 89],
  claimPlatformFees: [159, 129, 37, 35, 170, 99, 163, 16],
  // spec 36 locked liquidity + account versioning: graduation into a program-owned
  // constant-product pool, its two swap instructions, and the guarded layout migration.
  graduateMarket: [202, 28, 33, 115, 186, 96, 1, 90],
  poolBuy: [32, 177, 250, 138, 152, 160, 125, 9],
  poolSell: [27, 220, 151, 88, 147, 213, 57, 42],
  migrateAccount: [177, 228, 60, 125, 13, 116, 44, 84],
} as const satisfies Record<string, number[]>;

/**
 * Appended layout version stamped into ProtocolConfig, Mine and LaunchMarket. It is the
 * last field of each of those structs, so an account written before it existed still
 * decodes for every other field and reads back as version 0.
 *
 * Version 2 appends the curve-mining ledger to LaunchMarket and the curve-phase flag to
 * Mine *after* the version byte, so a version 1 account still decodes and reads every
 * field added since as its safe default. Nothing is appended between the old fields and
 * the version byte, which is what keeps that possible.
 *
 * Version 3 appends Mine's second phase flag, `graduated`, after the curve-phase flag. It is
 * the mirror the mining ledger reads to decide which side pays a block - the market's curve
 * inventory before graduation, the mine's Mining Reserve after it - so that decision never
 * depends on whether an optional market account was handed over. A version 2 account reads it
 * as false, which is the safe default: a walk without the market refuses rather than paying
 * out of the reserve.
 *
 * Version 4 appends Mine's graduation cursor, `curvePhaseEndsAt`, after that flag: the instant
 * the curve phase ended, written by graduate_market in the same transaction it flips
 * `graduated`, and zero for a mine that has not graduated. The program classifies every block
 * that landed before it as curve-phase for good, so an un-walked stretch can never be paid out
 * of the Mining Reserve; graduation walks the ledger to that instant before it flips anything.
 * A version 3 account reads it as zero, which means no cursor and the phase following
 * `graduated` alone.
 */
export const ACCOUNT_VERSION = 4;

/**
 * Launch defaults and bounds for curve-phase mining, mirroring DEFAULT_CURVE_MINING_BPS,
 * MAX_CURVE_MINING_BPS, DEFAULT_CURVE_MINING_RUNWAY_DAYS and MAX_CURVE_MINING_RUNWAY_DAYS in
 * programs/diggo-protocol/src/lib.rs. A launch that does not name a share gets the default
 * one; shared/curve.test.ts pins that DIGGO_CONFIG.curve agrees with these.
 */
export const DEFAULT_CURVE_MINING_BPS = 500;
export const MAX_CURVE_MINING_BPS = 1_000;
export const DEFAULT_CURVE_MINING_RUNWAY_DAYS = 30;
export const MAX_CURVE_MINING_RUNWAY_DAYS = 3_650;

/** Account kinds accepted by migrate_account (mirrors ACCOUNT_KIND_* in lib.rs). */
export const MIGRATABLE_ACCOUNT_KIND = {
  protocol: 0,
  mine: 1,
  market: 2,
} as const;

export type MigratableAccountKind = (typeof MIGRATABLE_ACCOUNT_KIND)[keyof typeof MIGRATABLE_ACCOUNT_KIND];

// --- byte-level (Borsh-compatible) encoding helpers -------------------------------------

function concatBytes(...parts: Bytes[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u8 = (n: number) => getU8Encoder().encode(n);
const u16 = (n: number) => getU16Encoder().encode(n);
const u64 = (n: bigint) => getU64Encoder().encode(n);
const bool = (value: boolean) => u8(value ? 1 : 0);
const i64 = (n: bigint) => getI64Encoder().encode(n);
const pubkeyBytes = (a: Address) => getAddressEncoder().encode(a);
function borshString(value: string): Uint8Array {
  const body = new TextEncoder().encode(value);
  return concatBytes(getU32Encoder().encode(body.length), body);
}

// --- PDA seed helpers ---------------------------------------------------------------------

const constSeed = (value: string) => new TextEncoder().encode(value);
const accountSeed = (a: Address) => pubkeyBytes(a);

// --- PDA derivation -------------------------------------------------------------------------

export async function deriveProtocolPda(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("protocol")] });
  return pda;
}

/**
 * Synchronous PDA derivation, mirroring @solana/kit's getProgramDerivedAddress: hash the
 * seeds, then the bump byte, then the program address and the "ProgramDerivedAddress"
 * marker, and take the first bump whose digest is not a valid ed25519 point. It exists so
 * that instruction builders whose callers compose transactions synchronously can still
 * resolve a required PDA — see buildClaimRewardsInstruction.
 */
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurveAddress(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

export function findProgramAddressSync(seeds: Uint8Array[], programAddress: Address): Address {
  const programBytes = pubkeyBytes(programAddress);
  for (let bump = 255; bump >= 0; bump--) {
    const digest = sha256(concatBytes(...seeds, Uint8Array.of(bump), programBytes, PDA_MARKER));
    if (!isOnCurveAddress(digest)) return address(base58FromBytes(digest));
  }
  throw new Error("Unable to find a viable program address bump");
}

/** The protocol config PDA, resolved without awaiting — see findProgramAddressSync. */
export function deriveProtocolPdaSync(programAddress: Address): Address {
  return findProgramAddressSync([constSeed("protocol")], programAddress);
}

/** The market PDA, resolved without awaiting — see findProgramAddressSync. */
export function deriveMarketPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync([constSeed("market"), Uint8Array.from(accountSeed(mint))], programAddress);
}

/** The market's token vault PDA, resolved without awaiting. */
export function deriveMarketVaultPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync(
    [constSeed("market-vault"), Uint8Array.from(accountSeed(mint))],
    programAddress,
  );
}

export async function deriveProgramDataAddress(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
    seeds: [accountSeed(programAddress)],
  });
  return pda;
}

export async function deriveMintPda(programAddress: Address, creator: Address, nonce: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("mint"), accountSeed(creator), u64(nonce)],
  });
  return pda;
}

export async function deriveMinePda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("mine"), accountSeed(mint)] });
  return pda;
}

export async function deriveMarketPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("market"), accountSeed(mint)] });
  return pda;
}

export async function deriveMarketVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("market-vault"), accountSeed(mint)],
  });
  return pda;
}

export async function deriveReserveVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("reserve-vault"), accountSeed(mint)],
  });
  return pda;
}

export async function deriveDiscoveryVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("discovery-vault"), accountSeed(mint)],
  });
  return pda;
}

/**
 * The graduated market's liquidity pool PDA. It mints no LP token and its two vaults are
 * owned by this PDA, so its liquidity is permanently program-controlled (spec 35, 36).
 */
export async function deriveLiquidityPoolPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("pool"), accountSeed(mint)],
  });
  return pda;
}

/** The pool's token vault; the pool PDA is its only authority. */
export async function derivePoolTokenVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("pool-vault"), accountSeed(mint)],
  });
  return pda;
}

/** The pool's SOL vault; lamports = rent floor + pool.sol_reserve, and nothing else. */
export async function derivePoolSolVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("pool-sol"), accountSeed(mint)],
  });
  return pda;
}

/** Idempotency receipt PDA for one (mine, discovery_id) discovery payout. */
export async function deriveDiscoveryReceiptPda(
  programAddress: Address,
  mine: Address,
  discoveryId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("discovery"), accountSeed(mine), u64(discoveryId)],
  });
  return pda;
}

export async function derivePlayerPda(programAddress: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("player"), accountSeed(owner)] });
  return pda;
}

export async function derivePositionPda(programAddress: Address, mine: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("position"), accountSeed(mine), accountSeed(owner)],
  });
  return pda;
}

export async function deriveAssociatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [accountSeed(owner), accountSeed(TOKEN_PROGRAM_ADDRESS), accountSeed(mint)],
  });
  return pda;
}

/** Every derived address needed to operate on one already-launched mine. */
export interface MineAddresses {
  mint: Address;
  mine: Address;
  market: Address;
  marketVault: Address;
  reserveVault: Address;
  discoveryVault: Address;
}

export async function deriveMineAddresses(programAddress: Address, mint: Address): Promise<MineAddresses> {
  const [mine, market, marketVault, reserveVault, discoveryVault] = await Promise.all([
    deriveMinePda(programAddress, mint),
    deriveMarketPda(programAddress, mint),
    deriveMarketVaultPda(programAddress, mint),
    deriveReserveVaultPda(programAddress, mint),
    deriveDiscoveryVaultPda(programAddress, mint),
  ]);
  return { mint, mine, market, marketVault, reserveVault, discoveryVault };
}

/** Every derived address needed to trade on a graduated market's pool. */
export interface PoolAddresses {
  mint: Address;
  pool: Address;
  poolTokenVault: Address;
  poolSolVault: Address;
}

/**
 * Pool addresses for one mint, kept out of deriveMineAddresses on purpose: those three
 * PDAs only exist after graduation, and every pre-graduation caller should not pay for
 * deriving them.
 */
export async function derivePoolAddresses(programAddress: Address, mint: Address): Promise<PoolAddresses> {
  const [pool, poolTokenVault, poolSolVault] = await Promise.all([
    deriveLiquidityPoolPda(programAddress, mint),
    derivePoolTokenVaultPda(programAddress, mint),
    derivePoolSolVaultPda(programAddress, mint),
  ]);
  return { mint, pool, poolTokenVault, poolSolVault };
}

// --- account meta helpers -------------------------------------------------------------------

const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE }) as const;
const r = (a: Address) => ({ address: a, role: AccountRole.READONLY }) as const;
const ws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER }) as const;
const rs = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER }) as const;

// --- instruction builders --------------------------------------------------------------------

export function buildInitializeProtocolInstruction(params: {
  programAddress: Address;
  payer: Address;
  protocol: Address;
  programData: Address;
  treasury: Address;
  keeper: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.payer),
      r(params.programAddress),
      r(params.programData),
      w(params.protocol),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.initializeProtocol),
      pubkeyBytes(params.treasury),
      pubkeyBytes(params.keeper),
    ),
  };
}

export interface LaunchTokenArgs {
  nonce: bigint;
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  totalSupply: bigint;
  reserveBps: number;
  initialBlockReward: bigint;
  minimumReward: bigint;
  blockInterval: bigint;
  epochLength: bigint;
  reductionBps: number;
  virtualSolReserve: bigint;
  graduationTarget: bigint;
  discoveryReserveBps: number;
  /**
   * Share of the curve's initial token inventory that pre-graduation mining may emit, in
   * bps. Optional so an existing launch call keeps working: omitted means the protocol
   * default (DEFAULT_CURVE_MINING_BPS), and 0 is legal and switches curve-phase mining off.
   * The program rejects anything above MAX_CURVE_MINING_BPS.
   */
  curveMiningBps?: number;
  /** Runway, in whole days, over which that budget is spread. Omitted means the default. */
  curveMiningRunwayDays?: number;
}

export function buildLaunchTokenInstruction(params: {
  programAddress: Address;
  creator: Address;
  protocol: Address;
  treasury: Address;
  feeVault: Address;
  args: LaunchTokenArgs;
} & MineAddresses): IInstruction {
  const a = params.args;
  const data = concatBytes(
    Uint8Array.from(DISCRIMINATOR.launchToken),
    u64(a.nonce),
    borshString(a.name),
    borshString(a.symbol),
    borshString(a.uri),
    u8(a.decimals),
    u64(a.totalSupply),
    u16(a.reserveBps),
    u64(a.initialBlockReward),
    u64(a.minimumReward),
    i64(a.blockInterval),
    i64(a.epochLength),
    u16(a.reductionBps),
    u64(a.virtualSolReserve),
    u64(a.graduationTarget),
    u16(a.discoveryReserveBps),
    u16(a.curveMiningBps ?? DEFAULT_CURVE_MINING_BPS),
    u16(a.curveMiningRunwayDays ?? DEFAULT_CURVE_MINING_RUNWAY_DAYS),
  );
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.creator),
      r(params.protocol),
      r(params.treasury),
      w(params.mint),
      w(params.mine),
      w(params.market),
      w(params.marketVault),
      w(params.reserveVault),
      w(params.discoveryVault),
      w(params.feeVault),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data,
  };
}

export function buildBuyInstruction(params: {
  programAddress: Address;
  buyer: Address;
  buyerTokens: Address;
  solIn: bigint;
  minTokensOut: bigint;
} & MineAddresses): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.buyer),
      w(params.mine),
      w(params.market),
      r(params.mint),
      w(params.marketVault),
      w(params.buyerTokens),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.buy), u64(params.solIn), u64(params.minTokensOut)),
  };
}

export function buildSellInstruction(params: {
  programAddress: Address;
  seller: Address;
  sellerTokens: Address;
  tokensIn: bigint;
  minSolOut: bigint;
} & MineAddresses): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.seller),
      r(params.mine),
      w(params.market),
      r(params.mint),
      w(params.marketVault),
      w(params.sellerTokens),
      r(TOKEN_PROGRAM_ADDRESS),
    ],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.sell), u64(params.tokensIn), u64(params.minSolOut)),
  };
}

export function buildInitializePlayerInstruction(params: {
  programAddress: Address;
  owner: Address;
  player: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [ws(params.owner), w(params.player), r(SYSTEM_PROGRAM_ADDRESS)],
    data: Uint8Array.from(DISCRIMINATOR.initializePlayer),
  };
}

export function buildAssignPowerInstruction(params: {
  programAddress: Address;
  owner: Address;
  player: Address;
  mine: Address;
  position: Address;
  /**
   * The mine's mint, from which the market PDA is derived. Required, and the market account is
   * always appended: while a market is still on its curve only the curve's own token inventory
   * may pay a block, and the market account is the only place that ledger lives, so a walk
   * without it cannot settle a curve-phase block at all — the program refuses with SyncBehind
   * and the assignment stays unsettled until somebody walks the mine with advance_mine. Making
   * the mint a required parameter is what keeps that refusal out of the client and keeper
   * paths: there is no way to build an assign_power that a pre-graduation mine cannot settle.
   */
  mint: Address;
  /** Optional override; must be the market PDA derived from `mint`. */
  market?: Address;
}): IInstruction {
  const market = params.market ?? deriveMarketPdaSync(params.programAddress, params.mint);
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.owner),
      w(params.player),
      w(params.mine),
      w(params.position),
      r(SYSTEM_PROGRAM_ADDRESS),
      w(market),
    ],
    data: Uint8Array.from(DISCRIMINATOR.assignPower),
  };
}

export function buildRemovePowerInstruction(params: {
  programAddress: Address;
  owner: Address;
  player: Address;
  mine: Address;
  position: Address;
  /**
   * See buildAssignPowerInstruction: the mint is required and the market account is always
   * appended, because a mine whose curve phase is still open cannot settle its due blocks
   * without it.
   */
  mint: Address;
  /** Optional override; must be the market PDA derived from `mint`. */
  market?: Address;
}): IInstruction {
  const market = params.market ?? deriveMarketPdaSync(params.programAddress, params.mint);
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.owner),
      w(params.player),
      w(params.mine),
      w(params.position),
      r(SYSTEM_PROGRAM_ADDRESS),
      w(market),
    ],
    data: Uint8Array.from(DISCRIMINATOR.removePower),
  };
}

export function buildClaimRewardsInstruction(params: {
  programAddress: Address;
  owner: Address;
  mine: Address;
  mint: Address;
  reserveVault: Address;
  ownerTokens: Address;
  position: Address;
  /** Optional override; the protocol PDA is derived synchronously when omitted. */
  protocol?: Address;
  /** Optional overrides; both PDAs are derived synchronously from the mint when omitted. */
  market?: Address;
  marketVault?: Address;
}): IInstruction {
  // A claim pays the curve's share out of the market vault and the rest out of the Mining
  // Reserve, so both are required by the program. They are derived from the mint here rather
  // than asked of the caller, because the mint is the one thing every claim already knows.
  const market = params.market ?? deriveMarketPdaSync(params.programAddress, params.mint);
  const marketVault = params.marketVault ?? deriveMarketVaultPdaSync(params.programAddress, params.mint);
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.owner),
      r(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
      w(params.mine),
      r(params.mint),
      w(params.reserveVault),
      w(market),
      w(marketVault),
      w(params.ownerTokens),
      w(params.position),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: Uint8Array.from(DISCRIMINATOR.claimRewards),
  };
}

/**
 * Permissionless catch-up for one mine's on-chain ledger (`advance_mine`).
 *
 * The program walks at most MAX_SYNC_SEGMENTS segments per call and refuses with SyncBehind when a
 * mine is further behind than that, which is what leaves claim_rewards and assign_power blocked for
 * a mine that sat idle. Nobody signs for this instruction beyond the fee payer, so any caller can
 * unblock any mine - which is exactly why the keeper runs it on the indexing tick instead of waiting
 * for a player to hit SyncBehind.
 *
 * Accounts, in order, exactly as `AdvanceMine` in programs/diggo-protocol declares them: the mine
 * and its market, both writable. The market is what the walk reads to decide which side of the
 * mine pays the blocks it is about to credit, so it is required here — advance_mine is the one
 * caller that always holds the mint the market PDA is derived from.
 */
export function buildAdvanceMineInstruction(params: {
  programAddress: Address;
  mine: Address;
  /** The mine's market PDA; derived from `mint` when omitted. */
  market?: Address;
  mint?: Address;
}): IInstruction {
  const market = params.market ?? (params.mint ? deriveMarketPdaSync(params.programAddress, params.mint) : undefined);
  if (!market) throw new Error("buildAdvanceMineInstruction needs the mine's market or its mint");
  return {
    programAddress: params.programAddress,
    accounts: [w(params.mine), w(market)],
    data: Uint8Array.from(DISCRIMINATOR.advanceMine),
  };
}

/** Keeper-only: pushes an off-chain, ORE-funded Crew power value on-chain. */
export function buildSyncCrewPowerInstruction(params: {
  programAddress: Address;
  keeper: Address;
  protocol: Address;
  owner: Address;
  player: Address;
  mine: Address;
  mint: Address;
  position: Address;
  newPower: bigint;
}): IInstruction {
  const market = deriveMarketPdaSync(params.programAddress, params.mint);
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.keeper),
      r(params.protocol),
      r(params.owner),
      w(params.player),
      w(params.mine),
      r(params.mint),
      w(market),
      w(params.position),
    ],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.syncCrewPower), u64(params.newPower)),
  };
}

// --- account decoding (mirrors the structs above) -------------------------------------------

export const ACCOUNT_DISCRIMINATOR = {
  protocolConfig: [207, 91, 250, 28, 152, 179, 215, 209],
  mine: [67, 107, 75, 99, 143, 125, 186, 164],
  launchMarket: [73, 227, 118, 164, 34, 99, 10, 101],
  player: [205, 222, 112, 7, 165, 155, 206, 218],
  miningPosition: [132, 97, 97, 74, 238, 187, 109, 140],
  discoveryReceipt: [168, 19, 166, 49, 77, 198, 78, 101],
  liquidityPool: [66, 38, 17, 64, 188, 80, 68, 129],
  poolSolVault: [238, 236, 17, 30, 251, 22, 52, 199],
} as const satisfies Record<string, number[]>;

function base58FromBytes(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros++;
  }
  return alphabet[0].repeat(leadingZeros) + digits.reverse().map((d) => alphabet[d]).join("");
}

/** Small sequential cursor for decoding Borsh-laid-out account data (post 8-byte discriminator). */
class ByteReader {
  private offset = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  private view() {
    return new DataView(this.data.buffer, this.data.byteOffset + this.offset);
  }
  u8(): number {
    const v = this.view().getUint8(0);
    this.offset += 1;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    const v = this.view().getUint16(0, true);
    this.offset += 2;
    return v;
  }
  i64(): bigint {
    const v = this.view().getBigInt64(0, true);
    this.offset += 8;
    return v;
  }
  u64(): bigint {
    const v = this.view().getBigUint64(0, true);
    this.offset += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return lo + (hi << 64n);
  }
  pubkey(): Address {
    const bytes = this.data.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return address(base58FromBytes(bytes));
  }
  string(): string {
    const len = this.view().getUint32(0, true);
    this.offset += 4;
    const bytes = this.data.subarray(this.offset, this.offset + len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }
  /**
   * A trailing optional byte, for fields an upgrade appended. Accounts written before the
   * field existed simply run out of data and read back as null instead of throwing.
   */
  tryU8(): number | null {
    if (this.offset + 1 > this.data.length) return null;
    return this.u8();
  }
  /**
   * A trailing optional u64, for the fields an upgrade appended after the version byte.
   * A market written before the curve-mining ledger existed simply runs out of data, and
   * every one of those fields then reads as its safe default.
   */
  tryU64(): bigint | null {
    if (this.offset + 8 > this.data.length) return null;
    return this.u64();
  }
  /**
   * A trailing optional i64, for a field an upgrade appended after the version byte. An
   * account written before the field existed simply runs out of data and reads back as null,
   * so the caller can substitute the safe default.
   */
  tryI64(): bigint | null {
    if (this.offset + 8 > this.data.length) return null;
    return this.i64();
  }
  tryBool(): boolean | null {
    const value = this.tryU8();
    return value === null ? null : value !== 0;
  }
  skipDiscriminator(): void {
    this.offset += 8;
  }
}

export type MineStatusName = "Launching" | "MiningActive" | "FullyMined";

export interface DecodedMine {
  mint: Address;
  creator: Address;
  reserveVault: Address;
  discoveryVault: Address;
  marketVault: Address;
  feeVault: Address;
  totalSupply: bigint;
  remainingReserve: bigint;
  remainingDiscoveryReserve: bigint;
  cumulativeDistributed: bigint;
  totalPower: bigint;
  rewardIndex: bigint;
  currentBlockReward: bigint;
  blockInterval: bigint;
  nextBlockAt: bigint;
  epoch: bigint;
  epochLength: bigint;
  epochEndsAt: bigint;
  reductionBps: number;
  minimumReward: bigint;
  status: MineStatusName;
  name: string;
  symbol: string;
  uri: string;
  discoveryReserveTotal: bigint;
  discoveryEpochBudget: bigint;
  discoveryEpochSpent: bigint;
  discoveryEpochEndsAt: bigint;
  discoveryPaused: boolean;
  bump: number;
  /** 0 on an account written before the version byte existed; see migrate_account. */
  version: number;
  /**
   * True while this mine's block rewards are paid out of its market's curve token
   * inventory rather than its own Mining Reserve (see shared/curve.ts). False on an
   * account written before the field existed, which is the pre-curve behaviour of a mine
   * that only emits once it has graduated.
   */
  curveMiningOpen: boolean;
  /**
   * True once this mine's market has graduated into its locked pool. Appended after the
   * curve-phase flag, so a version 2 account reads it as false.
   *
   * Together with curveMiningOpen this is the phase the mining ledger decides from, and it is
   * a fact about the mine rather than about an optional account: before graduation only the
   * curve's inventory may pay a block, after it only the Mining Reserve may. A caller that
   * holds the market reads the market's own flag instead - the two are written together from
   * one read - and a caller that does not reads this one.
   */
  graduated: boolean;
  /**
   * The instant this mine's curve phase ended: the graduation timestamp, written by
   * graduate_market at the same moment it flips `graduated`, and 0n for a mine that has not
   * graduated (or for an account written before the field existed).
   *
   * Every block that landed before it is curve-phase for good, so it is the second half of the
   * phase decision: the program reads it alongside `graduated` rather than trusting the flag
   * alone, which is what keeps an un-walked stretch from being paid out of the Mining Reserve.
   */
  curvePhaseEndsAt: bigint;
}

export function decodeMine(data: Uint8Array): DecodedMine {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  const mint = r.pubkey();
  const creator = r.pubkey();
  const reserveVault = r.pubkey();
  const discoveryVault = r.pubkey();
  const marketVault = r.pubkey();
  const feeVault = r.pubkey();
  const totalSupply = r.u64();
  const remainingReserve = r.u64();
  const remainingDiscoveryReserve = r.u64();
  const cumulativeDistributed = r.u64();
  const totalPower = r.u64();
  const rewardIndex = r.u128();
  const currentBlockReward = r.u64();
  const blockInterval = r.i64();
  const nextBlockAt = r.i64();
  const epoch = r.u64();
  const epochLength = r.i64();
  const epochEndsAt = r.i64();
  const reductionBps = r.u16();
  const minimumReward = r.u64();
  const statusTag = r.u8();
  const status: MineStatusName = statusTag === 0 ? "Launching" : statusTag === 1 ? "MiningActive" : "FullyMined";
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const discoveryReserveTotal = r.u64();
  const discoveryEpochBudget = r.u64();
  const discoveryEpochSpent = r.u64();
  const discoveryEpochEndsAt = r.i64();
  const discoveryPaused = r.bool();
  const bump = r.u8();
  const version = r.tryU8() ?? 0;
  const curveMiningOpen = r.tryBool() ?? false;
  const graduated = r.tryBool() ?? false;
  const curvePhaseEndsAt = r.tryI64() ?? 0n;
  return {
    mint, creator, reserveVault, discoveryVault, marketVault, feeVault, totalSupply, remainingReserve,
    remainingDiscoveryReserve, cumulativeDistributed, totalPower, rewardIndex, currentBlockReward,
    blockInterval, nextBlockAt, epoch, epochLength, epochEndsAt, reductionBps, minimumReward, status,
    name, symbol, uri, discoveryReserveTotal, discoveryEpochBudget, discoveryEpochSpent,
    discoveryEpochEndsAt, discoveryPaused, bump, version, curveMiningOpen, graduated, curvePhaseEndsAt,
  };
}

export interface DecodedLaunchMarket {
  mine: Address;
  tokenReserve: bigint;
  solReserve: bigint;
  virtualSolReserve: bigint;
  graduationTarget: bigint;
  graduated: boolean;
  creatorFeeClaimable: bigint;
  platformFeeClaimable: bigint;
  creatorFeeBps: number;
  platformFeeBps: number;
  bump: number;
  /** 0 on an account written before the version byte existed; see migrate_account. */
  version: number;
  /**
   * The curve-mining ledger, appended after the version byte. A market written before it
   * existed reads as cap 0 / mined 0, i.e. no pre-graduation emission at all, because a
   * migration can never hand a legacy market an allowance it was not launched with.
   *
   * curveMiningCap is immutable after launch; curveMiningMined may never pass it;
   * curveMiningUnpaid is the part of it that the reward index has credited to positions
   * but no claimer has taken yet, and it is what graduation deliberately leaves in the
   * market vault.
   */
  curveMiningCap: bigint;
  curveMiningMined: bigint;
  curveMiningUnpaid: bigint;
  curveMiningBlockReward: bigint;
}

export function decodeLaunchMarket(data: Uint8Array): DecodedLaunchMarket {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    mine: r.pubkey(),
    tokenReserve: r.u64(),
    solReserve: r.u64(),
    virtualSolReserve: r.u64(),
    graduationTarget: r.u64(),
    graduated: r.bool(),
    creatorFeeClaimable: r.u64(),
    platformFeeClaimable: r.u64(),
    creatorFeeBps: r.u16(),
    platformFeeBps: r.u16(),
    bump: r.u8(),
    version: r.tryU8() ?? 0,
    curveMiningCap: r.tryU64() ?? 0n,
    curveMiningMined: r.tryU64() ?? 0n,
    curveMiningUnpaid: r.tryU64() ?? 0n,
    curveMiningBlockReward: r.tryU64() ?? 0n,
  };
}

export interface DecodedProtocolConfig {
  treasury: Address;
  keeper: Address;
  /** Circuit-breaker authority: may only flip the scoped pause flags and tune the
   * bounded parameters below, never move reserve tokens or LP SOL. */
  guardian: Address;
  reserveBps: number;
  discoveryReserveBps: number;
  creatorFeeBps: number;
  platformFeeBps: number;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
  maxCrewPower: bigint;
  maxPowerIncreaseBps: number;
  discoveryPayoutsPaused: boolean;
  rewardClaimsPaused: boolean;
  bump: number;
  /** 0 on an account written before the version byte existed; see migrate_account. */
  version: number;
}

export function decodeProtocolConfig(data: Uint8Array): DecodedProtocolConfig {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    treasury: r.pubkey(),
    keeper: r.pubkey(),
    guardian: r.pubkey(),
    reserveBps: r.u16(),
    discoveryReserveBps: r.u16(),
    creatorFeeBps: r.u16(),
    platformFeeBps: r.u16(),
    discoveryMaxBps: r.u16(),
    discoveryEpochBudgetBps: r.u16(),
    maxCrewPower: r.u64(),
    maxPowerIncreaseBps: r.u16(),
    discoveryPayoutsPaused: r.bool(),
    rewardClaimsPaused: r.bool(),
    bump: r.u8(),
    version: r.tryU8() ?? 0,
  };
}

export interface DecodedPlayer {
  owner: Address;
  power: bigint;
  activeMine: Address;
  bump: number;
}

export function decodePlayer(data: Uint8Array): DecodedPlayer {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return { owner: r.pubkey(), power: r.u64(), activeMine: r.pubkey(), bump: r.u8() };
}

export interface DecodedMiningPosition {
  owner: Address;
  mine: Address;
  assignedPower: bigint;
  lastRewardIndex: bigint;
  pendingReward: bigint;
  bump: number;
}

export function decodeMiningPosition(data: Uint8Array): DecodedMiningPosition {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    owner: r.pubkey(),
    mine: r.pubkey(),
    assignedPower: r.u64(),
    lastRewardIndex: r.u128(),
    pendingReward: r.u64(),
    bump: r.u8(),
  };
}

export interface DecodedDiscoveryReceipt {
  mine: Address;
  discoveryId: bigint;
  recipient: Address;
  amount: bigint;
  claimedAt: bigint;
  bump: number;
}

/** One receipt per (mine, discovery_id); its existence is the on-chain replay guard. */
export function decodeDiscoveryReceipt(data: Uint8Array): DecodedDiscoveryReceipt {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    mine: r.pubkey(),
    discoveryId: r.u64(),
    recipient: r.pubkey(),
    amount: r.u64(),
    claimedAt: r.i64(),
    bump: r.u8(),
  };
}

export interface DecodedLiquidityPool {
  mine: Address;
  mint: Address;
  tokenVault: Address;
  solVault: Address;
  tokenReserve: bigint;
  solReserve: bigint;
  graduatedAt: bigint;
  bump: number;
}

/**
 * A graduated market's locked liquidity. There is no LP mint and no LP token: the pool's
 * token vault is owned by the pool PDA and its SOL sits in a PDA vault, so no creator,
 * admin, guardian or keeper instruction can withdraw from it (spec 35, 36).
 */
export function decodeLiquidityPool(data: Uint8Array): DecodedLiquidityPool {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    mine: r.pubkey(),
    mint: r.pubkey(),
    tokenVault: r.pubkey(),
    solVault: r.pubkey(),
    tokenReserve: r.u64(),
    solReserve: r.u64(),
    graduatedAt: r.i64(),
    bump: r.u8(),
  };
}

export interface DecodedPoolSolVault {
  pool: Address;
  bump: number;
}

export function decodePoolSolVault(data: Uint8Array): DecodedPoolSolVault {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return { pool: r.pubkey(), bump: r.u8() };
}

/**
 * Constant-product spot price of the bonding curve, in lamports per whole token unit
 * (i.e. already adjusted for `decimals`). Matches the on-chain quote_buy/quote_sell curve.
 */
export function bondingCurveSpotPriceLamports(market: DecodedLaunchMarket, decimals: number): number {
  const effectiveSol = Number(market.solReserve + market.virtualSolReserve);
  const tokenReserveWhole = Number(market.tokenReserve) / 10 ** decimals;
  if (tokenReserveWhole <= 0) return 0;
  return effectiveSol / tokenReserveWhole;
}

/** Mirrors the Rust program's quote_buy exactly (integer division, same operand order). */
export function quoteBuy(market: DecodedLaunchMarket, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  const denominator = market.solReserve + market.virtualSolReserve + solIn;
  if (denominator <= 0n) return 0n;
  return (market.tokenReserve * solIn) / denominator;
}

/** Mirrors the Rust program's quote_sell exactly, including the real-SOL-reserve cap. */
export function quoteSell(market: DecodedLaunchMarket, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const effectiveSol = market.solReserve + market.virtualSolReserve;
  const denominator = market.tokenReserve + tokensIn;
  if (denominator <= 0n) return 0n;
  const raw = (effectiveSol * tokensIn) / denominator;
  return raw < market.solReserve ? raw : market.solReserve;
}

// --- post-graduation pool math (mirrors lib.rs) -----------------------------------------

/** Mirrors the Rust pool_invariant: k = sol_reserve * token_reserve. */
export function poolInvariant(pool: { solReserve: bigint; tokenReserve: bigint }): bigint {
  return pool.solReserve * pool.tokenReserve;
}

/**
 * Mirrors the Rust pool_quote_buy exactly (integer division, same operand order). The
 * input is the net amount after the explicit fees, exactly as the program computes it.
 */
export function poolQuoteBuy(
  pool: { solReserve: bigint; tokenReserve: bigint },
  netSolIn: bigint,
): bigint {
  if (netSolIn <= 0n || pool.solReserve <= 0n || pool.tokenReserve <= 0n) return 0n;
  return (pool.tokenReserve * netSolIn) / (pool.solReserve + netSolIn);
}

/** Mirrors the Rust pool_quote_sell exactly, including the SOL-reserve cap. */
export function poolQuoteSell(
  pool: { solReserve: bigint; tokenReserve: bigint },
  tokensIn: bigint,
): bigint {
  if (tokensIn <= 0n || pool.solReserve <= 0n || pool.tokenReserve <= 0n) return 0n;
  const raw = (pool.solReserve * tokensIn) / (pool.tokenReserve + tokensIn);
  return raw < pool.solReserve ? raw : pool.solReserve;
}

/**
 * Mirrors the program's net_after_fees: the explicit creator and platform fees come off
 * the top of the gross amount, and the curve or pool only ever sees the net. Both fees
 * are capped at MAX_TRADING_FEE_BPS on-chain, so this can never consume the whole trade.
 */
export function netAfterFees(
  amount: bigint,
  creatorFeeBps: number,
  platformFeeBps: number,
): { net: bigint; creatorFee: bigint; platformFee: bigint } {
  const creatorFee = (amount * BigInt(creatorFeeBps)) / 10_000n;
  const platformFee = (amount * BigInt(platformFeeBps)) / 10_000n;
  return { net: amount - creatorFee - platformFee, creatorFee, platformFee };
}

/** Spot price of the graduated pool, in lamports per whole token unit. */
export function poolSpotPriceLamports(pool: DecodedLiquidityPool, decimals: number): number {
  const tokenReserveWhole = Number(pool.tokenReserve) / 10 ** decimals;
  if (tokenReserveWhole <= 0) return 0;
  return Number(pool.solReserve) / tokenReserveWhole;
}

/** Keeper-only: pays a server-approved Discovery out of the token's own Discovery Reserve. */
export function buildClaimDiscoveryInstruction(params: {
  programAddress: Address;
  keeper: Address;
  protocol: Address;
  mine: Address;
  mint: Address;
  discoveryVault: Address;
  recipient: Address;
  recipientTokens: Address;
  /** Unique id of the off-chain discovery record; replaying one fails on-chain. */
  discoveryId: bigint;
  /** PDA from deriveDiscoveryReceiptPda(programAddress, mine, discoveryId). */
  receipt: Address;
  amount: bigint;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      // The keeper pays for the receipt and the recipient's associated token account, so the
      // program declares it mutable. It was previously built as a read-only signer here, which
      // the program rejects with AccountNotMutable, so no discovery payout could succeed.
      ws(params.keeper),
      r(params.protocol),
      w(params.mine),
      r(params.mint),
      w(params.discoveryVault),
      r(params.recipient),
      w(params.recipientTokens),
      w(params.receipt),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.claimDiscovery),
      u64(params.discoveryId),
      u64(params.amount),
    ),
  };
}

// --- guardian / circuit-breaker / fee instructions (spec 19, 23, 35, 37, 65) --------

/**
 * Guardian-only. Pause instructions carry no mint, token account or vault: they can only
 * flip a flag, never move a reserve token.
 */
export function buildPauseDiscoveryPayoutsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  paused: boolean;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.pauseDiscoveryPayouts), bool(params.paused)),
  };
}

export function buildPauseRewardClaimsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  paused: boolean;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.pauseRewardClaims), bool(params.paused)),
  };
}

export function buildPauseMineDiscoveryInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  mine: Address;
  mint: Address;
  paused: boolean;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), r(params.protocol), w(params.mine), r(params.mint)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.pauseMineDiscovery), bool(params.paused)),
  };
}

export function buildRotateGuardianInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  newGuardian: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.rotateGuardian),
      pubkeyBytes(params.newGuardian),
    ),
  };
}

export function buildUpdatePowerBoundsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  maxCrewPower: bigint;
  maxPowerIncreaseBps: number;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.updatePowerBounds),
      u64(params.maxCrewPower),
      u16(params.maxPowerIncreaseBps),
    ),
  };
}

export function buildUpdateFeeConfigInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  creatorFeeBps: number;
  platformFeeBps: number;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.updateFeeConfig),
      u16(params.creatorFeeBps),
      u16(params.platformFeeBps),
    ),
  };
}

export function buildUpdateDiscoveryLimitsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.updateDiscoveryLimits),
      u16(params.discoveryMaxBps),
      u16(params.discoveryEpochBudgetBps),
    ),
  };
}

/** Creator-only: pays out the creator's accrued trading fee, never LP SOL or reserves. */
export function buildClaimCreatorFeesInstruction(params: {
  programAddress: Address;
  creator: Address;
  mint: Address;
  mine: Address;
  market: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [ws(params.creator), r(params.mint), r(params.mine), w(params.market)],
    data: Uint8Array.from(DISCRIMINATOR.claimCreatorFees),
  };
}

/** Treasury-only: pays out the platform trading fee accrued on one market. */
export function buildClaimPlatformFeesInstruction(params: {
  programAddress: Address;
  treasury: Address;
  protocol: Address;
  mint: Address;
  mine: Address;
  market: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.treasury),
      r(params.protocol),
      r(params.mint),
      r(params.mine),
      w(params.market),
    ],
    data: Uint8Array.from(DISCRIMINATOR.claimPlatformFees),
  };
}

// --- graduation, the locked pool, and account migration (spec 35, 36) ---------------

/**
 * Permissionless graduation (spec 36): moves the market's entire curve liquidity into a
 * freshly created program-owned constant-product pool. The caller only pays the pool's
 * rent. Once this lands, the market's own curve reserves are zero and buy/sell are closed
 * — trade through poolBuy/poolSell instead.
 */
export function buildGraduateMarketInstruction(params: {
  programAddress: Address;
  payer: Address;
  mint: Address;
  mine: Address;
  market: Address;
  marketVault: Address;
  pool: Address;
  poolTokenVault: Address;
  poolSolVault: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.payer),
      w(params.mine),
      w(params.market),
      r(params.mint),
      w(params.marketVault),
      w(params.pool),
      w(params.poolTokenVault),
      w(params.poolSolVault),
      r(TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: Uint8Array.from(DISCRIMINATOR.graduateMarket),
  };
}

/** Post-graduation buy against the locked pool. minTokensOut is enforced on-chain. */
export function buildPoolBuyInstruction(params: {
  programAddress: Address;
  buyer: Address;
  buyerTokens: Address;
  mine: Address;
  market: Address;
  mint: Address;
  pool: Address;
  tokenVault: Address;
  solVault: Address;
  solIn: bigint;
  minTokensOut: bigint;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.buyer),
      r(params.mine),
      w(params.market),
      r(params.mint),
      w(params.pool),
      w(params.tokenVault),
      w(params.solVault),
      w(params.buyerTokens),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.poolBuy),
      u64(params.solIn),
      u64(params.minTokensOut),
    ),
  };
}

/** Post-graduation sell against the locked pool. minSolOut is enforced on-chain. */
export function buildPoolSellInstruction(params: {
  programAddress: Address;
  seller: Address;
  sellerTokens: Address;
  mine: Address;
  market: Address;
  mint: Address;
  pool: Address;
  tokenVault: Address;
  solVault: Address;
  tokensIn: bigint;
  minSolOut: bigint;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.seller),
      r(params.mine),
      w(params.market),
      r(params.mint),
      w(params.pool),
      w(params.tokenVault),
      w(params.solVault),
      w(params.sellerTokens),
      r(TOKEN_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.poolSell),
      u64(params.tokensIn),
      u64(params.minSolOut),
    ),
  };
}

/**
 * Guardian-only layout upgrade for one protocol, mine or market account. It reallocates
 * the account to the current size and stamps the version byte; every byte that already
 * existed is preserved, so no balance or reserve can move. The account must already hold
 * its new rent-exempt minimum — fund it with a plain system transfer first.
 */
export function buildMigrateAccountInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  target: Address;
  kind: MigratableAccountKind;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), r(params.protocol), w(params.target)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.migrateAccount), u8(params.kind)),
  };
}

/** Current keeper hands the role to another key. The keeper can move nothing else. */
export function buildRotateKeeperInstruction(params: {
  programAddress: Address;
  keeper: Address;
  protocol: Address;
  newKeeper: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.keeper), w(params.protocol)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.rotateKeeper), pubkeyBytes(params.newKeeper)),
  };
}
