/**
 * The client for the diggo_protocol on-chain v2 program: PDA derivations, instruction builders,
 * account decoders, the error table and the Token-2022 mint helpers.
 *
 * Built directly on @solana/kit primitives, which are already a project dependency and are
 * isomorphic between the browser frontend and the Cloudflare Worker indexer - no
 * @coral-xyz/anchor, no Buffer, no code generation step. Every layout, seed list, account order
 * and discriminator below is transcribed from programs/diggo-protocol/src and its generated IDL,
 * and programs/diggo-protocol/CONTRACTS.md is the frozen contract they were transcribed from. If
 * the program changes, this file changes with it, and shared/program.test.ts is what fails when
 * it does not.
 *
 * Three properties of v2 are worth stating here because they shape the whole surface:
 *
 * 1. There is no keeper. Every instruction is signed by the player it acts for, or by anyone at
 *    all when it is permissionless (advance_mine, commit_epoch_seed, settle_discovery,
 *    expire_opportunity, graduate_market, sweep_fees, crank_tip, unpause). Nothing here takes an
 *    operator key, and no builder can express one.
 * 2. Power is never an argument. assign_power and upgrade_crew take no power value: the program
 *    derives it from the player's own crew levels, maturity and bond, so there is nothing for a
 *    caller to assert and nothing for this client to encode.
 * 3. No instruction takes a destination. Fee destinations are ProtocolConfig fields, so sweep_fees
 *    and claim_creator_fees move lamports to addresses the caller cannot choose.
 */
import {
  type Address,
  type Instruction,
  type ReadonlyUint8Array,
  AccountRole,
  address,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getU8Encoder,
  getI64Encoder,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  base58FromBytes,
  deriveCoinPdaSync,
  deriveCoinVaultPdaSync,
  deriveCrankPoolPdaSync,
  deriveCurveTablePdaSync,
  deriveGlobalBudgetPdaSync,
  deriveMintPdaSync,
  deriveOpportunityPdaSync,
  derivePlayerPdaSync,
  derivePoolPdaSync,
  derivePoolSolVaultPdaSync,
  derivePoolTokenVaultPdaSync,
  derivePositionPdaSync,
  deriveProtocolPdaSync,
  deriveSponsorEventPdaSync,
  deriveSponsorGrantPdaSync,
  deriveSponsorVaultPdaSync,
  deriveReferralCreditPdaSync,
  deriveReferralWeekPdaSync,
  deriveTreasuryPdaSync,
  findProgramAddressSync,
  seedAddress,
} from "./pdas";

type IInstruction = Instruction;
type Bytes = Uint8Array | ReadonlyUint8Array;

export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const COMPUTE_BUDGET_PROGRAM_ADDRESS = address("ComputeBudget111111111111111111111111111111");
export const SYSVAR_SLOT_HASHES_ADDRESS = address("SysvarS1otHashes111111111111111111111111111");
export const SYSVAR_CLOCK_ADDRESS = address("SysvarC1ock11111111111111111111111111111111");

// --- layout constants, mirroring programs/diggo-protocol/src/constants.rs ---------------------

/** Anchor's base for an #[error_code] enum: every variant is this plus its declaration index. */
export const ERROR_CODE_OFFSET = 6_000;

/**
 * Where the v2 error block starts. The 48 v4 variants keep 6000..6047 because the v4 data model
 * is still in the tree, so the v2 variants occupy 6048..6095 in the order design section 8.2
 * reserves them.
 */
export const V2_ERROR_CODE_OFFSET = 6_048;

/** Appended layout version stamped into every v2 account. */
export const ACCOUNT_VERSION = 5;

export const BPS = 10_000n;
export const INDEX_SCALE = 1_000_000_000_000n;
/**
 * The scale of the price the program accumulates in LiquidityPool and mirrors onto Coin: lamports
 * per base unit, times this. It is declared in math/curve.rs, which WS-B owns, and mirrored here
 * because a caller that wants a price out of cumPriceLamportsPerUnit needs the divisor. The two
 * must agree; a drift would make every client-side price wrong by a constant factor.
 */
export const PRICE_SCALE = 1_000_000_000_000n;

// The bond and starter-mode constants that used to live here (BOND_LAMPORTS, BOND_COOLDOWN_SECONDS,
// STARTER_EFFICIENCY_BPS, STARTER_TRANCHE_BPS) are gone: playing costs no deposit, so there is no
// efficiency factor and no tranche cap for a client to mirror. The bond *fields* the legacy
// PlayerAccount still carries are decoded below, and request_unbond/withdraw_bond survive so that a
// wallet that posted a bond before the change can take its lamports back.
export const EPOCH_SEED_DELAY_SLOTS = 32n;
export const EPOCH_SEED_MAX_LATENESS_SLOTS = 512n;
export const SLOT_HASHES_WINDOW = 512n;
export const CRANK_TIP_BPS = 200;
export const MAX_PAUSE_SECONDS = 259_200n;
export const MAX_RARITY_TIERS = 8;
export const CREW_COMPONENTS = 5;
export const MAX_CREW_LEVEL = 100;
export const CURVE_TABLE_POWER_LEN = 100;
export const MIN_CURVE_MINING_BLOCKS = 48n;
export const MAX_TRADING_FEE_BPS = 100;
export const DEFAULT_CREATOR_FEE_BPS = 50;
export const DEFAULT_PLATFORM_FEE_BPS = 50;
export const DEFAULT_CRANK_POOL_FEE_BPS = 0;
/** Default launch allocation to the coin's Mining Reserve, in bps of fixed supply. */
export const DEFAULT_RESERVE_BPS = 500;
/** Default launch allocation to the coin's Discovery Reserve, in bps of fixed supply. */
export const DEFAULT_DISCOVERY_RESERVE_BPS = 50;
export const DEFAULT_DISCOVERY_MAX_BPS = 100;
export const MAX_DISCOVERY_MAX_BPS = 1_000;
export const DEFAULT_DISCOVERY_EPOCH_BUDGET_BPS = 500;
export const MAX_DISCOVERY_EPOCH_BUDGET_BPS = 2_000;
export const DEFAULT_CURVE_MINING_BPS = 500;
export const MAX_CURVE_MINING_BPS = 1_000;
/** Maximum ORE granted by one referral credit. Must match constants.rs. */
export const MAX_REFERRAL_ORE_PER_CREDIT = 250n;
/** Maximum referral credits granted to one referrer in one Unix week. */
export const MAX_REFERRAL_ORE_CREDITS_PER_WEEK = 25;
export const DEFAULT_CURVE_MINING_RUNWAY_DAYS = 30;
export const MAX_CURVE_MINING_RUNWAY_DAYS = 3_650;
export const DEFAULT_DISCOVERY_DAILY_CAP_LAMPORTS = 1_000_000_000n;
export const DEFAULT_DISCOVERY_WEEKLY_CAP_LAMPORTS = 4_000_000_000n;
export const DEFAULT_DISCOVERY_GLOBAL_DAILY_CAP_LAMPORTS = 50_000_000_000n;
export const DEFAULT_DISCOVERY_EPOCH_BUDGET_LAMPORTS = 2_000_000_000n;
/**
 * The default per-wallet ceiling a sponsor event opens with. It is a form default and nothing
 * more: the program bounds a spend by the event's own limits, which a sponsor sets.
 */
export const DEFAULT_SPONSOR_PER_WALLET_LIMIT_LAMPORTS = 70_000_000n;
export const DISCOVERY_DAY_SECONDS = 86_400n;
export const DISCOVERY_WEEK_SECONDS = 604_800n;
export const OPPORTUNITY_EXPIRY_SECONDS = 1_209_600n;
export const ACTIVATION_SECONDS = 86_400n;
export const ACTIVATION_GRACE_SECONDS = 3_600n;
export const MIN_REACTIVATION_SECONDS = 86_400n;
/** Maturity ramp in days and the bps of power and ORE it unlocks: day 1, day 3, day 7, then 100%. */
export const MATURITY_RAMP: readonly (readonly [bigint, number])[] = [
  [1n, 2_000],
  [3n, 4_000],
  [7n, 7_000],
];

/** Metadata caps, which are also what bounds the mint's rent. */
export const MAX_NAME_LEN = 16;
export const MAX_SYMBOL_LEN = 8;
export const MAX_URI_LEN = 96;

// --- Token-2022 mint layout (design 1.3(c)) ----------------------------------------------------

/**
 * The base region of a Token-2022 account, mint or token alike: 165 bytes, and not the mint's own
 * 82.
 *
 * Token-2022 8.0.1 writes the account-type byte at `Account::LEN` (165) for both base states, so a
 * mint's 82 bytes of state are followed by 83 zero bytes of padding before that byte, and the
 * extension TLV data starts at 166. Sizing the account from the mint's 82 alone is what made every
 * launch fail inside MetadataPointerInstruction::Initialize with InvalidAccountData: the account
 * type is read at `BASE_ACCOUNT_LENGTH - Mint::LEN`, and a buffer that stops short of that index is
 * refused.
 */
export const MINT_BASE_SIZE = 165;
export const MINT_ACCOUNT_TYPE_SIZE = 1;
export const MINT_METADATA_POINTER_SIZE = 68;
/** The 4-byte TLV header every Token-2022 extension entry carries. */
export const MINT_TLV_HEADER_SIZE = 4;
/**
 * The TokenMetadata TLV entry at exactly the v2 metadata caps, derived from the caps rather than
 * typed in: the header, the update authority and the mint, the three length-prefixed strings and
 * the empty additional-metadata vector. 204 bytes, which is what `constants.rs` computes.
 */
export const MINT_TOKEN_METADATA_SIZE =
  MINT_TLV_HEADER_SIZE +
  32 +
  32 +
  (4 + MAX_NAME_LEN) +
  (4 + MAX_SYMBOL_LEN) +
  (4 + MAX_URI_LEN) +
  4;
/**
 * The space a Token-2022 mint is created at, before its metadata exists.
 *
 * Token-2022's InitializeMint2 requires the account's length to equal exactly what its current
 * extensions add up to, and the metadata pointer has to be initialized before the mint is, so the
 * token-metadata extension cannot be pre-allocated: the mint is created with room for the base
 * region, its account-type byte and the metadata pointer, and the token-metadata CPI reallocs it to
 * its settled size once the metadata is written. 234 is both the minimum and the exact size
 * InitializeMint2 accepts.
 */
export const MINT_INITIAL_SIZE = MINT_BASE_SIZE + MINT_ACCOUNT_TYPE_SIZE + MINT_METADATA_POINTER_SIZE;
/**
 * The hand-written Token-2022 mint launch_token creates at its settled, maximal metadata size.
 *
 * The caps are the layout, so this is also what the creator funds: a shorter metadata settles
 * smaller and the difference is reallocated away, which is why the funding is the maximum and never
 * a headroom. 438 bytes.
 */
export const MINT_V2_SIZE = MINT_INITIAL_SIZE + MINT_TOKEN_METADATA_SIZE;
/** One SPL token account, for the coin's single vault. */
export const TOKEN_ACCOUNT_SIZE = 165;

/** Token-2022 extension types this client knows by number (spl-token-2022 ExtensionType). */
export const EXTENSION_TYPE = {
  metadataPointer: 18,
  tokenMetadata: 19,
} as const;

// --- account sizes, mirroring the table in CONTRACTS.md ---------------------------------------

/**
 * Whole account space per v2 account, discriminator included. These are asserted twice on the
 * Rust side (a borsh round trip and the literal number), and the decoders below refuse data that
 * does not consume exactly this many bytes, so a layout drift cannot decode as plausible garbage.
 */
export const ACCOUNT_SIZE = {
  protocolConfig: 434,
  curveTable: 2_410,
  coin: 464,
  coinVault: 165,
  playerAccount: 216,
  miningPosition: 51,
  liquidityPool: 185,
  poolTokenVault: 165,
  discoveryOpportunity: 124,
  globalBudget: 53,
  sponsorVault: 70,
  sponsorEvent: 92,
  sponsorGrant: 42,
  referralCredit: 17,
  referralWeek: 18,
  mint: MINT_V2_SIZE,
  tokenAccount: TOKEN_ACCOUNT_SIZE,
} as const;

export type AccountName = keyof typeof ACCOUNT_SIZE;

/**
 * Rent-exempt minimums in lamports, per account.
 *
 * These are the cluster's numbers and not the documentation's. A rent-exempt minimum is
 * `(size + 128) * 6,960` lamports at 3,480 lamports per byte-year exempt at two years, and
 * `programs/diggo-protocol/tests/contract.rs` pins that formula against the bank's own
 * `minimum_balance_for_rent_exemption` because CONTRACTS.md's rent column is a few hundred
 * lamports away from it for five accounts. The chain charges the formula, so these follow it, and
 * shared/parity/parity.test.ts asserts every entry below against the vectors the program crate
 * generates.
 */
export const ACCOUNT_RENT_LAMPORTS = {
  protocolConfig: 3_911_520n,
  curveTable: 17_664_480n,
  coin: 4_120_320n,
  coinVault: 2_039_280n,
  playerAccount: 2_394_240n,
  miningPosition: 1_245_840n,
  liquidityPool: 2_178_480n,
  discoveryOpportunity: 1_753_920n,
  globalBudget: 1_259_760n,
  sponsorVault: 1_378_080n,
  sponsorEvent: 1_531_200n,
  sponsorGrant: 1_183_200n,
  referralCredit: 1_009_200n,
  referralWeek: 1_016_160n,
  mint: 3_939_360n,
} as const;

/**
 * What the creator pays to launch one coin, by default: the mint, the Coin and the single vault.
 * The creator pays all of it: sponsorship was removed, so there is no second payer.
 */
export const LAUNCH_RENT_LAMPORTS =
  ACCOUNT_RENT_LAMPORTS.mint + ACCOUNT_RENT_LAMPORTS.coin + ACCOUNT_RENT_LAMPORTS.coinVault;

// --- instruction and account discriminators ----------------------------------------------------

const utf8 = new TextEncoder();

/**
 * Anchor's discriminator: the first eight bytes of sha256 of the namespaced name. The program
 * computes the same value, so these are derived rather than transcribed, and
 * shared/program.test.ts pins them against the literal bytes in the generated IDL.
 */
function discriminatorFor(namespace: "global" | "account" | "event", name: string): Uint8Array {
  return sha256(utf8.encode(namespace + ":" + name)).slice(0, 8);
}

/** Every v2 instruction, named exactly as the program declares it. */
export const DIGGO_INSTRUCTION_NAMES = [
  "initialize_protocol",
  "update_fee_config",
  "update_discovery_limits",
  "set_rarity_table",
  "set_curve_table",
  "schedule_pause",
  "unpause",
  "launch_token",
  "buy",
  "sell",
  "pool_buy",
  "pool_sell",
  "graduate_market",
  "sweep_fees",
  "claim_creator_fees",
  "crank_tip",
  "init_sponsor_vault",
  "fund_sponsor_vault",
  "withdraw_sponsor_vault",
  "create_sponsor_event",
  "close_sponsor_event",
  "initialize_player",
  "activate",
  "collect_ore",
  "upgrade_crew",
  "assign_power",
  "remove_power",
  "switch_mine",
  "claim_rewards",
  "request_unbond",
  "withdraw_bond",
  "advance_mine",
  "commit_epoch_seed",
  "create_discovery_roll",
  "settle_discovery",
  "expire_opportunity",
  "credit_referral_ore",
] as const;

export type DiggoInstructionName = (typeof DIGGO_INSTRUCTION_NAMES)[number];

export const INSTRUCTION_DISCRIMINATORS = Object.fromEntries(
  DIGGO_INSTRUCTION_NAMES.map((name) => [name, discriminatorFor("global", name)]),
) as Record<DiggoInstructionName, Uint8Array>;

export function instructionDiscriminator(name: DiggoInstructionName): Uint8Array {
  return INSTRUCTION_DISCRIMINATORS[name];
}

/** Every v2 account struct, named exactly as the program declares it. */
export const DIGGO_ACCOUNT_NAMES = [
  "ProtocolConfig",
  "CurveTable",
  "Coin",
  "PlayerAccount",
  "MiningPosition",
  "LiquidityPool",
  "DiscoveryOpportunity",
  "GlobalBudget",
  "SponsorVault",
  "SponsorEvent",
  "SponsorGrant",
  "ReferralCredit",
  "ReferralWeek",
] as const;

export type DiggoAccountName = (typeof DIGGO_ACCOUNT_NAMES)[number];

export const ACCOUNT_DISCRIMINATORS = Object.fromEntries(
  DIGGO_ACCOUNT_NAMES.map((name) => [name, discriminatorFor("account", name)]),
) as Record<DiggoAccountName, Uint8Array>;

export function accountDiscriminator(name: DiggoAccountName): Uint8Array {
  return ACCOUNT_DISCRIMINATORS[name];
}

// --- events -------------------------------------------------------------------------------------

/**
 * Every event the program declares: the 26 v2 events listed in the order CONTRACTS.md names them,
 * then the 14 v4 leftovers the tree still carries until the integration step deletes them. All 40 can appear in a
 * transaction's logs, so all 40 are named here.
 *
 * An indexer reads them out of the log line the runtime writes for each emitted event -
 * "Program data: <base64>" - whose first eight bytes are the discriminator
 * sha256("event:<Name>")[..8]. Naming an event is what lets an indexer route a log without
 * decoding a payload it does not care about.
 */
export const DIGGO_EVENT_NAMES = [
  "ProtocolInitialized",
  "CoinLaunched",
  "EpochAdvanced",
  "EpochSeedTargetArmed",
  "EpochSeedCommitted",
  "EpochSeedRearmed",
  "PlayerInitialized",
  "Activated",
  "OreCollected",
  "ReferralOreCredited",
  "CrewUpgraded",
  "BondPosted",
  "UnbondRequested",
  "BondWithdrawn",
  "PowerAssigned",
  "PowerRemoved",
  "MineSwitched",
  "RewardsClaimed",
  "DiscoveryRollCreated",
  "DiscoverySettled",
  "DiscoveryExpired",
  "MarketGraduated",
  "FeesSwept",
  "CrankTipPaid",
  "SponsorVaultInitialized",
  "SponsorEventCreated",
  "SponsorSpend",
  "AccountMigrated",
  "CrewPowerSynced",
  "DiscoveryClaimed",
  "DiscoveryLimitsUpdated",
  "FeeConfigUpdated",
  "FeesClaimed",
  "GuardianRotated",
  "MarketGraduatedV4",
  "MineDiscoveryPauseUpdated",
  "PauseFlagsUpdated",
  "PowerBoundsUpdated",
  "RewardsClaimedV4",
  "TokenLaunched",
  "TradeExecuted",
] as const;

export type DiggoEventName = (typeof DIGGO_EVENT_NAMES)[number];

/**
 * The 14 events that belong to the v4 data model and are deleted at the integration step. A v2
 * instruction cannot emit one, so an indexer that sees one is reading a pre-v2 transaction.
 */
export const V4_LEGACY_EVENT_NAMES: readonly DiggoEventName[] = [
  "AccountMigrated",
  "CrewPowerSynced",
  "DiscoveryClaimed",
  "DiscoveryLimitsUpdated",
  "FeeConfigUpdated",
  "FeesClaimed",
  "GuardianRotated",
  "MarketGraduatedV4",
  "MineDiscoveryPauseUpdated",
  "PauseFlagsUpdated",
  "PowerBoundsUpdated",
  "RewardsClaimedV4",
  "TokenLaunched",
  "TradeExecuted",
];

export const EVENT_DISCRIMINATORS = Object.fromEntries(
  DIGGO_EVENT_NAMES.map((name) => [name, discriminatorFor("event", name)]),
) as Record<DiggoEventName, Uint8Array>;

export function eventDiscriminator(name: DiggoEventName): Uint8Array {
  return EVENT_DISCRIMINATORS[name];
}

/** The event a "Program data" payload belongs to, or null when it is not a diggo_protocol event. */
export function diggoEventNameFromData(data: Uint8Array): DiggoEventName | null {
  if (data.length < 8) return null;
  for (const name of DIGGO_EVENT_NAMES) {
    const discriminator = EVENT_DISCRIMINATORS[name];
    let matches = true;
    for (let i = 0; i < 8; i++) {
      if (data[i] !== discriminator[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return name;
  }
  return null;
}

// --- the error table ---------------------------------------------------------------------------

/**
 * Every DiggoError variant in declaration order, which is also code order: index 0 is 6000. The
 * first 48 are the v4 variants the tree still carries; the 48 v2 variants follow at 6048, in the
 * order design section 8.2 reserves them. Nothing here is hand-typed: the list was read out of the
 * generated IDL, and shared/program.test.ts pins the v2 block against it again.
 */
const ERROR_NAMES = [
  "MathOverflow", "InvalidAmount", "InvalidTreasury", "UnauthorizedInitializer",
  "InvalidProgramData", "InvalidMetadata", "InvalidDecimals", "InvalidReserveSplit",
  "InvalidReward", "InvalidSchedule", "InvalidMarket", "SlippageExceeded",
  "InsufficientLiquidity", "PowerAlreadyAssigned", "NoPowerAssigned", "NothingToClaim",
  "SyncWindowTooLarge", "InvalidKeeper", "PowerOutOfRange", "InsufficientDiscoveryReserve",
  "InvalidGuardian", "DiscoveryPayoutsPaused", "RewardClaimsPaused", "MineDiscoveryPaused",
  "DiscoveryAmountTooLarge", "DiscoveryEpochBudgetExceeded", "InsufficientReserve", "ReserveWithdrawForbidden",
  "PowerIncreaseTooLarge", "FeeTooHigh", "InvalidPowerBounds", "DiscoveryLimitsOutOfRange",
  "UnauthorizedCreator", "MarketGraduated", "MarketNotGraduated", "MarketAlreadyGraduated",
  "GraduationTargetNotMet", "InvalidPool", "PoolWithdrawForbidden", "PoolInvariantViolated",
  "AccountAlreadyCurrent", "InvalidAccountLayout", "MigrationNeedsFunding", "UnsupportedAccountKind",
  "SyncBehind", "CurveMiningCapExceeded", "CurveWithdrawForbidden", "InvalidCurveMining",
  "NotImplemented", "InvalidPauseWindow", "NotTimelocked", "ConfigOutOfBounds",
  "InvalidRarityTable", "InvalidCurveTable", "NotActivated", "AccrualOverflow",
  "CrewAtMaxLevel", "InsufficientOre", "StorageCapacityExceeded", "ReactivationTooSoon",
  "BondAlreadyPosted", "NoBondPosted", "PositionStillActive", "BondCooldownActive",
  "SponsorBondNotWithdrawable", "VaultBelowRentExempt", "LedgerInvariantViolated", "MetadataTooLong",
  "InvalidMintLayout", "CurveExhausted", "PoolNotInitialised", "TwapUnavailable",
  "FeeSplitOverflow", "CrankTipExceedsAccrual", "NotCoinCreator", "EventNotActive",
  "EventBudgetExhausted", "PerCoinLimitExceeded", "PerWalletLimitExceeded", "EventAlreadyClosed",
  "UnspentWithdrawalOnly", "InvalidEventKind", "EpochNotRolled", "SeedTargetInFuture",
  "SeedTargetNotInSysvar", "SeedAlreadyCommitted", "SeedNotCommitted", "CoinNotAdvanced",
  "RollAlreadyExists", "NotDiscoveryEligible", "OpportunityExpired", "OpportunityAlreadySettled",
  "DailyCapExceeded", "WeeklyCapExceeded", "GlobalCapExceeded", "EpochBudgetExhausted",
  "UnclaimedRewards",
] as const;

export type DiggoErrorName = (typeof ERROR_NAMES)[number];

/** Code for every variant, keyed by name. */
export const DIGGO_ERROR_NAMES = Object.fromEntries(
  ERROR_NAMES.map((name, index) => [name, ERROR_CODE_OFFSET + index]),
) as Record<DiggoErrorName, number>;

/** Name for every variant, keyed by code, for turning an InstructionError into something legible. */
export const DIGGO_ERROR_CODES = Object.fromEntries(
  ERROR_NAMES.map((name, index) => [ERROR_CODE_OFFSET + index, name]),
) as Record<number, DiggoErrorName>;

/** The variant name for a code, or null when the code is not a DiggoError. */
export function diggoErrorName(code: number): DiggoErrorName | null {
  return DIGGO_ERROR_CODES[code] ?? null;
}

/** The code for a variant name, or null when there is no such variant. */
export function diggoErrorCode(name: string): number | null {
  return (DIGGO_ERROR_NAMES as Record<string, number>)[name] ?? null;
}

/** True for the 48 v2 variants, false for the v4 leftovers that share the enum. */
export function isDiggoV2ErrorCode(code: number): boolean {
  return code >= V2_ERROR_CODE_OFFSET && code < V2_ERROR_CODE_OFFSET + 48;
}

/** A one-line description of a program error code, for logs and for the UI. */
export function describeDiggoError(code: number): string {
  const name = diggoErrorName(code);
  if (!name) return "unknown program error " + code;
  return "DiggoError::" + name + " (" + code + ")" + (isDiggoV2ErrorCode(code) ? "" : ", a v4 variant");
}

/**
 * The codes a caller retries on rather than reporting as a failure. Each one means the same thing:
 * the chain is not at the point this call needs yet, and the answer is a permissionless crank call
 * followed by a retry, never a different transaction. Naming them is what lets a caller react to
 * the program's own answer instead of guessing from its own model of the ledger.
 */
export const COIN_NOT_ADVANCED_ERROR_CODE = DIGGO_ERROR_NAMES.CoinNotAdvanced;
export const SEED_TARGET_IN_FUTURE_ERROR_CODE = DIGGO_ERROR_NAMES.SeedTargetInFuture;
export const SEED_TARGET_NOT_IN_SYSVAR_ERROR_CODE = DIGGO_ERROR_NAMES.SeedTargetNotInSysvar;
export const SEED_NOT_COMMITTED_ERROR_CODE = DIGGO_ERROR_NAMES.SeedNotCommitted;

// --- byte-level (Borsh-compatible) encoding helpers --------------------------------------------

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
const u32 = (n: number) => getU32Encoder().encode(n);
const u64 = (n: bigint) => getU64Encoder().encode(n);
const i64 = (n: bigint) => getI64Encoder().encode(n);
/** Borsh String: a u32 byte length, then the UTF-8 bytes. */
function borshString(value: string): Uint8Array {
  const body = utf8.encode(value);
  return concatBytes(u32(body.length), body);
}

/** Borsh Vec<T>: a u32 element count, then the elements. */
function borshVec<T>(items: readonly T[], encode: (item: T) => Bytes): Uint8Array {
  return concatBytes(u32(items.length), ...items.map(encode));
}

/** Small sequential cursor for decoding Borsh-laid-out account data. */
class ByteReader {
  private cursor = 0;
  private readonly data: Uint8Array;
  private readonly label: string;

  constructor(data: Uint8Array, label: string) {
    this.data = data;
    this.label = label;
  }

  get offset(): number {
    return this.cursor;
  }

  private need(bytes: number): void {
    if (this.cursor + bytes > this.data.length) {
      throw new Error(
        this.label + ": account data is " + this.data.length + " bytes, too short to read at offset " + this.cursor,
      );
    }
  }

  private view(): DataView {
    return new DataView(this.data.buffer, this.data.byteOffset + this.cursor);
  }

  u8(): number {
    this.need(1);
    const v = this.view().getUint8(0);
    this.cursor += 1;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.view().getUint16(0, true);
    this.cursor += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view().getUint32(0, true);
    this.cursor += 4;
    return v;
  }

  u64(): bigint {
    this.need(8);
    const v = this.view().getBigUint64(0, true);
    this.cursor += 8;
    return v;
  }

  i64(): bigint {
    this.need(8);
    const v = this.view().getBigInt64(0, true);
    this.cursor += 8;
    return v;
  }

  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return lo + (hi << 64n);
  }

  bytes(count: number): Uint8Array {
    this.need(count);
    const slice = this.data.subarray(this.cursor, this.cursor + count);
    this.cursor += count;
    return slice;
  }

  pubkey(): Address {
    return address(base58FromBytes(this.bytes(32)));
  }

  string(): string {
    const length = this.u32();
    return new TextDecoder().decode(this.bytes(length));
  }

  /**
   * Consumes the 8-byte discriminator, refusing an account of another type. A decoder that read
   * past a wrong discriminator would return a full, plausible struct built out of another
   * account's bytes, which is the one failure mode worth being loud about.
   */
  expectDiscriminator(expected: Uint8Array, account: DiggoAccountName): void {
    const actual = this.bytes(8);
    if (!expected.every((byte, index) => actual[index] === byte)) {
      throw new Error(
        this.label + ": expected the " + account + " discriminator, got " + base58FromBytes(actual),
      );
    }
  }

  /**
   * Asserts the reader consumed exactly the layout's frozen size. Trailing bytes of a future,
   * larger account are tolerated; a shorter account, or a decoder that drifted from the size
   * table in CONTRACTS.md, is not.
   */
  expectEnd(expectedSize: number): void {
    if (this.cursor !== expectedSize) {
      throw new Error(
        this.label + ": read " + this.cursor + " bytes but the frozen layout is " + expectedSize,
      );
    }
    if (this.data.length < expectedSize) {
      throw new Error(this.label + ": account data is " + this.data.length + " bytes, expected " + expectedSize);
    }
  }
}

/** The fields of Solana's Clock sysvar that the client needs. */
export interface DecodedClockSysvar {
  slot: bigint;
  epochStartTimestamp: bigint;
  epoch: bigint;
  leaderScheduleEpoch: bigint;
  unixTimestamp: bigint;
}

/** Decodes Solana's 40-byte Clock sysvar (slot, timestamps, and epoch fields). */
export function decodeClockSysvar(data: Uint8Array): DecodedClockSysvar {
  const reader = new ByteReader(data, "Clock sysvar");
  const decoded = {
    slot: reader.u64(),
    epochStartTimestamp: reader.i64(),
    epoch: reader.u64(),
    leaderScheduleEpoch: reader.u64(),
    unixTimestamp: reader.i64(),
  };
  reader.expectEnd(40);
  return decoded;
}

/** The discovery budget day used by the program for a chain timestamp. */
export function discoveryDayIndexAt(unixTimestamp: bigint): number {
  return unixTimestamp <= 0n ? 0 : Number(unixTimestamp / DISCOVERY_DAY_SECONDS) & 0xffff;
}

// --- instruction arguments ----------------------------------------------------------------------

/** One rarity tier, exactly as ProtocolConfig stores it. */
export interface RarityTier {
  cumulativeChanceBps: number;
  valueLamports: bigint;
  minEligibilityScore: number;
  minLiquidityLamports: bigint;
  minVolumeLamports: bigint;
}

function rarityTierBytes(tier: RarityTier): Uint8Array {
  return concatBytes(
    u16(tier.cumulativeChanceBps),
    u64(tier.valueLamports),
    u16(tier.minEligibilityScore),
    u64(tier.minLiquidityLamports),
    u64(tier.minVolumeLamports),
  );
}

/** Everything initialize_protocol seeds into ProtocolConfig, in declaration order. */
export interface ProtocolConfigArgs {
  creatorFeeBps: number;
  platformFeeBps: number;
  crankPoolFeeBps: number;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
  starterEfficiencyBps: number;
  starterTrancheBps: number;
  bondLamports: bigint;
  bondCooldownSeconds: bigint;
  epochSeedDelaySlots: bigint;
  epochSeedMaxLatenessSlots: bigint;
  minCurveMiningBlocks: bigint;
  discoveryDailyCapLamports: bigint;
  discoveryWeeklyCapLamports: bigint;
  discoveryGlobalDailyCapLamports: bigint;
  discoveryEpochBudgetLamports: bigint;
  rarityTiers: readonly RarityTier[];
  timelockSeconds: bigint;
}

function protocolConfigArgsBytes(args: ProtocolConfigArgs): Uint8Array {
  return concatBytes(
    u16(args.creatorFeeBps),
    u16(args.platformFeeBps),
    u16(args.crankPoolFeeBps),
    u16(args.discoveryMaxBps),
    u16(args.discoveryEpochBudgetBps),
    u16(args.starterEfficiencyBps),
    u16(args.starterTrancheBps),
    u64(args.bondLamports),
    i64(args.bondCooldownSeconds),
    u64(args.epochSeedDelaySlots),
    u64(args.epochSeedMaxLatenessSlots),
    u64(args.minCurveMiningBlocks),
    u64(args.discoveryDailyCapLamports),
    u64(args.discoveryWeeklyCapLamports),
    u64(args.discoveryGlobalDailyCapLamports),
    u64(args.discoveryEpochBudgetLamports),
    borshVec(args.rarityTiers, rarityTierBytes),
    i64(args.timelockSeconds),
  );
}

/** Everything launch_token takes, in declaration order. */
export interface LaunchTokenArgs {
  /** The mint nonce, which makes the mint PDA unique per creator. */
  nonce: number;
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  totalSupply: bigint;
  reserveBps: number;
  discoveryReserveBps: number;
  /** Share of the curve's initial inventory pre-graduation mining may emit. 0 switches it off. */
  curveMiningBps?: number;
  curveMiningRunwayDays?: number;
  creatorFeeBps: number;
  platformFeeBps: number;
  graduationTarget: bigint;
  blockInterval: number;
  epochLength: number;
  reductionBps: number;
  minimumReward: bigint;
}

function launchTokenArgsBytes(args: LaunchTokenArgs): Uint8Array {
  return concatBytes(
    u8(args.nonce),
    u8(args.decimals),
    borshString(args.name),
    borshString(args.symbol),
    borshString(args.uri),
    u64(args.totalSupply),
    u16(args.reserveBps),
    u16(args.discoveryReserveBps),
    u16(args.curveMiningBps ?? DEFAULT_CURVE_MINING_BPS),
    u16(args.curveMiningRunwayDays ?? DEFAULT_CURVE_MINING_RUNWAY_DAYS),
    u16(args.creatorFeeBps),
    u16(args.platformFeeBps),
    u64(args.graduationTarget),
    u32(args.blockInterval),
    u32(args.epochLength),
    u16(args.reductionBps),
    u64(args.minimumReward),
  );
}

// --- account meta helpers -----------------------------------------------------------------------

const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE }) as const;
const r = (a: Address) => ({ address: a, role: AccountRole.READONLY }) as const;
const ws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER }) as const;
const rs = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER }) as const;

/**
 * An omitted optional account. Anchor substitutes the program's own address for a missing
 * Option<Account> in the middle of an account list, and the program's handlers check for exactly
 * that placeholder, so a builder that dropped the slot instead would shift every account after it.
 */
const optionalAccount = (a: Address | null | undefined, programAddress: Address) => a ?? programAddress;

// --- protocol, config and governance builders ----------------------------------------------------

export interface InitializeProtocolParams {
  programAddress: Address;
  authority: Address;
  config: ProtocolConfigArgs;
  protocol?: Address;
  treasury?: Address;
  crankPool?: Address;
}

/**
 * Creates the one ProtocolConfig account plus the two fixed destination PDAs. Signed by the
 * upgrade authority, which is the only signer any admin instruction accepts.
 */
export function buildInitializeProtocolInstruction(params: InitializeProtocolParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.authority),
      w(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.treasury ?? deriveTreasuryPdaSync(program)),
      r(params.crankPool ?? deriveCrankPoolPdaSync(program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      instructionDiscriminator("initialize_protocol"),
      protocolConfigArgsBytes(params.config),
    ),
  };
}

export interface UpdateFeeConfigParams {
  programAddress: Address;
  authority: Address;
  creatorFeeBps: number;
  platformFeeBps: number;
  crankPoolFeeBps: number;
  protocol?: Address;
}

/** Timelocked: the three trading-fee shares, each bounded by MAX_TRADING_FEE_BPS. */
export function buildUpdateFeeConfigInstruction(params: UpdateFeeConfigParams): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.authority),
      w(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
    ],
    data: concatBytes(
      instructionDiscriminator("update_fee_config"),
      u16(params.creatorFeeBps),
      u16(params.platformFeeBps),
      u16(params.crankPoolFeeBps),
    ),
  };
}

export interface UpdateDiscoveryLimitsParams {
  programAddress: Address;
  authority: Address;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
  dailyCapLamports: bigint;
  weeklyCapLamports: bigint;
  globalDailyCapLamports: bigint;
  epochBudgetLamports: bigint;
  protocol?: Address;
}

/** Every cap is in lamports of SOL, never in USD: the dollar figures are UI copy (design 4.3). */
export function buildUpdateDiscoveryLimitsInstruction(params: UpdateDiscoveryLimitsParams): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.authority),
      w(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
    ],
    data: concatBytes(
      instructionDiscriminator("update_discovery_limits"),
      u16(params.discoveryMaxBps),
      u16(params.discoveryEpochBudgetBps),
      u64(params.dailyCapLamports),
      u64(params.weeklyCapLamports),
      u64(params.globalDailyCapLamports),
      u64(params.epochBudgetLamports),
    ),
  };
}

export interface SetRarityTableParams {
  programAddress: Address;
  authority: Address;
  tiers: readonly RarityTier[];
  protocol?: Address;
}

/** Cumulative tiers, at most MAX_RARITY_TIERS, the last live one at exactly BPS. */
export function buildSetRarityTableInstruction(params: SetRarityTableParams): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.authority),
      w(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
    ],
    data: concatBytes(instructionDiscriminator("set_rarity_table"), borshVec(params.tiers, rarityTierBytes)),
  };
}

export interface SetCurveTableParams {
  programAddress: Address;
  authority: Address;
  /** crew_power contribution of one component at level 1..=100. */
  power: readonly number[];
  /** upgrade cost in ORE of component c from level l to l + 1, indexed [c][l - 1]. */
  upgradeOreCost: readonly (readonly number[])[];
  protocol?: Address;
  curveTable?: Address;
}

/**
 * Writes the optional timelocked curve-table override. While no override exists every instruction
 * falls back to the compiled-in tables, so this is not on any launch or play path.
 */
export function buildSetCurveTableInstruction(params: SetCurveTableParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.authority),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      w(params.curveTable ?? deriveCurveTablePdaSync(program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      instructionDiscriminator("set_curve_table"),
      borshVec(params.power, u32),
      borshVec(params.upgradeOreCost, (row) => borshVec(row, u32)),
    ),
  };
}

export interface SchedulePauseParams {
  programAddress: Address;
  authority: Address;
  /** The bitfield flag to set. */
  flag: number;
  pausedUntil: bigint;
  protocol?: Address;
}

/**
 * Sets one narrow, self-expiring pause flag. No pause may block a bond withdrawal or a reward
 * claim, and anything past MAX_PAUSE_SECONDS needs the timelocked governance path.
 */
export function buildSchedulePauseInstruction(params: SchedulePauseParams): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.authority),
      w(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
    ],
    data: concatBytes(instructionDiscriminator("schedule_pause"), u8(params.flag), i64(params.pausedUntil)),
  };
}

export interface UnpauseParams {
  programAddress: Address;
  authority: Address;
  flag: number;
  protocol?: Address;
}

/** Permissionless once the flag has expired: the authority signature is still what is checked. */
export function buildUnpauseInstruction(params: UnpauseParams): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.authority),
      w(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
    ],
    data: concatBytes(instructionDiscriminator("unpause"), u8(params.flag)),
  };
}

// --- launch and trading builders -------------------------------------------------------------------

export interface LaunchTokenParams {
  programAddress: Address;
  /** Pays the rent, unless a LaunchRentSubsidy event reimburses it in the same instruction. */
  creator: Address;
  args: LaunchTokenArgs;
  /** Derived from (creator, args.nonce) when omitted. */
  mint?: Address;
  coin?: Address;
  vault?: Address;
  protocol?: Address;
  /** The three sponsor accounts, present only on a LaunchRentSubsidy path. */
  sponsorVault?: Address | null;
  sponsorEvent?: Address | null;
  sponsorGrant?: Address | null;
  tokenProgram?: Address;
}

/**
 * Launches one coin: three accounts, the mint, the Coin and the single vault.
 *
 * The mint is created by the handler at MINT_INITIAL_SIZE and funded for MINT_V2_SIZE rather than by
 * Anchor's init, because a Token-2022 mint carrying the metadata pointer and the token-metadata
 * extension has to be created at a size its own extensions account for, and the token-metadata CPI
 * reallocs it up to its settled size. The builder takes the mint as a parameter anyway so a caller
 * can precompute it for the rent quote it shows the creator.
 */
export function buildLaunchTokenInstruction(params: LaunchTokenParams): IInstruction {
  const program = params.programAddress;
  const mint = params.mint ?? deriveMintPdaSync(program, params.creator, params.args.nonce);
  const coin = params.coin ?? deriveCoinPdaSync(program, mint);
  return {
    programAddress: program,
    accounts: [
      ws(params.creator),
      w(mint),
      w(coin),
      w(params.vault ?? deriveCoinVaultPdaSync(program, mint)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      w(optionalAccount(params.sponsorVault, program)),
      r(optionalAccount(params.sponsorEvent, program)),
      w(optionalAccount(params.sponsorGrant, program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("launch_token"), launchTokenArgsBytes(params.args)),
  };
}

export interface BuyParams {
  programAddress: Address;
  buyer: Address;
  mint: Address;
  buyerTokens: Address;
  solIn: bigint;
  minTokensOut: bigint;
  coin?: Address;
  vault?: Address;
  protocol?: Address;
  tokenProgram?: Address;
}

/** A curve buy. The program refuses it once the coin has graduated; pool_buy is the venue then. */
export function buildBuyInstruction(params: BuyParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.buyer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      w(params.vault ?? deriveCoinVaultPdaSync(program, params.mint)),
      w(params.buyerTokens),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("buy"), u64(params.solIn), u64(params.minTokensOut)),
  };
}

export interface SellParams {
  programAddress: Address;
  seller: Address;
  mint: Address;
  sellerTokens: Address;
  tokensIn: bigint;
  minSolOut: bigint;
  coin?: Address;
  vault?: Address;
  protocol?: Address;
  tokenProgram?: Address;
}

export function buildSellInstruction(params: SellParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.seller),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      w(params.vault ?? deriveCoinVaultPdaSync(program, params.mint)),
      w(params.sellerTokens),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("sell"), u64(params.tokensIn), u64(params.minSolOut)),
  };
}

export interface PoolBuyParams {
  programAddress: Address;
  buyer: Address;
  mint: Address;
  buyerTokens: Address;
  solIn: bigint;
  minTokensOut: bigint;
  coin?: Address;
  pool?: Address;
  poolTokenVault?: Address;
  poolSolVault?: Address;
  protocol?: Address;
  tokenProgram?: Address;
}

/** A swap against the locked pool. Every pool account is derivable from the mint alone. */
export function buildPoolBuyInstruction(params: PoolBuyParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.buyer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      w(params.pool ?? derivePoolPdaSync(program, params.mint)),
      w(params.poolTokenVault ?? derivePoolTokenVaultPdaSync(program, params.mint)),
      w(params.poolSolVault ?? derivePoolSolVaultPdaSync(program, params.mint)),
      w(params.buyerTokens),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("pool_buy"), u64(params.solIn), u64(params.minTokensOut)),
  };
}

export interface PoolSellParams {
  programAddress: Address;
  seller: Address;
  mint: Address;
  sellerTokens: Address;
  tokensIn: bigint;
  minSolOut: bigint;
  coin?: Address;
  pool?: Address;
  poolTokenVault?: Address;
  poolSolVault?: Address;
  protocol?: Address;
  tokenProgram?: Address;
}

export function buildPoolSellInstruction(params: PoolSellParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.seller),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      w(params.pool ?? derivePoolPdaSync(program, params.mint)),
      w(params.poolTokenVault ?? derivePoolTokenVaultPdaSync(program, params.mint)),
      w(params.poolSolVault ?? derivePoolSolVaultPdaSync(program, params.mint)),
      w(params.sellerTokens),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("pool_sell"), u64(params.tokensIn), u64(params.minSolOut)),
  };
}

export interface GraduateMarketParams {
  programAddress: Address;
  /** Permissionless: whoever calls it pays for the pool accounts. */
  payer: Address;
  mint: Address;
  coin?: Address;
  vault?: Address;
  pool?: Address;
  poolTokenVault?: Address;
  poolSolVault?: Address;
  protocol?: Address;
  tokenProgram?: Address;
}

/** Moves a coin that reached its target into its permanently locked pool. */
export function buildGraduateMarketInstruction(params: GraduateMarketParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      w(params.vault ?? deriveCoinVaultPdaSync(program, params.mint)),
      w(params.pool ?? derivePoolPdaSync(program, params.mint)),
      w(params.poolTokenVault ?? derivePoolTokenVaultPdaSync(program, params.mint)),
      w(params.poolSolVault ?? derivePoolSolVaultPdaSync(program, params.mint)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("graduate_market")),
  };
}

// --- fee builders ---------------------------------------------------------------------------------

export interface SweepFeesParams {
  programAddress: Address;
  payer: Address;
  mint: Address;
  /** The coin's creator, which the program checks against Coin.creator. */
  creator: Address;
  coin?: Address;
  protocol?: Address;
  treasury?: Address;
  crankPool?: Address;
}

/**
 * Permissionless sweep of a coin's accrued fees to the fixed destinations held in ProtocolConfig.
 * No instruction takes a destination argument, so a caller cannot redirect a lamport of it.
 */
export function buildSweepFeesInstruction(params: SweepFeesParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      w(params.treasury ?? deriveTreasuryPdaSync(program)),
      w(params.crankPool ?? deriveCrankPoolPdaSync(program)),
      w(params.creator),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("sweep_fees")),
  };
}

export interface ClaimCreatorFeesParams {
  programAddress: Address;
  creator: Address;
  mint: Address;
  coin?: Address;
}

/** The creator claims their own accrued trading fees. has_one = creator, so nobody else can. */
export function buildClaimCreatorFeesInstruction(params: ClaimCreatorFeesParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.creator),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("claim_creator_fees")),
  };
}

export interface CrankTipParams {
  programAddress: Address;
  payer: Address;
  mint: Address;
  maxTip: bigint;
  coin?: Address;
  protocol?: Address;
}

/**
 * Pays the caller at most min(maxTip, CRANK_TIP_BPS of the coin's accrued fees), out of accrual
 * only: never out of a reserve and never out of the pool.
 */
export function buildCrankTipInstruction(params: CrankTipParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("crank_tip"), u64(params.maxTip)),
  };
}

// --- sponsorship builders ---------------------------------------------------------------------------
//
// Sponsorship pays rent and fees and nothing else, and it is the sponsor's own lamports: the vault
// belongs to the owner's wallet, not to the protocol. One kind is gone with the bond -
// playerBondSubsidy, which posted a player's deposit - so no instruction here, and none in the
// launch or player paths, carries a bond subsidy any more.

export interface InitSponsorVaultParams {
  programAddress: Address;
  sponsorOwner: Address;
  sponsorVault?: Address;
}

/** Creates the sponsor's own lamport vault. It holds no authority over anything else. */
export function buildInitSponsorVaultInstruction(params: InitSponsorVaultParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.sponsorOwner),
      w(params.sponsorVault ?? deriveSponsorVaultPdaSync(program, params.sponsorOwner)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("init_sponsor_vault")),
  };
}

export interface FundSponsorVaultParams {
  programAddress: Address;
  sponsorOwner: Address;
  amount: bigint;
  sponsorVault?: Address;
}

export function buildFundSponsorVaultInstruction(params: FundSponsorVaultParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.sponsorOwner),
      w(params.sponsorVault ?? deriveSponsorVaultPdaSync(program, params.sponsorOwner)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("fund_sponsor_vault"), u64(params.amount)),
  };
}

export interface WithdrawSponsorVaultParams {
  programAddress: Address;
  sponsorOwner: Address;
  amount: bigint;
  sponsorVault?: Address;
}

/**
 * Withdrawal belongs to the sponsor owner alone, is capped at total_funded - total_spent, and can
 * never take the vault below its own rent-exempt minimum: unspent lamports are never the protocol's.
 */
export function buildWithdrawSponsorVaultInstruction(params: WithdrawSponsorVaultParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.sponsorOwner),
      w(params.sponsorVault ?? deriveSponsorVaultPdaSync(program, params.sponsorOwner)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("withdraw_sponsor_vault"), u64(params.amount)),
  };
}

export interface CreateSponsorEventParams {
  programAddress: Address;
  sponsorOwner: Address;
  /** The event kind: SPONSOR_EVENT_KIND.*. Adding a kind is a program upgrade. */
  kind: number;
  startAt: bigint;
  endAt: bigint;
  budgetLamports: bigint;
  perCoinLimitLamports: bigint;
  perWalletLimitLamports: bigint;
  sponsorVault?: Address;
  /** Derived from (vault, vault.event_count) when omitted; the id is the vault's event_count. */
  sponsorEvent?: Address;
  /** Required to derive the event PDA from the vault's current event count. */
  eventId?: number;
}

/** Creates one sponsorship event, keyed by the vault's event_count. */
export function buildCreateSponsorEventInstruction(params: CreateSponsorEventParams): IInstruction {
  const program = params.programAddress;
  const vault = params.sponsorVault ?? deriveSponsorVaultPdaSync(program, params.sponsorOwner);
  const event =
    params.sponsorEvent ??
    (params.eventId === undefined ? null : deriveSponsorEventPdaSync(program, vault, params.eventId));
  if (!event) {
    throw new Error("create_sponsor_event needs the vault's current event_count as eventId");
  }
  return {
    programAddress: program,
    accounts: [
      ws(params.sponsorOwner),
      w(vault),
      w(event),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      instructionDiscriminator("create_sponsor_event"),
      u8(params.kind),
      i64(params.startAt),
      i64(params.endAt),
      u64(params.budgetLamports),
      u64(params.perCoinLimitLamports),
      u64(params.perWalletLimitLamports),
    ),
  };
}

export interface CloseSponsorEventParams {
  programAddress: Address;
  sponsorOwner: Address;
  eventId: number;
  sponsorVault?: Address;
  sponsorEvent?: Address;
}

export interface CreditReferralOreParams {
  programAddress: Address;
  keeper: Address;
  referrer: Address;
  referee: Address;
  amount: bigint;
  player?: Address;
  credit?: Address;
  week?: Address;
  protocol?: Address;
}

/** Credits the referrer's PlayerAccount for one referee. The keeper is the configured crank key. */
export function buildCreditReferralOreInstruction(params: CreditReferralOreParams): IInstruction {
  if (params.amount <= 0n || params.amount > MAX_REFERRAL_ORE_PER_CREDIT) {
    throw new Error("credit_referral_ore amount must be between 1 and 250 ORE");
  }
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.keeper),
      w(params.player ?? derivePlayerPdaSync(program, params.referrer)),
      w(params.credit ?? deriveReferralCreditPdaSync(program, params.referrer, params.referee)),
      w(params.week ?? deriveReferralWeekPdaSync(program, params.referrer)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.referee),
      r(params.referrer),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      instructionDiscriminator("credit_referral_ore"),
      seedAddress(params.referee),
      u64(params.amount),
    ),
  };
}

export function buildCloseSponsorEventInstruction(params: CloseSponsorEventParams): IInstruction {
  const program = params.programAddress;
  const vault = params.sponsorVault ?? deriveSponsorVaultPdaSync(program, params.sponsorOwner);
  return {
    programAddress: program,
    accounts: [
      ws(params.sponsorOwner),
      r(vault),
      w(params.sponsorEvent ?? deriveSponsorEventPdaSync(program, vault, params.eventId)),
    ],
    data: concatBytes(instructionDiscriminator("close_sponsor_event"), u32(params.eventId)),
  };
}

// --- player builders ---------------------------------------------------------------------------------

export interface InitializePlayerParams {
  programAddress: Address;
  owner: Address;
  player?: Address;
  protocol?: Address;
  /** The three sponsor accounts, present only on a PlayerAccountSubsidy path. */
  sponsorVault?: Address | null;
  sponsorEvent?: Address | null;
  sponsorGrant?: Address | null;
}

/**
 * Creates the 216-byte PlayerAccount at its full size, so posting or withdrawing a bond later
 * never reallocs it. protocol is writable here because the handler books the subsidy against it.
 */
export function buildInitializePlayerInstruction(params: InitializePlayerParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      w(params.protocol ?? deriveProtocolPdaSync(program)),
      w(optionalAccount(params.sponsorVault, program)),
      r(optionalAccount(params.sponsorEvent, program)),
      w(optionalAccount(params.sponsorGrant, program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("initialize_player")),
  };
}

export interface ActivateParams {
  programAddress: Address;
  owner: Address;
  player?: Address;
  protocol?: Address;
}

/** Settles accrual, rolls the activation window and applies the streak rule. Free, always. */
export function buildActivateInstruction(params: ActivateParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
    ],
    data: concatBytes(instructionDiscriminator("activate")),
  };
}

export interface CollectOreParams {
  programAddress: Address;
  owner: Address;
  player?: Address;
  protocol?: Address;
}

/**
 * Settles lazily accrued ORE into ore_balance, clamped by storage capacity. The owner is only a
 * read-only signer: this instruction moves nothing but the player's own game state.
 */
export function buildCollectOreInstruction(params: CollectOreParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      rs(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
    ],
    data: concatBytes(instructionDiscriminator("collect_ore")),
  };
}

export interface UpgradeCrewParams {
  programAddress: Address;
  owner: Address;
  /** 0 miners, 1 drills, 2 carts, 3 foreman, 4 storage. */
  component: number;
  player?: Address;
  protocol?: Address;
  /** Present only once a curve-table override exists; the compiled-in tables are the fallback. */
  curveTable?: Address | null;
}

/** ore_balance -= cost, crew_levels[component] += 1. The cost curve is the program's own. */
export function buildUpgradeCrewInstruction(params: UpgradeCrewParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      rs(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(optionalAccount(params.curveTable, program)),
    ],
    data: concatBytes(instructionDiscriminator("upgrade_crew"), u8(params.component)),
  };
}

// --- position, claim and bond builders -----------------------------------------------------------------

export interface AssignPowerParams {
  programAddress: Address;
  owner: Address;
  mint: Address;
  player?: Address;
  coin?: Address;
  position?: Address;
  protocol?: Address;
}

/**
 * Creates the MiningPosition PDA and assigns the player's derived power to this coin. There is
 * deliberately no power argument: the program computes it, so a caller cannot assert it.
 */
export function buildAssignPowerInstruction(params: AssignPowerParams): IInstruction {
  const program = params.programAddress;
  const coin = params.coin ?? deriveCoinPdaSync(program, params.mint);
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.mint),
      w(coin),
      w(params.position ?? derivePositionPdaSync(program, coin, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("assign_power")),
  };
}

export interface RemovePowerParams {
  programAddress: Address;
  owner: Address;
  mint: Address;
  player?: Address;
  coin?: Address;
  position?: Address;
}

/** Settles the index delta and closes the position, refunding its rent. Required before unbonding. */
export function buildRemovePowerInstruction(params: RemovePowerParams): IInstruction {
  const program = params.programAddress;
  const coin = params.coin ?? deriveCoinPdaSync(program, params.mint);
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.mint),
      w(coin),
      w(params.position ?? derivePositionPdaSync(program, coin, params.owner)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("remove_power")),
  };
}

export interface SwitchMineParams {
  programAddress: Address;
  owner: Address;
  fromMint: Address;
  toMint: Address;
  player?: Address;
  fromCoin?: Address;
  toCoin?: Address;
  fromPosition?: Address;
  toPosition?: Address;
}

/** Settles the old position and re-arms on the new coin. It never touches activation or streak. */
export function buildSwitchMineInstruction(params: SwitchMineParams): IInstruction {
  const program = params.programAddress;
  const fromCoin = params.fromCoin ?? deriveCoinPdaSync(program, params.fromMint);
  const toCoin = params.toCoin ?? deriveCoinPdaSync(program, params.toMint);
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.fromMint),
      w(fromCoin),
      w(params.fromPosition ?? derivePositionPdaSync(program, fromCoin, params.owner)),
      r(params.toMint),
      w(toCoin),
      w(params.toPosition ?? derivePositionPdaSync(program, toCoin, params.owner)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("switch_mine")),
  };
}

export interface ClaimRewardsParams {
  programAddress: Address;
  owner: Address;
  mint: Address;
  ownerTokens: Address;
  player?: Address;
  coin?: Address;
  vault?: Address;
  position?: Address;
  protocol?: Address;
  tokenProgram?: Address;
}

/**
 * The only route by which a Mining Reserve block reward reaches a player: the player signs it.
 * No backend key is authorised to move the reserve (docs/SECURITY.md invariant 7).
 */
export function buildClaimRewardsInstruction(params: ClaimRewardsParams): IInstruction {
  const program = params.programAddress;
  const coin = params.coin ?? deriveCoinPdaSync(program, params.mint);
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.mint),
      w(coin),
      w(params.vault ?? deriveCoinVaultPdaSync(program, params.mint)),
      w(params.ownerTokens),
      w(params.position ?? derivePositionPdaSync(program, coin, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("claim_rewards")),
  };
}

// There is no post_bond builder: posting a bond is not a thing a wallet can do any more. Every
// wallet mines at full power with no deposit, and the two instructions below exist only so that a
// bond posted before the change can be released and withdrawn.

export interface RequestUnbondParams {
  programAddress: Address;
  owner: Address;
  player?: Address;
  protocol?: Address;
}

/** Legacy: requires no active position and starts the cooldown on a bond already posted. */
export function buildRequestUnbondInstruction(params: RequestUnbondParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      rs(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
    ],
    data: concatBytes(instructionDiscriminator("request_unbond")),
  };
}

export interface WithdrawBondParams {
  programAddress: Address;
  owner: Address;
  player?: Address;
  protocol?: Address;
  /** The vault a sponsor-funded bond returns to; it must be the one the player recorded. */
  sponsorVault?: Address | null;
}

/** After the cooldown: pays the player, or the sponsor vault when bond_source = sponsor. */
export function buildWithdrawBondInstruction(params: WithdrawBondParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      w(optionalAccount(params.sponsorVault, program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("withdraw_bond")),
  };
}

// --- the crank: ledger walk, epoch seed and discovery --------------------------------------------------

export interface AdvanceMineParams {
  programAddress: Address;
  payer: Address;
  mint: Address;
  coin?: Address;
  protocol?: Address;
}

/**
 * The permissionless ledger walk: at most MAX_SYNC_SEGMENTS segments per call, each call
 * continuing where the last one stopped. It is deterministic and takes no keeper input, so a
 * caller cannot influence which blocks it settles or at what rate.
 */
export function buildAdvanceMineInstruction(params: AdvanceMineParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
    ],
    data: concatBytes(instructionDiscriminator("advance_mine")),
  };
}

export interface CommitEpochSeedParams {
  programAddress: Address;
  payer: Address;
  mint: Address;
  coin?: Address;
  protocol?: Address;
  /** The SlotHashes sysvar account; the program takes it as a Sysvar, never unchecked. */
  slotHashes?: Address;
}

/**
 * Reveals the epoch seed: reads the SlotHashes entry at exactly coin.epoch_seed_target_slot and
 * stores it. Permissionless, one transaction per coin per epoch, and the only source of randomness
 * anywhere in the protocol.
 */
export function buildCommitEpochSeedInstruction(params: CommitEpochSeedParams): IInstruction {
  const program = params.programAddress;
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.mint),
      w(params.coin ?? deriveCoinPdaSync(program, params.mint)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.slotHashes ?? SYSVAR_SLOT_HASHES_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("commit_epoch_seed")),
  };
}

export interface CreateDiscoveryRollParams {
  programAddress: Address;
  owner: Address;
  mint: Address;
  /** The PlayerAccount's roll_window, which is the opportunity's window index. */
  windowIndex?: number;
  /** The PlayerAccount's day_index, which is the global budget's day index. */
  dayIndex?: number;
  player?: Address;
  coin?: Address;
  opportunity?: Address;
  globalBudget?: Address;
  protocol?: Address;
}

/**
 * Checks eligibility and every cap, charges the day, week and global budgets immediately, and
 * creates the opportunity PDA as pending against the current epoch. No randomness is requested
 * here: the seed does not exist yet, and charging at creation is what makes a pre-computed bad
 * outcome worthless to walk away from.
 */
export function buildCreateDiscoveryRollInstruction(params: CreateDiscoveryRollParams): IInstruction {
  const program = params.programAddress;
  const coin = params.coin ?? deriveCoinPdaSync(program, params.mint);
  const opportunity =
    params.opportunity ??
    (params.windowIndex === undefined
      ? null
      : deriveOpportunityPdaSync(program, coin, params.owner, params.windowIndex));
  const globalBudget =
    params.globalBudget ??
    (params.dayIndex === undefined ? null : deriveGlobalBudgetPdaSync(program, params.dayIndex));
  if (!opportunity || !globalBudget) {
    throw new Error("create_discovery_roll needs the opportunity and global budget addresses, or the player's window and day indexes");
  }
  return {
    programAddress: program,
    accounts: [
      ws(params.owner),
      w(params.player ?? derivePlayerPdaSync(program, params.owner)),
      r(params.mint),
      w(coin),
      w(opportunity),
      w(globalBudget),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("create_discovery_roll")),
  };
}

export interface SettleDiscoveryParams {
  programAddress: Address;
  /** Permissionless: the payer receives the closed opportunity's rent. */
  payer: Address;
  /** The opportunity's recorded owner, checked against the PDA seeds. */
  owner: Address;
  mint: Address;
  /** The owner's associated token account for this mint. */
  ownerTokens: Address;
  coin?: Address;
  vault?: Address;
  /** Required to derive the opportunity PDA from its seeds. */
  windowIndex?: number;
  opportunity?: Address;
  globalBudget?: Address | null;
  protocol?: Address;
  tokenProgram?: Address;
}

/**
 * Recomputes the same derivation settle_discovery makes and pays out of the discovery ledger,
 * closing the opportunity and refunding its rent to the caller. It requires the coin's committed
 * seed to cover the opportunity's epoch, so nothing can settle early.
 */
export function buildSettleDiscoveryInstruction(params: SettleDiscoveryParams): IInstruction {
  const program = params.programAddress;
  const coin = params.coin ?? deriveCoinPdaSync(program, params.mint);
  const opportunity =
    params.opportunity ??
    (params.windowIndex === undefined
      ? null
      : deriveOpportunityPdaSync(program, coin, params.owner, params.windowIndex));
  if (!opportunity) {
    throw new Error("settle_discovery needs the opportunity address or the window index it was rolled in");
  }
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.owner),
      r(params.mint),
      w(coin),
      w(params.vault ?? deriveCoinVaultPdaSync(program, params.mint)),
      w(params.ownerTokens),
      w(opportunity),
      w(optionalAccount(params.globalBudget, program)),
      r(params.protocol ?? deriveProtocolPdaSync(program)),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("settle_discovery")),
  };
}

export interface ExpireOpportunityParams {
  programAddress: Address;
  /** Permissionless: the payer receives the closed opportunity's rent. */
  payer: Address;
  /** The opportunity's recorded owner, checked against the PDA seeds. */
  owner: Address;
  mint: Address;
  coin?: Address;
  windowIndex?: number;
  opportunity?: Address;
}

/** A pending opportunity past its expiry: it pays nothing and refunds no budget. */
export function buildExpireOpportunityInstruction(params: ExpireOpportunityParams): IInstruction {
  const program = params.programAddress;
  const coin = params.coin ?? deriveCoinPdaSync(program, params.mint);
  const opportunity =
    params.opportunity ??
    (params.windowIndex === undefined
      ? null
      : deriveOpportunityPdaSync(program, coin, params.owner, params.windowIndex));
  if (!opportunity) {
    throw new Error("expire_opportunity needs the opportunity address or the window index it was rolled in");
  }
  return {
    programAddress: program,
    accounts: [
      ws(params.payer),
      r(params.owner),
      r(params.mint),
      w(coin),
      w(opportunity),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(instructionDiscriminator("expire_opportunity")),
  };
}

// --- account decoding ---------------------------------------------------------------------------------

/**
 * Field order is the Borsh order and is part of the contract, so every decoder below reads the
 * fields in the order the owning Rust file declares them and then asserts that it consumed exactly
 * the frozen size. A decoder that drifted would otherwise return a full, plausible struct built out
 * of misaligned bytes, which is the failure mode this whole file exists to prevent.
 */
export interface DecodedProtocolConfig {
  authority: Address;
  treasury: Address;
  crankPool: Address;
  creatorFeeBps: number;
  platformFeeBps: number;
  crankPoolFeeBps: number;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
  starterEfficiencyBps: number;
  starterTrancheBps: number;
  bondLamports: bigint;
  bondCooldownSeconds: bigint;
  epochSeedDelaySlots: bigint;
  epochSeedMaxLatenessSlots: bigint;
  minCurveMiningBlocks: bigint;
  discoveryDailyCapLamports: bigint;
  discoveryWeeklyCapLamports: bigint;
  discoveryGlobalDailyCapLamports: bigint;
  discoveryEpochBudgetLamports: bigint;
  /** All MAX_RARITY_TIERS slots; only the first rarityTierCount are live. */
  rarityTiers: RarityTier[];
  rarityTierCount: number;
  timelockSeconds: bigint;
  pausedFlags: number;
  pausedUntil: bigint;
  bump: number;
  version: number;
}

export function decodeProtocolConfig(data: Uint8Array): DecodedProtocolConfig {
  const reader = new ByteReader(data, "ProtocolConfig");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.ProtocolConfig, "ProtocolConfig");
  const authority = reader.pubkey();
  const treasury = reader.pubkey();
  const crankPool = reader.pubkey();
  const creatorFeeBps = reader.u16();
  const platformFeeBps = reader.u16();
  const crankPoolFeeBps = reader.u16();
  const discoveryMaxBps = reader.u16();
  const discoveryEpochBudgetBps = reader.u16();
  const starterEfficiencyBps = reader.u16();
  const starterTrancheBps = reader.u16();
  const bondLamports = reader.u64();
  const bondCooldownSeconds = reader.i64();
  const epochSeedDelaySlots = reader.u64();
  const epochSeedMaxLatenessSlots = reader.u64();
  const minCurveMiningBlocks = reader.u64();
  const discoveryDailyCapLamports = reader.u64();
  const discoveryWeeklyCapLamports = reader.u64();
  const discoveryGlobalDailyCapLamports = reader.u64();
  const discoveryEpochBudgetLamports = reader.u64();
  const rarityTiers: RarityTier[] = [];
  for (let i = 0; i < MAX_RARITY_TIERS; i++) {
    rarityTiers.push({
      cumulativeChanceBps: reader.u16(),
      valueLamports: reader.u64(),
      minEligibilityScore: reader.u16(),
      minLiquidityLamports: reader.u64(),
      minVolumeLamports: reader.u64(),
    });
  }
  const rarityTierCount = reader.u8();
  const timelockSeconds = reader.i64();
  const pausedFlags = reader.u8();
  const pausedUntil = reader.i64();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.protocolConfig);
  return {
    authority,
    treasury,
    crankPool,
    creatorFeeBps,
    platformFeeBps,
    crankPoolFeeBps,
    discoveryMaxBps,
    discoveryEpochBudgetBps,
    starterEfficiencyBps,
    starterTrancheBps,
    bondLamports,
    bondCooldownSeconds,
    epochSeedDelaySlots,
    epochSeedMaxLatenessSlots,
    minCurveMiningBlocks,
    discoveryDailyCapLamports,
    discoveryWeeklyCapLamports,
    discoveryGlobalDailyCapLamports,
    discoveryEpochBudgetLamports,
    rarityTiers,
    rarityTierCount,
    timelockSeconds,
    pausedFlags,
    pausedUntil,
    bump,
    version,
  };
}

/** The tiers a rarity draw may actually use: the table is fixed-size and only the first count is live. */
export function activeRarityTiers(config: DecodedProtocolConfig): RarityTier[] {
  return config.rarityTiers.slice(0, config.rarityTierCount);
}

export interface DecodedCurveTable {
  /** crew_power contribution of one component at level 1..=100. */
  power: number[];
  /** upgrade cost in ORE of component c from level l to l + 1, indexed [c][l - 1]. */
  upgradeOreCost: number[][];
  bump: number;
  version: number;
}

export function decodeCurveTable(data: Uint8Array): DecodedCurveTable {
  const reader = new ByteReader(data, "CurveTable");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.CurveTable, "CurveTable");
  const power: number[] = [];
  for (let i = 0; i < CURVE_TABLE_POWER_LEN; i++) power.push(reader.u32());
  const upgradeOreCost: number[][] = [];
  for (let component = 0; component < CREW_COMPONENTS; component++) {
    const row: number[] = [];
    for (let level = 0; level < CURVE_TABLE_POWER_LEN; level++) row.push(reader.u32());
    upgradeOreCost.push(row);
  }
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.curveTable);
  return { power, upgradeOreCost, bump, version };
}

/** Coin lifecycle, as the byte the account stores. */
export type CoinStatusName = "Launching" | "MiningActive" | "FullyMined";

export const COIN_STATUS = {
  launching: 0,
  miningActive: 1,
  fullyMined: 2,
} as const;

export function coinStatusName(status: number): CoinStatusName {
  if (status === COIN_STATUS.launching) return "Launching";
  if (status === COIN_STATUS.miningActive) return "MiningActive";
  return "FullyMined";
}

/**
 * The whole of a coin: its reward ledger, its curve, its fee accrual, its TWAP and its epoch seed.
 *
 * u128 fields are bigint because INDEX_SCALE and PRICE_SCALE make them far wider than a JS number,
 * and every lamport total is bigint for the same reason: a coin's supply and a reserve in lamports
 * both exceed 2^53 in the general case, and rounding them would be an accounting bug the client
 * would be inventing on its own.
 */
export interface DecodedCoin {
  creator: Address;
  /** The coin's single token vault, PDA under [b"vault", mint]. */
  vault: Address;
  totalSupply: bigint;
  /** Mining Reserve left to emit after graduation. */
  reserveRemaining: bigint;
  /** Discovery Reserve left to pay out. */
  discoveryRemaining: bigint;
  /** Part of the index already credited to positions but not yet claimed. */
  outstandingClaims: bigint;
  cumulativeDistributed: bigint;
  totalPower: bigint;
  /** Power accruing in the bonded index. */
  bondedPower: bigint;
  /** Power accruing in the starter index, already scaled by starter_efficiency_bps. */
  starterPower: bigint;
  /** Cumulative rewards per unit of power over the bonded tranche, scaled by INDEX_SCALE. */
  bondedIndex: bigint;
  /**
   * The same for the starter tranche, advanced by its own capped share of every block. The two are
   * independent: a starter position settles against this field and a bonded one against the field
   * above, which is what holds the starter tranche to starter_tranche_bps of a block exactly.
   */
  starterIndex: bigint;
  currentBlockReward: bigint;
  blockInterval: number;
  nextBlockAt: bigint;
  epochIndex: number;
  epochLength: number;
  epochEndsAt: bigint;
  epochEndsSlot: bigint;
  reductionBps: number;
  minimumReward: bigint;
  /** Curve inventory the pre-graduation phase may sell. */
  tokenReserve: bigint;
  solReserve: bigint;
  virtualSolReserve: bigint;
  graduationTarget: bigint;
  creatorFeeClaimable: bigint;
  platformFeeClaimable: bigint;
  creatorFeeBps: number;
  platformFeeBps: number;
  curveMiningCap: bigint;
  curveMiningMined: bigint;
  curveMiningUnpaid: bigint;
  curveMiningBlockReward: bigint;
  curveMiningOpen: boolean;
  graduated: boolean;
  /** The instant the curve phase ended, or 0n when the coin has not graduated. */
  curvePhaseEndsAt: bigint;
  discoveryReserveTotal: bigint;
  discoveryEpochBudget: bigint;
  discoveryEpochSpent: bigint;
  discoveryEpochIndex: number;
  discoveryPaused: boolean;
  /**
   * TWAP accumulator over this coin's own pool, in lamports per base unit scaled by PRICE_SCALE,
   * and the slot it was last updated at. The only price the program trusts: no external oracle is
   * consulted anywhere, so this is what a payout divisor is read from.
   */
  twapCumPriceLamportsPerUnit: bigint;
  twapLastUpdateSlot: bigint;
  /** The price that has held since twapLastUpdateSlot, mirrored from the pool on every swap. */
  twapLastPrice: bigint;
  /** The short window's anchor: the slot and the accumulator value it is measured from. */
  twapWindowSlot: bigint;
  twapWindowCum: bigint;
  /** The epoch seed and the slot it was taken from. Frozen: WS-B writes it, WS-C reads it. */
  epochSeed: Uint8Array;
  epochSeedEpoch: number;
  epochSeedTargetSlot: bigint;
  epochSeedRecordedSlot: bigint;
  status: CoinStatusName;
  /** The raw status byte, for callers that switch on it directly. */
  statusByte: number;
  bump: number;
  version: number;
}

export function decodeCoin(data: Uint8Array): DecodedCoin {
  const reader = new ByteReader(data, "Coin");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.Coin, "Coin");
  const creator = reader.pubkey();
  const vault = reader.pubkey();
  const totalSupply = reader.u64();
  const reserveRemaining = reader.u64();
  const discoveryRemaining = reader.u64();
  const outstandingClaims = reader.u64();
  const cumulativeDistributed = reader.u64();
  const totalPower = reader.u64();
  const bondedPower = reader.u64();
  const starterPower = reader.u64();
  const bondedIndex = reader.u128();
  const starterIndex = reader.u128();
  const currentBlockReward = reader.u64();
  const blockInterval = reader.u32();
  const nextBlockAt = reader.i64();
  const epochIndex = reader.u32();
  const epochLength = reader.u32();
  const epochEndsAt = reader.i64();
  const epochEndsSlot = reader.u64();
  const reductionBps = reader.u16();
  const minimumReward = reader.u64();
  const tokenReserve = reader.u64();
  const solReserve = reader.u64();
  const virtualSolReserve = reader.u64();
  const graduationTarget = reader.u64();
  const creatorFeeClaimable = reader.u64();
  const platformFeeClaimable = reader.u64();
  const creatorFeeBps = reader.u16();
  const platformFeeBps = reader.u16();
  const curveMiningCap = reader.u64();
  const curveMiningMined = reader.u64();
  const curveMiningUnpaid = reader.u64();
  const curveMiningBlockReward = reader.u64();
  const curveMiningOpen = reader.bool();
  const graduated = reader.bool();
  const curvePhaseEndsAt = reader.i64();
  const discoveryReserveTotal = reader.u64();
  const discoveryEpochBudget = reader.u64();
  const discoveryEpochSpent = reader.u64();
  const discoveryEpochIndex = reader.u32();
  const discoveryPaused = reader.bool();
  const twapCumPriceLamportsPerUnit = reader.u128();
  const twapLastUpdateSlot = reader.u64();
  const twapLastPrice = reader.u128();
  const twapWindowSlot = reader.u64();
  const twapWindowCum = reader.u128();
  const epochSeed = reader.bytes(32);
  const epochSeedEpoch = reader.u32();
  const epochSeedTargetSlot = reader.u64();
  const epochSeedRecordedSlot = reader.u64();
  const statusByte = reader.u8();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.coin);
  return {
    creator,
    vault,
    totalSupply,
    reserveRemaining,
    discoveryRemaining,
    outstandingClaims,
    cumulativeDistributed,
    totalPower,
    bondedPower,
    starterPower,
    bondedIndex,
    starterIndex,
    currentBlockReward,
    blockInterval,
    nextBlockAt,
    epochIndex,
    epochLength,
    epochEndsAt,
    epochEndsSlot,
    reductionBps,
    minimumReward,
    tokenReserve,
    solReserve,
    virtualSolReserve,
    graduationTarget,
    creatorFeeClaimable,
    platformFeeClaimable,
    creatorFeeBps,
    platformFeeBps,
    curveMiningCap,
    curveMiningMined,
    curveMiningUnpaid,
    curveMiningBlockReward,
    curveMiningOpen,
    graduated,
    curvePhaseEndsAt,
    discoveryReserveTotal,
    discoveryEpochBudget,
    discoveryEpochSpent,
    discoveryEpochIndex,
    discoveryPaused,
    twapCumPriceLamportsPerUnit,
    twapLastUpdateSlot,
    twapLastPrice,
    twapWindowSlot,
    twapWindowCum,
    epochSeed,
    epochSeedEpoch,
    epochSeedTargetSlot,
    epochSeedRecordedSlot,
    status: coinStatusName(statusByte),
    statusByte,
    bump,
    version,
  };
}

/** The reward index a position accrues in. */
export const TRANCHE = { bonded: 0, starter: 1 } as const;
export type TrancheName = "bonded" | "starter";

export function trancheName(tranche: number): TrancheName {
  return tranche === TRANCHE.starter ? "starter" : "bonded";
}

/** Where a bond's lamports came from. */
export const BOND_SOURCE = { self: 0, sponsor: 1 } as const;
export type BondSourceName = "self" | "sponsor";

export function bondSourceName(source: number): BondSourceName {
  return source === BOND_SOURCE.sponsor ? "sponsor" : "self";
}

/** The crew components, in the order crew_levels stores them. */
export const CREW_COMPONENT = {
  miners: 0,
  drills: 1,
  carts: 2,
  foreman: 3,
  storage: 4,
} as const;

export interface PlayerCrewLevels {
  miners: number;
  drills: number;
  carts: number;
  foreman: number;
  storage: number;
}

/**
 * One wallet's whole player state: maturity, streak, crew, ORE, its discovery budget windows and
 * its bond. The owner is not a field - it is the PDA seed - so a decoder never returns one, and a
 * caller that needs it already has it.
 *
 * ORE is deliberately a u64 balance in this account and never an SPL token: it is
 * non-transferable game state, so there is nothing here that could be sent anywhere.
 */
export interface DecodedPlayerAccount {
  /** Maturity anchors, fixed at PDA creation and never reset by a bond. */
  createdSlot: bigint;
  createdAt: bigint;
  activeUntil: bigint;
  lastActivationAt: bigint;
  streak: number;
  longestStreak: number;
  validActivations: number;
  activeDays: number;
  lastActiveDay: number;
  streakFreezes: number;
  /** crew_levels in declaration order, and the same five values by name. */
  crewLevels: number[];
  crew: PlayerCrewLevels;
  oreBalance: bigint;
  oreEarned: bigint;
  oreSpent: bigint;
  oreAccruedAt: bigint;
  activeMine: Address;
  dayIndex: number;
  weekIndex: number;
  spentDayLamports: bigint;
  spentWeekLamports: bigint;
  /** The window the last roll was created in; a repeat in the same window is a no-op, never a reroll. */
  rollWindow: number;
  rollCount: number;
  lastRollAt: bigint;
  /** Lamports locked in this PDA's balance above its rent-exempt minimum. */
  bondLamports: bigint;
  bondLockedAt: bigint;
  unbondAvailableAt: bigint;
  bondSource: BondSourceName;
  bondSourceByte: number;
  /** The vault a sponsor-funded bond returns to; the default pubkey when self-funded. */
  bondSponsorVault: Address;
  bump: number;
  version: number;
}

export function decodePlayerAccount(data: Uint8Array): DecodedPlayerAccount {
  const reader = new ByteReader(data, "PlayerAccount");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.PlayerAccount, "PlayerAccount");
  const createdSlot = reader.u64();
  const createdAt = reader.i64();
  const activeUntil = reader.i64();
  const lastActivationAt = reader.i64();
  const streak = reader.u16();
  const longestStreak = reader.u16();
  const validActivations = reader.u16();
  const activeDays = reader.u16();
  const lastActiveDay = reader.u16();
  const streakFreezes = reader.u8();
  const crewLevels: number[] = [];
  for (let i = 0; i < CREW_COMPONENTS; i++) crewLevels.push(reader.u16());
  const oreBalance = reader.u64();
  const oreEarned = reader.u64();
  const oreSpent = reader.u64();
  const oreAccruedAt = reader.i64();
  const activeMine = reader.pubkey();
  const dayIndex = reader.u16();
  const weekIndex = reader.u16();
  const spentDayLamports = reader.u64();
  const spentWeekLamports = reader.u64();
  const rollWindow = reader.u16();
  const rollCount = reader.u16();
  const lastRollAt = reader.i64();
  const bondLamports = reader.u64();
  const bondLockedAt = reader.i64();
  const unbondAvailableAt = reader.i64();
  const bondSourceByte = reader.u8();
  const bondSponsorVault = reader.pubkey();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.playerAccount);
  return {
    createdSlot,
    createdAt,
    activeUntil,
    lastActivationAt,
    streak,
    longestStreak,
    validActivations,
    activeDays,
    lastActiveDay,
    streakFreezes,
    crewLevels,
    crew: {
      miners: crewLevels[CREW_COMPONENT.miners],
      drills: crewLevels[CREW_COMPONENT.drills],
      carts: crewLevels[CREW_COMPONENT.carts],
      foreman: crewLevels[CREW_COMPONENT.foreman],
      storage: crewLevels[CREW_COMPONENT.storage],
    },
    oreBalance,
    oreEarned,
    oreSpent,
    oreAccruedAt,
    activeMine,
    dayIndex,
    weekIndex,
    spentDayLamports,
    spentWeekLamports,
    rollWindow,
    rollCount,
    lastRollAt,
    bondLamports,
    bondLockedAt,
    unbondAvailableAt,
    bondSource: bondSourceName(bondSourceByte),
    bondSourceByte,
    bondSponsorVault,
    bump,
    version,
  };
}

/**
 * One wallet's position in one coin. The coin and the owner are the PDA seeds, so neither is
 * stored, and the reward-index math is the v4 math unchanged: the delta between the coin's index
 * and this position's cursor, times assigned_power.
 */
export interface DecodedMiningPosition {
  assignedPower: bigint;
  lastRewardIndex: bigint;
  pendingReward: bigint;
  tranche: TrancheName;
  trancheByte: number;
  createdSlot: bigint;
  bump: number;
  version: number;
}

export function decodeMiningPosition(data: Uint8Array): DecodedMiningPosition {
  const reader = new ByteReader(data, "MiningPosition");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.MiningPosition, "MiningPosition");
  const assignedPower = reader.u64();
  const lastRewardIndex = reader.u128();
  const pendingReward = reader.u64();
  const trancheByte = reader.u8();
  const createdSlot = reader.u64();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.miningPosition);
  return {
    assignedPower,
    lastRewardIndex,
    pendingReward,
    tranche: trancheName(trancheByte),
    trancheByte,
    createdSlot,
    bump,
    version,
  };
}

/**
 * The permanently locked pool a coin graduates into. There is no LP mint and no LP token: the only
 * way either side can shrink is a real swap, and the only price the protocol trusts is the TWAP
 * this account accumulates on every one of them.
 */
export interface DecodedLiquidityPool {
  coin: Address;
  mint: Address;
  tokenVault: Address;
  solVault: Address;
  tokenReserve: bigint;
  solReserve: bigint;
  graduatedAt: bigint;
  /** Cumulative lamports per base unit, scaled by PRICE_SCALE, updated on every swap. */
  cumPriceLamportsPerUnit: bigint;
  lastUpdateSlot: bigint;
  bump: number;
}

export function decodeLiquidityPool(data: Uint8Array): DecodedLiquidityPool {
  const reader = new ByteReader(data, "LiquidityPool");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.LiquidityPool, "LiquidityPool");
  const coin = reader.pubkey();
  const mint = reader.pubkey();
  const tokenVault = reader.pubkey();
  const solVault = reader.pubkey();
  const tokenReserve = reader.u64();
  const solReserve = reader.u64();
  const graduatedAt = reader.i64();
  const cumPriceLamportsPerUnit = reader.u128();
  const lastUpdateSlot = reader.u64();
  const bump = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.liquidityPool);
  return {
    coin,
    mint,
    tokenVault,
    solVault,
    tokenReserve,
    solReserve,
    graduatedAt,
    cumPriceLamportsPerUnit,
    lastUpdateSlot,
    bump,
  };
}

export const OPPORTUNITY_STATUS = { pending: 0, settled: 1, expired: 2 } as const;
export type OpportunityStatusName = "Pending" | "Settled" | "Expired";

export function opportunityStatusName(status: number): OpportunityStatusName {
  if (status === OPPORTUNITY_STATUS.settled) return "Settled";
  if (status === OPPORTUNITY_STATUS.expired) return "Expired";
  return "Pending";
}

/**
 * One pending discovery roll. The budget is charged when this account is created, while the epoch
 * seed is still unknown, and an expired opportunity pays nothing and refunds no budget.
 */
export interface DecodedDiscoveryOpportunity {
  coin: Address;
  owner: Address;
  windowIndex: number;
  dayIndex: number;
  /** The epoch whose seed settles this opportunity. Written at creation, never rewritten. */
  epochIndex: number;
  budgetLamports: bigint;
  /** Token units frozen at creation and used as the settlement cap. */
  reservedUnits: bigint;
  createdAt: bigint;
  createdSlot: bigint;
  expiresAt: bigint;
  status: OpportunityStatusName;
  statusByte: number;
  /** Rarity tier the seed derived at settlement; zero while pending. */
  rarity: number;
  bump: number;
  version: number;
}

export function decodeDiscoveryOpportunity(data: Uint8Array): DecodedDiscoveryOpportunity {
  const reader = new ByteReader(data, "DiscoveryOpportunity");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.DiscoveryOpportunity, "DiscoveryOpportunity");
  const coin = reader.pubkey();
  const owner = reader.pubkey();
  const windowIndex = reader.u16();
  const dayIndex = reader.u16();
  const epochIndex = reader.u32();
  const budgetLamports = reader.u64();
  const reservedUnits = reader.u64();
  const createdAt = reader.i64();
  const createdSlot = reader.u64();
  const expiresAt = reader.i64();
  const statusByte = reader.u8();
  const rarity = reader.u8();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.discoveryOpportunity);
  return {
    coin,
    owner,
    windowIndex,
    dayIndex,
    epochIndex,
    budgetLamports,
    reservedUnits,
    createdAt,
    createdSlot,
    expiresAt,
    status: opportunityStatusName(statusByte),
    statusByte,
    rarity,
    bump,
    version,
  };
}

/** The protocol-wide daily discovery cap: created by the first roll of the day, closed by a crank. */
export interface DecodedGlobalBudget {
  dayIndex: number;
  capLamports: bigint;
  spentLamports: bigint;
  rollCount: number;
  settledCount: number;
  openedAt: bigint;
  openedSlot: bigint;
  closed: boolean;
  bump: number;
  version: number;
}

export function decodeGlobalBudget(data: Uint8Array): DecodedGlobalBudget {
  const reader = new ByteReader(data, "GlobalBudget");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.GlobalBudget, "GlobalBudget");
  const dayIndex = reader.u16();
  const capLamports = reader.u64();
  const spentLamports = reader.u64();
  const rollCount = reader.u32();
  const settledCount = reader.u32();
  const openedAt = reader.i64();
  const openedSlot = reader.u64();
  const closed = reader.bool();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.globalBudget);
  return {
    dayIndex,
    capLamports,
    spentLamports,
    rollCount,
    settledCount,
    openedAt,
    openedSlot,
    closed,
    bump,
    version,
  };
}

// --- sponsorship accounts ---------------------------------------------------------------------------

/**
 * The four sponsorship kinds. Sponsorship can pay rent and fees and nothing else: it can never
 * change power, rewards, discovery odds, rarity, caps or eligibility. Adding a fifth kind is a
 * program upgrade, so this table is closed.
 *
 * `playerBondSubsidy` is legacy. There is no bond left to post, so no client offers it and no
 * instruction accepts it; the byte is kept because an event created before the change still decodes
 * with it, and a decoder that renamed an old event's kind would be lying about what it read.
 */
export const SPONSOR_EVENT_KIND = {
  /** Pays the mint, Coin and vault rent at launch_token. */
  launchRentSubsidy: 0,
  /** Pays the platform share of a trading fee at accrual. */
  platformTradeFeeWaiver: 1,
  /** Pays a player's PlayerAccount rent. */
  playerAccountSubsidy: 2,
  /** Posts a player's bond from the vault. */
  playerBondSubsidy: 3,
} as const;

export type SponsorEventKindName =
  | "LaunchRentSubsidy"
  | "PlatformTradeFeeWaiver"
  | "PlayerAccountSubsidy"
  | "PlayerBondSubsidy";

export function sponsorEventKindName(kind: number): SponsorEventKindName | null {
  if (kind === SPONSOR_EVENT_KIND.launchRentSubsidy) return "LaunchRentSubsidy";
  if (kind === SPONSOR_EVENT_KIND.platformTradeFeeWaiver) return "PlatformTradeFeeWaiver";
  if (kind === SPONSOR_EVENT_KIND.playerAccountSubsidy) return "PlayerAccountSubsidy";
  if (kind === SPONSOR_EVENT_KIND.playerBondSubsidy) return "PlayerBondSubsidy";
  return null;
}

/**
 * A sponsor's own lamport vault. It belongs to the owner's wallet, is not governance, and can never
 * be a program or config authority: unspent lamports are never the protocol's.
 */
export interface DecodedSponsorVault {
  sponsorOwner: Address;
  /** The id the next event will be created under, and therefore its PDA seed. */
  eventCount: number;
  totalFunded: bigint;
  totalSpent: bigint;
  totalWithdrawn: bigint;
  bump: number;
  version: number;
}

export function decodeSponsorVault(data: Uint8Array): DecodedSponsorVault {
  const reader = new ByteReader(data, "SponsorVault");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.SponsorVault, "SponsorVault");
  const sponsorOwner = reader.pubkey();
  const eventCount = reader.u32();
  const totalFunded = reader.u64();
  const totalSpent = reader.u64();
  const totalWithdrawn = reader.u64();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.sponsorVault);
  return { sponsorOwner, eventCount, totalFunded, totalSpent, totalWithdrawn, bump, version };
}

/** One sponsorship event: a budget, a window and two independent per-subject limits. */
export interface DecodedSponsorEvent {
  vault: Address;
  kind: number;
  kindName: SponsorEventKindName | null;
  startAt: bigint;
  endAt: bigint;
  budgetLamports: bigint;
  spentLamports: bigint;
  perCoinLimitLamports: bigint;
  perWalletLimitLamports: bigint;
  paused: boolean;
  bump: number;
  version: number;
}

export function decodeSponsorEvent(data: Uint8Array): DecodedSponsorEvent {
  const reader = new ByteReader(data, "SponsorEvent");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.SponsorEvent, "SponsorEvent");
  const vault = reader.pubkey();
  const kind = reader.u8();
  const startAt = reader.i64();
  const endAt = reader.i64();
  const budgetLamports = reader.u64();
  const spentLamports = reader.u64();
  const perCoinLimitLamports = reader.u64();
  const perWalletLimitLamports = reader.u64();
  const paused = reader.bool();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.sponsorEvent);
  return {
    vault,
    kind,
    kindName: sponsorEventKindName(kind),
    startAt,
    endAt,
    budgetLamports,
    spentLamports,
    perCoinLimitLamports,
    perWalletLimitLamports,
    paused,
    bump,
    version,
  };
}

/**
 * What one (event, subject) pair has consumed. It is created at most once per pair, so
 * re-launching a coin or re-posting a bond cannot reset a limit. For a launch-rent or
 * trade-fee-waiver event the subject is the coin; for an account or bond subsidy it is the wallet,
 * which is what makes both the per-coin and the per-wallet limit enforceable against one shape.
 */
export interface DecodedSponsorGrant {
  spentLamports: bigint;
  waivedFeeLamports: bigint;
  /** The part of spentLamports charged against the event's per-wallet limit. */
  walletSpentLamports: bigint;
  createdSlot: bigint;
  bump: number;
  version: number;
}

export function decodeSponsorGrant(data: Uint8Array): DecodedSponsorGrant {
  const reader = new ByteReader(data, "SponsorGrant");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.SponsorGrant, "SponsorGrant");
  const spentLamports = reader.u64();
  const waivedFeeLamports = reader.u64();
  const walletSpentLamports = reader.u64();
  const createdSlot = reader.u64();
  const bump = reader.u8();
  const version = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.sponsorGrant);
  return { spentLamports, waivedFeeLamports, walletSpentLamports, createdSlot, bump, version };
}

export interface DecodedReferralCredit {
  amount: bigint;
  bump: number;
}

export function decodeReferralCredit(data: Uint8Array): DecodedReferralCredit {
  const reader = new ByteReader(data, "ReferralCredit");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.ReferralCredit, "ReferralCredit");
  const amount = reader.u64();
  const bump = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.referralCredit);
  return { amount, bump };
}

export interface DecodedReferralWeek {
  weekIndex: bigint;
  count: number;
  bump: number;
}

export function decodeReferralWeek(data: Uint8Array): DecodedReferralWeek {
  const reader = new ByteReader(data, "ReferralWeek");
  reader.expectDiscriminator(ACCOUNT_DISCRIMINATORS.ReferralWeek, "ReferralWeek");
  const weekIndex = reader.i64();
  const count = reader.u8();
  const bump = reader.u8();
  reader.expectEnd(ACCOUNT_SIZE.referralWeek);
  return { weekIndex, count, bump };
}

// --- Token-2022 mint and token account helpers --------------------------------------------------------

interface TlvEntry {
  type: number;
  length: number;
  /** Offset of the entry's data, i.e. just past its 4-byte type and length header. */
  start: number;
}

/**
 * Walks the extension TLV entries of a Token-2022 account: the base region (MINT_BASE_SIZE, 165
 * bytes, of which only the mint's first 82 are state), then one account-type byte, then repeated
 * (u16 type, u16 length, data) entries. A type of zero is the uninitialized padding the runtime
 * writes into a reallocated tail, so the walk stops there.
 */
function tlvEntries(data: Uint8Array): TlvEntry[] {
  const entries: TlvEntry[] = [];
  let offset = MINT_BASE_SIZE + MINT_ACCOUNT_TYPE_SIZE;
  while (offset + 4 <= data.length) {
    const type = data[offset] | (data[offset + 1] << 8);
    const length = data[offset + 2] | (data[offset + 3] << 8);
    if (type === 0 || length === 0) break;
    entries.push({ type, length, start: offset + 4 });
    offset += 4 + length;
  }
  return entries;
}

function optionalNonZeroPubkey(bytes: Uint8Array): Address | null {
  if (bytes.every((byte) => byte === 0)) return null;
  return address(base58FromBytes(bytes));
}

/**
 * What a Token-2022 mint says about itself.
 *
 * The v2 coin's name, symbol and uri live in the mint's own token-metadata extension rather than in
 * a Metaplex account (design 1.3(c)), so this is how the UI and the indexer read them: there is no
 * metadata account to fetch and no metadata program in the path. A mint that carries no
 * token-metadata extension decodes with hasTokenMetadata false and empty strings rather than
 * throwing, because a single legacy mint must not be able to fail an indexing pass.
 */
export interface DecodedMintMetadata {
  /** False when the mint carries no token-metadata extension at all. */
  hasTokenMetadata: boolean;
  name: string;
  symbol: string;
  uri: string;
  /** The mint the metadata claims to describe. It should be the mint's own address. */
  mint: Address | null;
  /** The metadata's update authority, or null when it is unset (which is the launch state). */
  updateAuthority: Address | null;
  /** The additional key-value pairs, in stored order. */
  additionalMetadata: { key: string; value: string }[];
  /** Where the metadata pointer points, or null when the mint has no metadata pointer. */
  metadataPointer: { authority: Address | null; metadataAddress: Address | null } | null;
  /** Every extension type number the account carries, in TLV order. */
  extensionTypes: number[];
  accountType: number;
}

export function decodeMintMetadata(data: Uint8Array): DecodedMintMetadata {
  if (data.length < MINT_BASE_SIZE + MINT_ACCOUNT_TYPE_SIZE) {
    throw new Error("mint: account data is " + data.length + " bytes, too short to be a Token-2022 mint");
  }
  const accountType = data[MINT_BASE_SIZE];
  const entries = tlvEntries(data);
  const pointer = entries.find((entry) => entry.type === EXTENSION_TYPE.metadataPointer);
  const metadata = entries.find((entry) => entry.type === EXTENSION_TYPE.tokenMetadata);
  const result: DecodedMintMetadata = {
    hasTokenMetadata: metadata !== undefined,
    name: "",
    symbol: "",
    uri: "",
    mint: null,
    updateAuthority: null,
    additionalMetadata: [],
    metadataPointer: pointer
      ? {
          authority: optionalNonZeroPubkey(data.subarray(pointer.start, pointer.start + 32)),
          metadataAddress: optionalNonZeroPubkey(data.subarray(pointer.start + 32, pointer.start + 64)),
        }
      : null,
    extensionTypes: entries.map((entry) => entry.type),
    accountType,
  };
  if (!metadata) return result;

  const reader = new ByteReader(data.subarray(metadata.start, metadata.start + metadata.length), "TokenMetadata");
  result.updateAuthority = optionalNonZeroPubkey(reader.bytes(32));
  result.mint = reader.pubkey();
  result.name = reader.string();
  result.symbol = reader.string();
  result.uri = reader.string();
  const pairCount = reader.u32();
  for (let i = 0; i < pairCount; i++) {
    result.additionalMetadata.push({ key: reader.string(), value: reader.string() });
  }
  return result;
}

/**
 * The TLV size of a token-metadata entry carrying these strings and no extra pairs: a 4-byte
 * header, the update authority and mint, then each Borsh string as a u32 length plus its bytes, and
 * a 4-byte empty pair vector. At the launch caps (16 / 8 / 96) that is 204 bytes, which is exactly
 * the MINT_TOKEN_METADATA_SIZE the Rust constants compute from the same caps.
 */
export function tokenMetadataTlvSize(nameLength: number, symbolLength: number, uriLength: number): number {
  return 4 + 32 + 32 + (4 + nameLength) + (4 + symbolLength) + (4 + uriLength) + 4;
}

/** What a token account says. Token-2022's base layout is the same 165 bytes as SPL Token's. */
export interface DecodedTokenAccount {
  mint: Address;
  owner: Address;
  amount: bigint;
  delegate: Address | null;
  state: TokenAccountStateName;
  stateByte: number;
  isNative: bigint | null;
  delegatedAmount: bigint;
  closeAuthority: Address | null;
}

export type TokenAccountStateName = "Uninitialized" | "Initialized" | "Frozen";

export function tokenAccountStateName(state: number): TokenAccountStateName {
  if (state === 1) return "Initialized";
  if (state === 2) return "Frozen";
  return "Uninitialized";
}

export function decodeTokenAccount(data: Uint8Array): DecodedTokenAccount {
  const reader = new ByteReader(data, "TokenAccount");
  const mint = reader.pubkey();
  const owner = reader.pubkey();
  const amount = reader.u64();
  // COption is a four-byte tag followed by a fixed-size payload, so an unset option still occupies
  // its payload: the bytes must be skipped whether or not the tag says the option is set.
  const delegateTag = reader.u32();
  const delegateBytes = reader.bytes(32);
  const delegate = delegateTag === 0 ? null : address(base58FromBytes(delegateBytes));
  const stateByte = reader.u8();
  const isNativeTag = reader.u32();
  const isNativeValue = reader.u64();
  const isNative = isNativeTag === 0 ? null : isNativeValue;
  const delegatedAmount = reader.u64();
  const closeAuthorityTag = reader.u32();
  const closeAuthorityBytes = reader.bytes(32);
  const closeAuthority = closeAuthorityTag === 0 ? null : address(base58FromBytes(closeAuthorityBytes));
  reader.expectEnd(TOKEN_ACCOUNT_SIZE);
  return {
    mint,
    owner,
    amount,
    delegate,
    state: tokenAccountStateName(stateByte),
    stateByte,
    isNative,
    delegatedAmount,
    closeAuthority,
  };
}

/**
 * The associated token account creation instruction, idempotent so a client never has to ask
 * whether the account already exists. It is here rather than in @solana-program/token because the
 * project builds every instruction from kit primitives, and because the coin's token program is
 * Token-2022: passing the wrong one derives an account the program will not accept.
 */
export function buildCreateAssociatedTokenAccountIdempotentInstruction(params: {
  payer: Address;
  owner: Address;
  mint: Address;
  associatedToken: Address;
  tokenProgram?: Address;
}): IInstruction {
  return {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    accounts: [
      ws(params.payer),
      w(params.associatedToken),
      r(params.owner),
      r(params.mint),
      r(SYSTEM_PROGRAM_ADDRESS),
      r(params.tokenProgram ?? TOKEN_2022_PROGRAM_ADDRESS),
    ],
    data: Uint8Array.of(1),
  };
}

// --- compute budget helpers ----------------------------------------------------------------------------

/**
 * The program's own per-call bound is MAX_SYNC_SEGMENTS, so a walk is compute-bounded by design and
 * a client only has to give the transaction room. These helpers build the two ComputeBudget
 * instructions a v2 transaction needs, in the order the runtime wants them.
 */
export const COMPUTE_BUDGET_INSTRUCTION = {
  requestHeapFrame: 1,
  setComputeUnitLimit: 2,
  setComputeUnitPrice: 3,
  setLoadedAccountsDataSizeLimit: 4,
} as const;

/** Enough for a ledger walk or a launch with room to spare, without paying for unused units. */
export const DEFAULT_COMPUTE_UNIT_LIMIT = 400_000;

export function buildComputeBudgetUnitLimitInstruction(units: number): IInstruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data: concatBytes(Uint8Array.of(COMPUTE_BUDGET_INSTRUCTION.setComputeUnitLimit), u32(units)),
  };
}

export function buildComputeBudgetUnitPriceInstruction(microLamports: bigint): IInstruction {
  return {
    programAddress: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data: concatBytes(Uint8Array.of(COMPUTE_BUDGET_INSTRUCTION.setComputeUnitPrice), u64(microLamports)),
  };
}

/**
 * Prepends the compute-budget instructions to a transaction's instructions. The unit price is left
 * out unless it is non-zero, so a caller that does not want to pay priority fees sends nothing.
 */
export function withComputeBudget(
  instructions: readonly IInstruction[],
  options: { unitLimit?: number; unitPriceMicroLamports?: bigint } = {},
): IInstruction[] {
  const limit = options.unitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const prefix: IInstruction[] = [buildComputeBudgetUnitLimitInstruction(limit)];
  if (options.unitPriceMicroLamports) {
    prefix.push(buildComputeBudgetUnitPriceInstruction(options.unitPriceMicroLamports));
  }
  return [...prefix, ...instructions];
}

// --- re-exports ------------------------------------------------------------------------------------------

/**
 * Everything PDA-shaped is defined in shared/pdas.ts and re-exported here, so a caller that only
 * wants the client has one import. The two modules are split because the seed helpers are also used
 * by the pure-math modules, which must not pull in the instruction surface.
 */
export {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  BPF_LOADER_UPGRADEABLE_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  base58FromBytes,
  deriveCoinPdaSync,
  deriveCoinVaultPdaSync,
  deriveCrankPoolPdaSync,
  deriveCurveTablePdaSync,
  deriveGlobalBudgetPdaSync,
  deriveMintPdaSync,
  deriveOpportunityPdaSync,
  derivePlayerPdaSync,
  derivePoolPdaSync,
  derivePoolSolVaultPdaSync,
  derivePoolTokenVaultPdaSync,
  derivePositionPdaSync,
  deriveProtocolPdaSync,
  deriveSponsorEventPdaSync,
  deriveSponsorGrantPdaSync,
  deriveSponsorVaultPdaSync,
  deriveReferralCreditPdaSync,
  deriveReferralWeekPdaSync,
  deriveTreasuryPdaSync,
  findProgramAddressSync,
};

export {
  PROGRAM_SEEDS,
  deriveAssociatedTokenAddress,
  deriveAssociatedTokenAddressSync,
  deriveCoinAddresses,
  deriveCoinPda,
  deriveCoinVaultPda,
  deriveCrankPoolPda,
  deriveCurveTablePda,
  deriveGlobalBudgetPda,
  deriveMintPda,
  deriveOpportunityPda,
  derivePlayerPda,
  derivePoolAddresses,
  derivePoolPda,
  derivePoolSolVaultPda,
  derivePoolTokenVaultPda,
  derivePositionPda,
  deriveProgramDataAddress,
  deriveProtocolPda,
  deriveSponsorEventPda,
  deriveSponsorGrantPda,
  deriveSponsorVaultPda,
  deriveReferralCreditPda,
  deriveReferralWeekPda,
  deriveTreasuryPda,
  seedAddress,
  seedConstant,
  seedU8,
  seedU16,
  seedU32,
  type CoinAddresses,
  type PoolAddresses,
  type ProgramSeedName,
} from "./pdas";
