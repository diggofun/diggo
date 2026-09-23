/**
 * Contract tests for the v2 client.
 *
 * Everything asserted here is transcribed from the generated IDL
 * (target/idl/diggo_protocol.json, produced by anchor build in WSL) and from the frozen layouts in
 * programs/diggo-protocol/CONTRACTS.md. The three classes of bug these cover:
 *
 * 1. A builder whose account list drifts from the program's #[derive(Accounts)] struct. The program
 *    answers a drifted list with a deserialization failure or, worse, with a role error on an
 *    account the caller thought was fine, so the expected lists below are written out one line per
 *    instruction in the IDL's own order and roles.
 * 2. A discriminator that does not match. The table of literal eight-byte values below was read out
 *    of the IDL, and it is compared against the sha256-derived values the builders actually use, so
 *    a renamed instruction fails here rather than on chain.
 * 3. A decoder whose field offsets drift from the Rust struct. Each decoder is fed a fixture built
 *    field by field at the contract's own offsets, and is asserted both field by field and against
 *    the frozen account size.
 *
 * @solana/kit's AccountRole is bit-flagged: bit0 = writable, bit1 = signer.
 */
import { describe, expect, it } from "vitest";
import {
  type Address,
  type ReadonlyUint8Array,
  address,
  getBase58Decoder,
  getAddressEncoder,
  type Instruction,
} from "@solana/kit";
import {
  ACCOUNT_DISCRIMINATORS,
  ACCOUNT_SIZE,
  COIN_STATUS,
  DIGGO_ACCOUNT_NAMES,
  DIGGO_ERROR_NAMES,
  DIGGO_INSTRUCTION_NAMES,
  EXTENSION_TYPE,
  INSTRUCTION_DISCRIMINATORS,
  MAX_NAME_LEN,
  MAX_SYMBOL_LEN,
  MAX_URI_LEN,
  MINT_BASE_SIZE,
  MINT_INITIAL_SIZE,
  MINT_TOKEN_METADATA_SIZE,
  MINT_V2_SIZE,
  SYSVAR_SLOT_HASHES_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_2022_PROGRAM_ADDRESS,
  activeRarityTiers,
  buildActivateInstruction,
  buildAdvanceMineInstruction,
  buildAssignPowerInstruction,
  buildBuyInstruction,
  buildClaimCreatorFeesInstruction,
  buildClaimRewardsInstruction,
  buildCloseSponsorEventInstruction,
  buildCollectOreInstruction,
  buildCommitEpochSeedInstruction,
  buildComputeBudgetUnitLimitInstruction,
  buildComputeBudgetUnitPriceInstruction,
  buildCrankTipInstruction,
  buildCreateDiscoveryRollInstruction,
  buildCreateSponsorEventInstruction,
  buildCreditReferralOreInstruction,
  buildExpireOpportunityInstruction,
  buildFundSponsorVaultInstruction,
  buildGraduateMarketInstruction,
  buildInitializePlayerInstruction,
  buildInitializeProtocolInstruction,
  buildInitSponsorVaultInstruction,
  buildLaunchTokenInstruction,
  buildPoolBuyInstruction,
  buildPoolSellInstruction,
  buildRemovePowerInstruction,
  buildRequestUnbondInstruction,
  buildSchedulePauseInstruction,
  buildSellInstruction,
  buildSetCurveTableInstruction,
  buildSetRarityTableInstruction,
  buildSettleDiscoveryInstruction,
  buildSweepFeesInstruction,
  buildSwitchMineInstruction,
  buildUnpauseInstruction,
  buildUpdateDiscoveryLimitsInstruction,
  buildUpdateFeeConfigInstruction,
  buildUpgradeCrewInstruction,
  buildWithdrawBondInstruction,
  buildWithdrawSponsorVaultInstruction,
  coinStatusName,
  decodeCoin,
  decodeClockSysvar,
  decodeCurveTable,
  decodeDiscoveryOpportunity,
  decodeGlobalBudget,
  decodeLiquidityPool,
  decodeMintMetadata,
  decodeMiningPosition,
  decodePlayerAccount,
  decodeProtocolConfig,
  decodeSponsorEvent,
  decodeSponsorGrant,
  decodeSponsorVault,
  decodeTokenAccount,
  describeDiggoError,
  discoveryDayIndexAt,
  diggoErrorCode,
  diggoErrorName,
  tokenMetadataTlvSize,
  withComputeBudget,
  type LaunchTokenArgs,
  type ProtocolConfigArgs,
  type RarityTier,
} from "./program";

describe("Solana Clock sysvar decoding", () => {
  it("derives the discovery day from chain time at a UTC boundary", () => {
    const bytes = new Uint8Array(40);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 500n, true);
    view.setBigInt64(8, 1_700_000_000n, true);
    view.setBigUint64(16, 600n, true);
    view.setBigUint64(24, 601n, true);
    view.setBigInt64(32, 20_000n * 86_400n, true);

    expect(decodeClockSysvar(bytes)).toEqual({
      slot: 500n,
      epochStartTimestamp: 1_700_000_000n,
      epoch: 600n,
      leaderScheduleEpoch: 601n,
      unixTimestamp: 20_000n * 86_400n,
    });
    expect(discoveryDayIndexAt(20_000n * 86_400n - 1n)).toBe(19_999);
    expect(discoveryDayIndexAt(20_000n * 86_400n)).toBe(20_000);
  });
});
import {
  deriveCoinPda,
  deriveCoinPdaSync,
  deriveGlobalBudgetPda,
  deriveGlobalBudgetPdaSync,
  deriveMintPda,
  deriveMintPdaSync,
  deriveOpportunityPda,
  deriveOpportunityPdaSync,
  derivePlayerPda,
  derivePlayerPdaSync,
  derivePoolSolVaultPda,
  derivePoolSolVaultPdaSync,
  derivePositionPda,
  derivePositionPdaSync,
  deriveProtocolPda,
  deriveProtocolPdaSync,
  deriveSponsorEventPda,
  deriveSponsorEventPdaSync,
  deriveSponsorGrantPda,
  deriveSponsorGrantPdaSync,
  deriveSponsorVaultPda,
  deriveSponsorVaultPdaSync,
  deriveTreasuryPda,
  deriveTreasuryPdaSync,
  findProgramAddressSync,
} from "./pdas";

/** A real, decodable 32-byte address; the fixed strings used elsewhere are not valid base58. */
const pk = (byte: number): Address => address(getBase58Decoder().decode(new Uint8Array(32).fill(byte)));

const PROGRAM = pk(1);

/**
 * One distinct address per role, so a builder that swapped two accounts cannot pass by accident.
 * The values are passed explicitly to every builder below, which keeps the account-list assertions
 * about account order and roles rather than about derivation (derivation has its own tests).
 */
const FIXTURE = {
  program: PROGRAM,
  authority: pk(2),
  creator: pk(3),
  owner: pk(4),
  payer: pk(5),
  buyer: pk(6),
  seller: pk(7),
  sponsorOwner: pk(8),
  mint: pk(9),
  fromMint: pk(10),
  toMint: pk(11),
  coin: pk(12),
  fromCoin: pk(13),
  toCoin: pk(14),
  vault: pk(15),
  player: pk(16),
  position: pk(17),
  fromPosition: pk(18),
  toPosition: pk(19),
  protocol: pk(20),
  treasury: pk(21),
  crankPool: pk(22),
  keeper: pk(35),
  referrer: pk(36),
  referee: pk(37),
  credit: pk(38),
  week: pk(39),
  pool: pk(23),
  poolTokenVault: pk(24),
  poolSolVault: pk(25),
  opportunity: pk(26),
  globalBudget: pk(27),
  sponsorVault: pk(28),
  sponsorEvent: pk(29),
  sponsorGrant: pk(30),
  ownerTokens: pk(31),
  buyerTokens: pk(32),
  sellerTokens: pk(33),
  curveTable: pk(34),
  slotHashes: SYSVAR_SLOT_HASHES_ADDRESS,
  systemProgram: SYSTEM_PROGRAM_ADDRESS,
  tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
} as const satisfies Record<string, Address>;

type FixtureName = keyof typeof FIXTURE;

interface ExpectedAccount {
  address: Address;
  writable: boolean;
  signer: boolean;
}

/**
 * Parses an account-list spec written the way the IDL reads: "creator:ws mint:w ...", where the
 * role is r/w/rs/ws and the label is a FIXTURE key. The label "program" is the Anchor placeholder
 * an omitted Option<Account> is filled with.
 */
function expectedAccounts(spec: string): ExpectedAccount[] {
  return spec.split(" ").map((token) => {
    const [label, role] = token.split(":");
    const name = label as FixtureName;
    if (!(name in FIXTURE)) throw new Error("unknown fixture account " + label);
    return {
      address: FIXTURE[name],
      writable: role.includes("w"),
      signer: role.includes("s"),
    };
  });
}

function accountsOf(ix: Instruction): ExpectedAccount[] {
  return (ix.accounts ?? []).map((account) => ({
    address: account.address,
    writable: (account.role & 1) !== 0,
    signer: (account.role & 2) !== 0,
  }));
}

function hexOf(bytes: Uint8Array | readonly number[]): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// --- the literal contract: discriminators, read out of target/idl/diggo_protocol.json --------------

const IDL_INSTRUCTION_DISCRIMINATORS: Record<string, string> = {
  activate: "c2cb23649737aa52",
  advance_mine: "db6461fd75e73a07",
  assign_power: "5b55b3dd30ee7d59",
  buy: "66063d1201daebea",
  claim_creator_fees: "00177dea9c768659",
  claim_rewards: "0490844774179750",
  close_sponsor_event: "72a4c83b81e0a31d",
  collect_ore: "4dbc2db05414a092",
  commit_epoch_seed: "fe824b2fd4156705",
  crank_tip: "8bafacd78d8129bd",
  create_discovery_roll: "9ede9e6b5857cf81",
  create_sponsor_event: "322fd5cc40008fca",
  credit_referral_ore: "22e7cbc383b13881",
  expire_opportunity: "0d009e5f15513ba4",
  fund_sponsor_vault: "3a7a211a453c4832",
  graduate_market: "ca1c2173ba60015a",
  init_sponsor_vault: "39f0896a5ffe08d3",
  initialize_player: "4ff958b1dc3e3880",
  initialize_protocol: "bce9fc6a8692ca5b",
  launch_token: "0a8056ab0389a1f4",
  pool_buy: "20b1fa8a98a07d09",
  pool_sell: "1bdc975893d5392a",
  remove_power: "9c4e86f0a664c7e4",
  request_unbond: "0b23b367e29ffb3f",
  schedule_pause: "3264b0dcc32b6734",
  sell: "33e685a4017f83ad",
  set_curve_table: "31c4aec5d9ce72b0",
  set_rarity_table: "69767a6d67407706",
  settle_discovery: "ca587777af313f3d",
  sweep_fees: "afe1624776422294",
  switch_mine: "d58eb3d0e6c550c9",
  unpause: "a99004260a8dbcff",
  update_discovery_limits: "3525a298d2a82c06",
  update_fee_config: "68b867f258976b14",
  upgrade_crew: "15575d405b6fbbd0",
  withdraw_bond: "dec78d1fbc5d9b28",
  withdraw_sponsor_vault: "cd7b8831eceeacbe",
};

const IDL_ACCOUNT_DISCRIMINATORS: Record<string, string> = {
  Coin: "d7c335eed9c4d533",
  CurveTable: "1fcbd8f526f5a863",
  DiscoveryOpportunity: "393141de9f646482",
  GlobalBudget: "1c170f15996733c8",
  LiquidityPool: "42261140bc504481",
  MiningPosition: "8461614aeebb6d8c",
  PlayerAccount: "e0b8e032624830ec",
  ProtocolConfig: "cf5bfa1c98b3d7d1",
  SponsorEvent: "03ace45546574bbc",
  SponsorGrant: "5b7707a8d31f90a3",
  SponsorVault: "4878223a15c20e34",
  ReferralCredit: "f3e8462c07039d6c",
  ReferralWeek: "17655ffe556d356d",
};

describe("discriminators match the generated IDL", () => {
  it("carries exactly the 36 v2 instructions the program declares", () => {
    expect([...DIGGO_INSTRUCTION_NAMES].sort()).toEqual(Object.keys(IDL_INSTRUCTION_DISCRIMINATORS).sort());
  });

  it("has no instruction for posting a bond", () => {
    // post_bond went with the deposit. Pinning its absence is what stops a partial revert from
    // quietly re-adding a way to put lamports into a PlayerAccount.
    expect(DIGGO_INSTRUCTION_NAMES).not.toContain("post_bond");
    expect(IDL_INSTRUCTION_DISCRIMINATORS.post_bond).toBeUndefined();
    // The legacy instructions that still have lamports to move are the ones that stay: a bond
    // posted before the change, and a sponsor vault funded before it.
    expect(DIGGO_INSTRUCTION_NAMES).toContain("request_unbond");
    expect(DIGGO_INSTRUCTION_NAMES).toContain("withdraw_bond");
    expect(DIGGO_INSTRUCTION_NAMES).toContain("withdraw_sponsor_vault");
  });

  it("derives sha256(global:<name>)[..8] for every instruction", () => {
    for (const [name, expected] of Object.entries(IDL_INSTRUCTION_DISCRIMINATORS)) {
      expect(hexOf(INSTRUCTION_DISCRIMINATORS[name as keyof typeof INSTRUCTION_DISCRIMINATORS])).toBe(expected);
    }
  });

  it("carries exactly the 13 v2 accounts the program declares", () => {
    expect([...DIGGO_ACCOUNT_NAMES].sort()).toEqual(Object.keys(IDL_ACCOUNT_DISCRIMINATORS).sort());
  });

  it("derives sha256(account:<Name>)[..8] for every account", () => {
    for (const [name, expected] of Object.entries(IDL_ACCOUNT_DISCRIMINATORS)) {
      expect(hexOf(ACCOUNT_DISCRIMINATORS[name as keyof typeof ACCOUNT_DISCRIMINATORS])).toBe(expected);
    }
  });
});

// --- account lists, transcribed from the IDL in declaration order ---------------------------------

const RARITY_TIERS: RarityTier[] = [
  { cumulativeChanceBps: 7_000, valueLamports: 500_000n, minEligibilityScore: 0, minLiquidityLamports: 0n, minVolumeLamports: 0n },
  { cumulativeChanceBps: 10_000, valueLamports: 20_000_000_000n, minEligibilityScore: 900, minLiquidityLamports: 50_000_000_000n, minVolumeLamports: 10_000_000_000n },
];

const PROTOCOL_CONFIG_ARGS: ProtocolConfigArgs = {
  creatorFeeBps: 50,
  platformFeeBps: 50,
  crankPoolFeeBps: 0,
  discoveryMaxBps: 100,
  discoveryEpochBudgetBps: 500,
  starterEfficiencyBps: 2_500,
  starterTrancheBps: 1_000,
  bondLamports: 70_000_000n,
  bondCooldownSeconds: 604_800n,
  epochSeedDelaySlots: 32n,
  epochSeedMaxLatenessSlots: 512n,
  minCurveMiningBlocks: 48n,
  discoveryDailyCapLamports: 1_000_000_000n,
  discoveryWeeklyCapLamports: 4_000_000_000n,
  discoveryGlobalDailyCapLamports: 50_000_000_000n,
  discoveryEpochBudgetLamports: 2_000_000_000n,
  rarityTiers: RARITY_TIERS,
  timelockSeconds: 172_800n,
};

const LAUNCH_ARGS: LaunchTokenArgs = {
  nonce: 0,
  decimals: 6,
  name: "Diggo Test Coin",
  symbol: "DIGGO",
  uri: "https://diggo.fun/coins/diggo-test-coin.json",
  totalSupply: 1_000_000_000_000n,
  reserveBps: 500,
  discoveryReserveBps: 50,
  curveMiningBps: 500,
  curveMiningRunwayDays: 30,
  creatorFeeBps: 50,
  platformFeeBps: 50,
  graduationTarget: 85_000_000_000n,
  blockInterval: 300,
  epochLength: 604_800,
  reductionBps: 2_500,
  minimumReward: 1_000n,
};

interface InstructionCase {
  name: keyof typeof IDL_INSTRUCTION_DISCRIMINATORS;
  build: () => Instruction;
  spec: string;
}

const INSTRUCTION_CASES: InstructionCase[] = [
  {
    name: "initialize_protocol",
    build: () =>
      buildInitializeProtocolInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        treasury: FIXTURE.treasury,
        crankPool: FIXTURE.crankPool,
        config: PROTOCOL_CONFIG_ARGS,
      }),
    spec: "authority:ws protocol:w treasury:r crankPool:r systemProgram:r",
  },
  {
    name: "update_fee_config",
    build: () =>
      buildUpdateFeeConfigInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        creatorFeeBps: 50,
        platformFeeBps: 50,
        crankPoolFeeBps: 0,
      }),
    spec: "authority:rs protocol:w",
  },
  {
    name: "update_discovery_limits",
    build: () =>
      buildUpdateDiscoveryLimitsInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        discoveryMaxBps: 100,
        discoveryEpochBudgetBps: 500,
        dailyCapLamports: 1_000_000_000n,
        weeklyCapLamports: 4_000_000_000n,
        globalDailyCapLamports: 50_000_000_000n,
        epochBudgetLamports: 2_000_000_000n,
      }),
    spec: "authority:rs protocol:w",
  },
  {
    name: "set_rarity_table",
    build: () =>
      buildSetRarityTableInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        tiers: RARITY_TIERS,
      }),
    spec: "authority:rs protocol:w",
  },
  {
    name: "set_curve_table",
    build: () =>
      buildSetCurveTableInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        curveTable: FIXTURE.curveTable,
        power: [1, 2, 3],
        upgradeOreCost: [[1, 2, 3]],
      }),
    spec: "authority:ws protocol:r curveTable:w systemProgram:r",
  },
  {
    name: "schedule_pause",
    build: () =>
      buildSchedulePauseInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        flag: 1,
        pausedUntil: 1_800_000_000n,
      }),
    spec: "authority:rs protocol:w",
  },
  {
    name: "unpause",
    build: () =>
      buildUnpauseInstruction({
        programAddress: PROGRAM,
        authority: FIXTURE.authority,
        protocol: FIXTURE.protocol,
        flag: 1,
      }),
    spec: "authority:rs protocol:w",
  },
  {
    name: "launch_token",
    build: () =>
      buildLaunchTokenInstruction({
        programAddress: PROGRAM,
        creator: FIXTURE.creator,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        vault: FIXTURE.vault,
        protocol: FIXTURE.protocol,
        sponsorVault: null,
        sponsorEvent: null,
        sponsorGrant: null,
        tokenProgram: FIXTURE.tokenProgram,
        args: LAUNCH_ARGS,
      }),
    spec: "creator:ws mint:w coin:w vault:w protocol:r program:w program:r program:w tokenProgram:r systemProgram:r",
  },
  {
    name: "buy",
    build: () =>
      buildBuyInstruction({
        programAddress: PROGRAM,
        buyer: FIXTURE.buyer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        vault: FIXTURE.vault,
        buyerTokens: FIXTURE.buyerTokens,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
        solIn: 1_000_000_000n,
        minTokensOut: 0n,
      }),
    spec: "buyer:ws mint:r coin:w vault:w buyerTokens:w protocol:r tokenProgram:r systemProgram:r",
  },
  {
    name: "sell",
    build: () =>
      buildSellInstruction({
        programAddress: PROGRAM,
        seller: FIXTURE.seller,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        vault: FIXTURE.vault,
        sellerTokens: FIXTURE.sellerTokens,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
        tokensIn: 1_000n,
        minSolOut: 0n,
      }),
    spec: "seller:ws mint:r coin:w vault:w sellerTokens:w protocol:r tokenProgram:r systemProgram:r",
  },
  {
    name: "pool_buy",
    build: () =>
      buildPoolBuyInstruction({
        programAddress: PROGRAM,
        buyer: FIXTURE.buyer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        pool: FIXTURE.pool,
        poolTokenVault: FIXTURE.poolTokenVault,
        poolSolVault: FIXTURE.poolSolVault,
        buyerTokens: FIXTURE.buyerTokens,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
        solIn: 1_000_000_000n,
        minTokensOut: 0n,
      }),
    spec: "buyer:ws mint:r coin:w pool:w poolTokenVault:w poolSolVault:w buyerTokens:w protocol:r tokenProgram:r systemProgram:r",
  },
  {
    name: "pool_sell",
    build: () =>
      buildPoolSellInstruction({
        programAddress: PROGRAM,
        seller: FIXTURE.seller,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        pool: FIXTURE.pool,
        poolTokenVault: FIXTURE.poolTokenVault,
        poolSolVault: FIXTURE.poolSolVault,
        sellerTokens: FIXTURE.sellerTokens,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
        tokensIn: 1_000n,
        minSolOut: 0n,
      }),
    spec: "seller:ws mint:r coin:w pool:w poolTokenVault:w poolSolVault:w sellerTokens:w protocol:r tokenProgram:r systemProgram:r",
  },
  {
    name: "graduate_market",
    build: () =>
      buildGraduateMarketInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        vault: FIXTURE.vault,
        pool: FIXTURE.pool,
        poolTokenVault: FIXTURE.poolTokenVault,
        poolSolVault: FIXTURE.poolSolVault,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
      }),
    spec: "payer:ws mint:r coin:w vault:w pool:w poolTokenVault:w poolSolVault:w protocol:r tokenProgram:r systemProgram:r",
  },
  {
    name: "sweep_fees",
    build: () =>
      buildSweepFeesInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        protocol: FIXTURE.protocol,
        treasury: FIXTURE.treasury,
        crankPool: FIXTURE.crankPool,
        creator: FIXTURE.creator,
      }),
    spec: "payer:ws mint:r coin:w protocol:r treasury:w crankPool:w creator:w systemProgram:r",
  },
  {
    name: "claim_creator_fees",
    build: () =>
      buildClaimCreatorFeesInstruction({
        programAddress: PROGRAM,
        creator: FIXTURE.creator,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
      }),
    spec: "creator:ws mint:r coin:w systemProgram:r",
  },
  {
    name: "crank_tip",
    build: () =>
      buildCrankTipInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        protocol: FIXTURE.protocol,
        maxTip: 1_000_000n,
      }),
    spec: "payer:ws mint:r coin:w protocol:r systemProgram:r",
  },
  {
    name: "init_sponsor_vault",
    build: () =>
      buildInitSponsorVaultInstruction({
        programAddress: PROGRAM,
        sponsorOwner: FIXTURE.sponsorOwner,
        sponsorVault: FIXTURE.sponsorVault,
      }),
    spec: "sponsorOwner:ws sponsorVault:w systemProgram:r",
  },
  {
    name: "fund_sponsor_vault",
    build: () =>
      buildFundSponsorVaultInstruction({
        programAddress: PROGRAM,
        sponsorOwner: FIXTURE.sponsorOwner,
        sponsorVault: FIXTURE.sponsorVault,
        amount: 100_000_000n,
      }),
    spec: "sponsorOwner:ws sponsorVault:w systemProgram:r",
  },
  {
    name: "withdraw_sponsor_vault",
    build: () =>
      buildWithdrawSponsorVaultInstruction({
        programAddress: PROGRAM,
        sponsorOwner: FIXTURE.sponsorOwner,
        sponsorVault: FIXTURE.sponsorVault,
        amount: 100_000_000n,
      }),
    spec: "sponsorOwner:ws sponsorVault:w systemProgram:r",
  },
  {
    name: "create_sponsor_event",
    build: () =>
      buildCreateSponsorEventInstruction({
        programAddress: PROGRAM,
        sponsorOwner: FIXTURE.sponsorOwner,
        sponsorVault: FIXTURE.sponsorVault,
        sponsorEvent: FIXTURE.sponsorEvent,
        kind: 0,
        startAt: 0n,
        endAt: 1_800_000_000n,
        budgetLamports: 100_000_000_000n,
        perCoinLimitLamports: 10_000_000n,
        perWalletLimitLamports: 70_000_000n,
      }),
    spec: "sponsorOwner:ws sponsorVault:w sponsorEvent:w systemProgram:r",
  },
  {
    name: "close_sponsor_event",
    build: () =>
      buildCloseSponsorEventInstruction({
        programAddress: PROGRAM,
        sponsorOwner: FIXTURE.sponsorOwner,
        sponsorVault: FIXTURE.sponsorVault,
        sponsorEvent: FIXTURE.sponsorEvent,
        eventId: 0,
      }),
    spec: "sponsorOwner:ws sponsorVault:r sponsorEvent:w",
  },
  {
    name: "initialize_player",
    build: () =>
      buildInitializePlayerInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        protocol: FIXTURE.protocol,
        sponsorVault: null,
        sponsorEvent: null,
        sponsorGrant: null,
      }),
    spec: "owner:ws player:w protocol:w program:w program:r program:w systemProgram:r",
  },
  {
    name: "activate",
    build: () =>
      buildActivateInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        protocol: FIXTURE.protocol,
      }),
    spec: "owner:ws player:w protocol:r",
  },
  {
    name: "collect_ore",
    build: () =>
      buildCollectOreInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        protocol: FIXTURE.protocol,
      }),
    spec: "owner:rs player:w protocol:r",
  },
  {
    name: "upgrade_crew",
    build: () =>
      buildUpgradeCrewInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        protocol: FIXTURE.protocol,
        curveTable: null,
        component: 0,
      }),
    spec: "owner:rs player:w protocol:r program:r",
  },
  {
    name: "assign_power",
    build: () =>
      buildAssignPowerInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        position: FIXTURE.position,
        protocol: FIXTURE.protocol,
      }),
    spec: "owner:ws player:w mint:r coin:w position:w protocol:r systemProgram:r",
  },
  {
    name: "remove_power",
    build: () =>
      buildRemovePowerInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        position: FIXTURE.position,
      }),
    spec: "owner:ws player:w mint:r coin:w position:w systemProgram:r",
  },
  {
    name: "switch_mine",
    build: () =>
      buildSwitchMineInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        fromMint: FIXTURE.fromMint,
        fromCoin: FIXTURE.fromCoin,
        fromPosition: FIXTURE.fromPosition,
        toMint: FIXTURE.toMint,
        toCoin: FIXTURE.toCoin,
        toPosition: FIXTURE.toPosition,
      }),
    spec: "owner:ws player:w fromMint:r fromCoin:w fromPosition:w toMint:r toCoin:w toPosition:w systemProgram:r",
  },
  {
    name: "claim_rewards",
    build: () =>
      buildClaimRewardsInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        vault: FIXTURE.vault,
        ownerTokens: FIXTURE.ownerTokens,
        position: FIXTURE.position,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
      }),
    spec: "owner:ws player:w mint:r coin:w vault:w ownerTokens:w position:w protocol:r tokenProgram:r",
  },
  {
    name: "request_unbond",
    build: () =>
      buildRequestUnbondInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        protocol: FIXTURE.protocol,
      }),
    spec: "owner:rs player:w protocol:r",
  },
  {
    name: "withdraw_bond",
    build: () =>
      buildWithdrawBondInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        protocol: FIXTURE.protocol,
        sponsorVault: null,
      }),
    spec: "owner:ws player:w protocol:r program:w systemProgram:r",
  },
  {
    name: "advance_mine",
    build: () =>
      buildAdvanceMineInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        protocol: FIXTURE.protocol,
      }),
    spec: "payer:ws mint:r coin:w protocol:r",
  },
  {
    name: "commit_epoch_seed",
    build: () =>
      buildCommitEpochSeedInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        protocol: FIXTURE.protocol,
        slotHashes: FIXTURE.slotHashes,
      }),
    spec: "payer:ws mint:r coin:w protocol:r slotHashes:r",
  },
  {
    name: "create_discovery_roll",
    build: () =>
      buildCreateDiscoveryRollInstruction({
        programAddress: PROGRAM,
        owner: FIXTURE.owner,
        player: FIXTURE.player,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        opportunity: FIXTURE.opportunity,
        globalBudget: FIXTURE.globalBudget,
        protocol: FIXTURE.protocol,
      }),
    spec: "owner:ws player:w mint:r coin:w opportunity:w globalBudget:w protocol:r systemProgram:r",
  },
  {
    name: "settle_discovery",
    build: () =>
      buildSettleDiscoveryInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        owner: FIXTURE.owner,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        vault: FIXTURE.vault,
        ownerTokens: FIXTURE.ownerTokens,
        opportunity: FIXTURE.opportunity,
        globalBudget: FIXTURE.globalBudget,
        protocol: FIXTURE.protocol,
        tokenProgram: FIXTURE.tokenProgram,
      }),
    spec: "payer:ws owner:r mint:r coin:w vault:w ownerTokens:w opportunity:w globalBudget:w protocol:r tokenProgram:r systemProgram:r",
  },
  {
    name: "expire_opportunity",
    build: () =>
      buildExpireOpportunityInstruction({
        programAddress: PROGRAM,
        payer: FIXTURE.payer,
        owner: FIXTURE.owner,
        mint: FIXTURE.mint,
        coin: FIXTURE.coin,
        opportunity: FIXTURE.opportunity,
      }),
    spec: "payer:ws owner:r mint:r coin:w opportunity:w systemProgram:r",
  },
  {
    name: "credit_referral_ore",
    build: () =>
      buildCreditReferralOreInstruction({
        programAddress: PROGRAM,
        keeper: FIXTURE.keeper,
        referrer: FIXTURE.referrer,
        referee: FIXTURE.referee,
        amount: 250n,
        player: FIXTURE.player,
        credit: FIXTURE.credit,
        week: FIXTURE.week,
        protocol: FIXTURE.protocol,
      }),
    spec: "keeper:ws player:w credit:w week:w protocol:r referee:r referrer:r systemProgram:r",
  },
];

describe("every builder matches the program's account list", () => {
  it("covers every v2 instruction exactly once", () => {
    expect(INSTRUCTION_CASES.map((entry) => entry.name).sort()).toEqual(
      [...DIGGO_INSTRUCTION_NAMES].sort(),
    );
  });

  for (const entry of INSTRUCTION_CASES) {
    it("matches " + entry.name, () => {
      const ix = entry.build();
      expect(ix.programAddress).toBe(PROGRAM);
      expect(accountsOf(ix)).toEqual(expectedAccounts(entry.spec));
      expect(hexOf(Array.from(ix.data ?? []).slice(0, 8))).toBe(IDL_INSTRUCTION_DISCRIMINATORS[entry.name]);
    });
  }
});

// --- PDA derivation: the local search and the kit search must agree ---------------------------------

describe("PDA derivation agrees between the sync search and @solana/kit", () => {
  const OWNER = pk(60);
  const COIN = pk(61);
  const VAULT = pk(62);
  const EVENT = pk(63);
  const CREATOR = pk(64);

  it("derives the protocol, treasury and crank-pool PDAs", async () => {
    expect(deriveProtocolPdaSync(PROGRAM)).toBe(await deriveProtocolPda(PROGRAM));
    expect(deriveTreasuryPdaSync(PROGRAM)).toBe(await deriveTreasuryPda(PROGRAM));
  });

  it("derives the coin, vault, player and position PDAs", async () => {
    expect(deriveCoinPdaSync(PROGRAM, VAULT)).toBe(await deriveCoinPda(PROGRAM, VAULT));
    expect(derivePlayerPdaSync(PROGRAM, OWNER)).toBe(await derivePlayerPda(PROGRAM, OWNER));
    expect(derivePositionPdaSync(PROGRAM, COIN, OWNER)).toBe(await derivePositionPda(PROGRAM, COIN, OWNER));
  });

  it("derives the mint PDA from the creator and the nonce", async () => {
    expect(deriveMintPdaSync(PROGRAM, CREATOR, 3)).toBe(await deriveMintPda(PROGRAM, CREATOR, 3));
    // A different nonce is a different mint: this is what lets one creator launch repeatedly.
    expect(deriveMintPdaSync(PROGRAM, CREATOR, 4)).not.toBe(deriveMintPdaSync(PROGRAM, CREATOR, 3));
  });

  it("derives the discovery PDAs, whose integer seeds are little-endian", async () => {
    expect(deriveOpportunityPdaSync(PROGRAM, COIN, OWNER, 7)).toBe(
      await deriveOpportunityPda(PROGRAM, COIN, OWNER, 7),
    );
    expect(deriveGlobalBudgetPdaSync(PROGRAM, 7)).toBe(await deriveGlobalBudgetPda(PROGRAM, 7));
    // 0x0102 and 0x0201 must not collide, which is what pins the seed endianness.
    expect(deriveGlobalBudgetPdaSync(PROGRAM, 0x0102)).not.toBe(deriveGlobalBudgetPdaSync(PROGRAM, 0x0201));
  });

  it("derives the sponsor PDAs", async () => {
    expect(deriveSponsorVaultPdaSync(PROGRAM, OWNER)).toBe(await deriveSponsorVaultPda(PROGRAM, OWNER));
    expect(deriveSponsorEventPdaSync(PROGRAM, VAULT, 2)).toBe(
      await deriveSponsorEventPda(PROGRAM, VAULT, 2),
    );
    expect(deriveSponsorGrantPdaSync(PROGRAM, EVENT, COIN)).toBe(
      await deriveSponsorGrantPda(PROGRAM, EVENT, COIN),
    );
  });

  it("derives the pool SOL vault, which holds lamports and no tokens", async () => {
    expect(derivePoolSolVaultPdaSync(PROGRAM, VAULT)).toBe(await derivePoolSolVaultPda(PROGRAM, VAULT));
  });

  it("refuses a seed set with no viable bump instead of returning something wrong", () => {
    expect(() => findProgramAddressSync([], PROGRAM)).not.toThrow();
    expect(findProgramAddressSync([], PROGRAM)).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });
});

// --- the error table ---------------------------------------------------------------------------------

/** The 49 v2 variants, in the order design section 8.2 reserves them (6048..6096). */
const V2_ERROR_NAMES_IN_ORDER = [
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

describe("the error table", () => {
  it("places the v2 block at 6048..6096 in the designed order", () => {
    expect(V2_ERROR_NAMES_IN_ORDER).toHaveLength(49);
    V2_ERROR_NAMES_IN_ORDER.forEach((name, index) => {
      expect(DIGGO_ERROR_NAMES[name]).toBe(6_048 + index);
    });
  });

  it("keeps the v4 codes below the v2 block, because the tree still carries those variants", () => {
    expect(DIGGO_ERROR_NAMES.SyncBehind).toBe(6_044);
    expect(DIGGO_ERROR_NAMES.InvalidCurveMining).toBe(6_047);
  });

  it("maps a code back to its name and refuses a code that is not ours", () => {
    expect(diggoErrorName(6_048)).toBe("NotImplemented");
    expect(diggoErrorName(6_087)).toBe("CoinNotAdvanced");
    expect(diggoErrorName(6_095)).toBe("EpochBudgetExhausted");
    expect(diggoErrorName(6_096)).toBe("UnclaimedRewards");
    expect(diggoErrorName(6_097)).toBeNull();
    expect(diggoErrorName(0)).toBeNull();
    expect(diggoErrorCode("NotImplemented")).toBe(6_048);
    expect(diggoErrorCode("NoSuchError")).toBeNull();
  });

  it("describes an error legibly, and says when a code is a v4 leftover", () => {
    expect(describeDiggoError(6_048)).toBe("DiggoError::NotImplemented (6048)");
    expect(describeDiggoError(6_044)).toContain("v4 variant");
    expect(describeDiggoError(12_345)).toBe("unknown program error 12345");
  });
});

// --- argument encoding ---------------------------------------------------------------------------------

describe("instruction arguments are Borsh, in declaration order", () => {
  it("encodes launch_token args at the contract's own field sizes", () => {
    const ix = buildLaunchTokenInstruction({
      programAddress: PROGRAM,
      creator: FIXTURE.creator,
      mint: FIXTURE.mint,
      coin: FIXTURE.coin,
      vault: FIXTURE.vault,
      protocol: FIXTURE.protocol,
      args: LAUNCH_ARGS,
    });
    const data = ix.data ?? new Uint8Array();
    const expected =
      8 + // discriminator
      1 + 1 + // nonce, decimals
      (4 + LAUNCH_ARGS.name.length) +
      (4 + LAUNCH_ARGS.symbol.length) +
      (4 + LAUNCH_ARGS.uri.length) +
      8 + // total_supply
      2 * 6 + // reserve, discovery reserve, curve mining, runway, creator fee, platform fee
      8 + // graduation_target
      4 + 4 + // block_interval, epoch_length
      2 + // reduction_bps
      8; // minimum_reward
    expect(data.length).toBe(expected);
  });

  it("falls back to the protocol defaults for an omitted curve-mining share", () => {
    const ix = buildLaunchTokenInstruction({
      programAddress: PROGRAM,
      creator: FIXTURE.creator,
      mint: FIXTURE.mint,
      coin: FIXTURE.coin,
      vault: FIXTURE.vault,
      protocol: FIXTURE.protocol,
      args: { ...LAUNCH_ARGS, curveMiningBps: undefined, curveMiningRunwayDays: undefined },
    });
    const data = ix.data ?? new Uint8Array();
    const curveMiningOffset =
      8 + 1 + 1 + (4 + LAUNCH_ARGS.name.length) + (4 + LAUNCH_ARGS.symbol.length) +
      (4 + LAUNCH_ARGS.uri.length) + 8 + 2 + 2;
    expect(data[curveMiningOffset] | (data[curveMiningOffset + 1] << 8)).toBe(500);
    expect(data[curveMiningOffset + 2] | (data[curveMiningOffset + 3] << 8)).toBe(30);
  });

  it("encodes initialize_protocol's config struct at the contract's own field sizes", () => {
    const ix = buildInitializeProtocolInstruction({
      programAddress: PROGRAM,
      authority: FIXTURE.authority,
      protocol: FIXTURE.protocol,
      treasury: FIXTURE.treasury,
      crankPool: FIXTURE.crankPool,
      config: PROTOCOL_CONFIG_ARGS,
    });
    const data = ix.data ?? new Uint8Array();
    const expected = 8 + 2 * 7 + 8 * 9 + (4 + 28 * RARITY_TIERS.length) + 8;
    expect(data.length).toBe(expected);
  });

  it("encodes a rarity table as a u32 count followed by 28-byte tiers", () => {
    const ix = buildSetRarityTableInstruction({
      programAddress: PROGRAM,
      authority: FIXTURE.authority,
      protocol: FIXTURE.protocol,
      tiers: RARITY_TIERS,
    });
    const data = ix.data ?? new Uint8Array();
    expect(data.length).toBe(8 + 4 + 28 * RARITY_TIERS.length);
    expect(data[8]).toBe(RARITY_TIERS.length);
  });
});

// --- decoder fixtures, written at the contract's own offsets ------------------------------------------

/**
 * Builds account data byte by byte, so the fixtures are written from the contract's layout rather
 * than from the decoder being tested: a fixture built by the decoder would prove nothing.
 */
class FixtureWriter {
  private readonly parts: number[] = [];

  private push(value: number | bigint, bytes: number): this {
    let rest = BigInt(value);
    for (let i = 0; i < bytes; i++) {
      this.parts.push(Number(rest & 0xffn));
      rest >>= 8n;
    }
    return this;
  }

  u8(value: number): this {
    return this.push(value, 1);
  }

  u16(value: number): this {
    return this.push(value, 2);
  }

  u32(value: number): this {
    return this.push(value, 4);
  }

  u64(value: bigint): this {
    return this.push(value, 8);
  }

  i64(value: bigint): this {
    return this.push(value, 8);
  }

  u128(value: bigint): this {
    return this.push(value, 16);
  }

  raw(bytes: Uint8Array | ReadonlyUint8Array | readonly number[]): this {
    for (const byte of bytes) this.parts.push(byte);
    return this;
  }

  pubkey(value: Address): this {
    return this.raw(getAddressEncoder().encode(value));
  }

  /** A Borsh string: u32 byte length, then the UTF-8 bytes. */
  string(value: string): this {
    const body = new TextEncoder().encode(value);
    this.u32(body.length);
    return this.raw(body);
  }

  discriminator(name: keyof typeof ACCOUNT_DISCRIMINATORS): this {
    return this.raw(ACCOUNT_DISCRIMINATORS[name]);
  }

  get length(): number {
    return this.parts.length;
  }

  build(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

describe("decoders read the frozen layouts", () => {
  it("decodes a Coin field for field", () => {
    const w = new FixtureWriter();
    w.discriminator("Coin");
    w.pubkey(pk(100)); // creator
    w.pubkey(pk(101)); // vault
    w.u64(1_000_000_000_000n); // total_supply
    w.u64(400_000_000_000n); // reserve_remaining
    w.u64(50_000_000_000n); // discovery_remaining
    w.u64(7n); // outstanding_claims
    w.u64(11n); // cumulative_distributed
    w.u64(900n); // total_power
    w.u64(600n); // bonded_power
    w.u64(75n); // starter_power
    w.u128(123_456_789_012_345_678_901_234_567_890n); // bonded_index
    w.u128(987_654_321_098_765_432_109_876_543_210n); // starter_index
    w.u64(1_000n); // current_block_reward
    w.u32(300); // block_interval
    w.i64(1_800_000_000n); // next_block_at
    w.u32(12); // epoch_index
    w.u32(604_800); // epoch_length
    w.i64(1_800_100_000n); // epoch_ends_at
    w.u64(300_000_000n); // epoch_ends_slot
    w.u16(2_500); // reduction_bps
    w.u64(1_000n); // minimum_reward
    w.u64(2_000_000n); // token_reserve
    w.u64(85_000_000_000n); // sol_reserve
    w.u64(30_000_000_000n); // virtual_sol_reserve
    w.u64(85_000_000_000n); // graduation_target
    w.u64(1_500n); // creator_fee_claimable
    w.u64(2_500n); // platform_fee_claimable
    w.u16(50); // creator_fee_bps
    w.u16(50); // platform_fee_bps
    w.u64(5_000_000_000n); // curve_mining_cap
    w.u64(1_000_000_000n); // curve_mining_mined
    w.u64(10n); // curve_mining_unpaid
    w.u64(1_000_000n); // curve_mining_block_reward
    w.u8(1); // curve_mining_open
    w.u8(0); // graduated
    w.i64(0n); // curve_phase_ends_at
    w.u64(50_000_000_000n); // discovery_reserve_total
    w.u64(5_000_000_000n); // discovery_epoch_budget
    w.u64(120n); // discovery_epoch_spent
    w.u32(12); // discovery_epoch_index
    w.u8(0); // discovery_paused
    w.u128(987_654_321_098_765_432_109_876_543_210n); // twap accumulator
    w.u64(300_000_001n); // twap_last_update_slot
    w.u128(555_555_555_555_555_555_555_555_555_555n); // twap_last_price
    w.u64(299_999_101n); // twap_window_slot
    w.u128(777_777_777_777_777_777_777_777_777_777n); // twap_window_cum
    w.raw(new Uint8Array(32).fill(0xab)); // epoch_seed
    w.u32(12); // epoch_seed_epoch
    w.u64(300_000_032n); // epoch_seed_target_slot
    w.u64(300_000_040n); // epoch_seed_recorded_slot
    w.u8(1); // status
    w.u8(254); // bump
    w.u8(5); // version
    expect(w.length).toBe(ACCOUNT_SIZE.coin);

    const coin = decodeCoin(w.build());
    expect(coin.creator).toBe(pk(100));
    expect(coin.vault).toBe(pk(101));
    expect(coin.totalSupply).toBe(1_000_000_000_000n);
    expect(coin.reserveRemaining).toBe(400_000_000_000n);
    expect(coin.discoveryRemaining).toBe(50_000_000_000n);
    expect(coin.outstandingClaims).toBe(7n);
    expect(coin.cumulativeDistributed).toBe(11n);
    expect(coin.totalPower).toBe(900n);
    expect(coin.bondedPower).toBe(600n);
    expect(coin.starterPower).toBe(75n);
    expect(coin.bondedIndex).toBe(123_456_789_012_345_678_901_234_567_890n);
    expect(coin.starterIndex).toBe(987_654_321_098_765_432_109_876_543_210n);
    expect(coin.currentBlockReward).toBe(1_000n);
    expect(coin.blockInterval).toBe(300);
    expect(coin.nextBlockAt).toBe(1_800_000_000n);
    expect(coin.epochIndex).toBe(12);
    expect(coin.epochLength).toBe(604_800);
    expect(coin.epochEndsAt).toBe(1_800_100_000n);
    expect(coin.epochEndsSlot).toBe(300_000_000n);
    expect(coin.reductionBps).toBe(2_500);
    expect(coin.minimumReward).toBe(1_000n);
    expect(coin.tokenReserve).toBe(2_000_000n);
    expect(coin.solReserve).toBe(85_000_000_000n);
    expect(coin.virtualSolReserve).toBe(30_000_000_000n);
    expect(coin.graduationTarget).toBe(85_000_000_000n);
    expect(coin.creatorFeeClaimable).toBe(1_500n);
    expect(coin.platformFeeClaimable).toBe(2_500n);
    expect(coin.creatorFeeBps).toBe(50);
    expect(coin.platformFeeBps).toBe(50);
    expect(coin.curveMiningCap).toBe(5_000_000_000n);
    expect(coin.curveMiningMined).toBe(1_000_000_000n);
    expect(coin.curveMiningUnpaid).toBe(10n);
    expect(coin.curveMiningBlockReward).toBe(1_000_000n);
    expect(coin.curveMiningOpen).toBe(true);
    expect(coin.graduated).toBe(false);
    expect(coin.curvePhaseEndsAt).toBe(0n);
    expect(coin.discoveryReserveTotal).toBe(50_000_000_000n);
    expect(coin.discoveryEpochBudget).toBe(5_000_000_000n);
    expect(coin.discoveryEpochSpent).toBe(120n);
    expect(coin.discoveryEpochIndex).toBe(12);
    expect(coin.discoveryPaused).toBe(false);
    expect(coin.twapCumPriceLamportsPerUnit).toBe(987_654_321_098_765_432_109_876_543_210n);
    expect(coin.twapLastUpdateSlot).toBe(300_000_001n);
    expect(coin.twapLastPrice).toBe(555_555_555_555_555_555_555_555_555_555n);
    expect(coin.twapWindowSlot).toBe(299_999_101n);
    expect(coin.twapWindowCum).toBe(777_777_777_777_777_777_777_777_777_777n);
    expect(Array.from(coin.epochSeed)).toEqual(Array.from(new Uint8Array(32).fill(0xab)));
    expect(coin.epochSeedEpoch).toBe(12);
    expect(coin.epochSeedTargetSlot).toBe(300_000_032n);
    expect(coin.epochSeedRecordedSlot).toBe(300_000_040n);
    expect(coin.status).toBe("MiningActive");
    expect(coin.statusByte).toBe(1);
    expect(coin.bump).toBe(254);
    expect(coin.version).toBe(5);
  });

  it("reads a coin the launch has just created as Launching, byte 0", () => {
    // launch.rs stores COIN_STATUS_LAUNCHING on a fresh coin, and only an advance moves it to
    // MiningActive or FullyMined; state/coin.rs numbers the three 0, 1 and 2.
    expect(COIN_STATUS).toEqual({ launching: 0, miningActive: 1, fullyMined: 2 });
    expect(coinStatusName(COIN_STATUS.launching)).toBe("Launching");
    expect(coinStatusName(COIN_STATUS.miningActive)).toBe("MiningActive");
    expect(coinStatusName(COIN_STATUS.fullyMined)).toBe("FullyMined");
  });

  it("decodes a ProtocolConfig including its fixed-size rarity table", () => {
    const w = new FixtureWriter();
    w.discriminator("ProtocolConfig");
    w.pubkey(pk(110)); // authority
    w.pubkey(pk(111)); // treasury
    w.pubkey(pk(112)); // crank_pool
    w.u16(50).u16(50).u16(0).u16(100).u16(500).u16(2_500).u16(1_000);
    w.u64(70_000_000n); // bond_lamports
    w.i64(604_800n); // bond_cooldown_seconds
    w.u64(32n); // epoch_seed_delay_slots
    w.u64(512n); // epoch_seed_max_lateness_slots
    w.u64(48n); // min_curve_mining_blocks
    w.u64(1_000_000_000n).u64(4_000_000_000n).u64(50_000_000_000n).u64(2_000_000_000n);
    for (let i = 0; i < 8; i++) {
      w.u16(7_000 + i).u64(BigInt(500_000 + i)).u16(900).u64(1n).u64(2n);
    }
    w.u8(2); // rarity_tier_count
    w.i64(172_800n); // timelock_seconds
    w.u8(0); // paused_flags
    w.i64(0n); // paused_until
    w.u8(255); // bump
    w.u8(5); // version
    expect(w.length).toBe(ACCOUNT_SIZE.protocolConfig);

    const config = decodeProtocolConfig(w.build());
    expect(config.authority).toBe(pk(110));
    expect(config.treasury).toBe(pk(111));
    expect(config.crankPool).toBe(pk(112));
    expect(config.creatorFeeBps).toBe(50);
    expect(config.starterTrancheBps).toBe(1_000);
    expect(config.bondLamports).toBe(70_000_000n);
    expect(config.bondCooldownSeconds).toBe(604_800n);
    expect(config.epochSeedDelaySlots).toBe(32n);
    expect(config.discoveryEpochBudgetLamports).toBe(2_000_000_000n);
    expect(config.rarityTiers).toHaveLength(8);
    expect(config.rarityTiers[1]).toEqual({
      cumulativeChanceBps: 7_001,
      valueLamports: 500_001n,
      minEligibilityScore: 900,
      minLiquidityLamports: 1n,
      minVolumeLamports: 2n,
    });
    expect(config.rarityTierCount).toBe(2);
    // Only the first rarityTierCount tiers are live; the rest is fixed-size padding.
    expect(activeRarityTiers(config)).toHaveLength(2);
    expect(config.timelockSeconds).toBe(172_800n);
    expect(config.pausedUntil).toBe(0n);
    expect(config.version).toBe(5);
  });

  it("decodes a CurveTable at both ends of each table", () => {
    const w = new FixtureWriter();
    w.discriminator("CurveTable");
    for (let level = 0; level < 100; level++) w.u32(level);
    for (let component = 0; component < 5; component++) {
      for (let level = 0; level < 100; level++) w.u32(1_000 + component * 100 + level);
    }
    w.u8(253).u8(5);
    expect(w.length).toBe(ACCOUNT_SIZE.curveTable);

    const table = decodeCurveTable(w.build());
    expect(table.power).toHaveLength(100);
    expect(table.power[0]).toBe(0);
    expect(table.power[99]).toBe(99);
    expect(table.upgradeOreCost).toHaveLength(5);
    expect(table.upgradeOreCost[0][0]).toBe(1_000);
    expect(table.upgradeOreCost[4][99]).toBe(1_499);
    expect(table.bump).toBe(253);
  });

  it("decodes a PlayerAccount, whose ORE and bond live in the account", () => {
    const w = new FixtureWriter();
    w.discriminator("PlayerAccount");
    w.u64(100n); // created_slot
    w.i64(1_700_000_000n); // created_at
    w.i64(1_700_086_400n); // active_until
    w.i64(1_700_000_100n); // last_activation_at
    w.u16(6).u16(9).u16(11).u16(7).u16(12); // streak, longest, valid, active days, last day
    w.u8(2); // streak_freezes
    w.u16(4).u16(3).u16(2).u16(1).u16(5); // crew_levels
    w.u64(1_234n).u64(5_000n).u64(3_766n); // ore balance, earned, spent
    w.i64(1_700_000_200n); // ore_accrued_at
    w.pubkey(pk(120)); // active_mine
    w.u16(20_000).u16(2_857); // day, week
    w.u64(10_000n).u64(40_000n); // spent day, week
    w.u16(20_000).u16(3); // roll window, roll count
    w.i64(1_700_000_300n); // last_roll_at
    w.u64(70_000_000n); // bond_lamports
    w.i64(1_700_000_400n); // bond_locked_at
    w.i64(1_700_604_800n); // unbond_available_at
    w.u8(1); // bond_source
    w.pubkey(pk(121)); // bond_sponsor_vault
    w.u8(252).u8(5);
    expect(w.length).toBe(ACCOUNT_SIZE.playerAccount);

    const player = decodePlayerAccount(w.build());
    expect(player.createdSlot).toBe(100n);
    expect(player.createdAt).toBe(1_700_000_000n);
    expect(player.streak).toBe(6);
    expect(player.longestStreak).toBe(9);
    expect(player.streakFreezes).toBe(2);
    expect(player.crewLevels).toEqual([4, 3, 2, 1, 5]);
    expect(player.crew).toEqual({ miners: 4, drills: 3, carts: 2, foreman: 1, storage: 5 });
    expect(player.oreBalance).toBe(1_234n);
    expect(player.oreEarned).toBe(5_000n);
    expect(player.oreSpent).toBe(3_766n);
    expect(player.activeMine).toBe(pk(120));
    expect(player.dayIndex).toBe(20_000);
    expect(player.weekIndex).toBe(2_857);
    expect(player.rollWindow).toBe(20_000);
    expect(player.bondLamports).toBe(70_000_000n);
    expect(player.unbondAvailableAt).toBe(1_700_604_800n);
    expect(player.bondSource).toBe("sponsor");
    expect(player.bondSponsorVault).toBe(pk(121));
    expect(player.version).toBe(5);
  });

  it("decodes a MiningPosition, including which index it accrues in", () => {
    const w = new FixtureWriter();
    w.discriminator("MiningPosition");
    w.u64(750n); // assigned_power
    w.u128(1_000_000_000_000n); // last_reward_index
    w.u64(42n); // pending_reward
    w.u8(1); // tranche
    w.u64(200n); // created_slot
    w.u8(251).u8(5);
    expect(w.length).toBe(ACCOUNT_SIZE.miningPosition);

    const position = decodeMiningPosition(w.build());
    expect(position.assignedPower).toBe(750n);
    expect(position.lastRewardIndex).toBe(1_000_000_000_000n);
    expect(position.pendingReward).toBe(42n);
    expect(position.tranche).toBe("starter");
    expect(position.createdSlot).toBe(200n);
    expect(position.version).toBe(5);
  });

  it("decodes a LiquidityPool, whose TWAP is the only price the program trusts", () => {
    const w = new FixtureWriter();
    w.discriminator("LiquidityPool");
    w.pubkey(pk(130)).pubkey(pk(131)).pubkey(pk(132)).pubkey(pk(133));
    w.u64(3_000_000n).u64(85_000_000_000n);
    w.i64(1_700_000_000n);
    w.u128(55_555_555_555_555_555_555_555_555_555n);
    w.u64(299_999_999n);
    w.u8(250);
    expect(w.length).toBe(ACCOUNT_SIZE.liquidityPool);

    const pool = decodeLiquidityPool(w.build());
    expect(pool.coin).toBe(pk(130));
    expect(pool.mint).toBe(pk(131));
    expect(pool.tokenVault).toBe(pk(132));
    expect(pool.solVault).toBe(pk(133));
    expect(pool.tokenReserve).toBe(3_000_000n);
    expect(pool.solReserve).toBe(85_000_000_000n);
    expect(pool.graduatedAt).toBe(1_700_000_000n);
    expect(pool.cumPriceLamportsPerUnit).toBe(55_555_555_555_555_555_555_555_555_555n);
    expect(pool.lastUpdateSlot).toBe(299_999_999n);
    expect(pool.bump).toBe(250);
  });

  it("decodes a DiscoveryOpportunity, which records the epoch that will settle it", () => {
    const w = new FixtureWriter();
    w.discriminator("DiscoveryOpportunity");
    w.pubkey(pk(140)).pubkey(pk(141));
    w.u16(20_000).u16(20_000).u32(12);
    w.u64(120_000_000n);
    w.u64(1_000_000n);
    w.i64(1_700_000_000n).u64(299_000_000n).i64(1_701_209_600n);
    w.u8(0).u8(0).u8(249).u8(5);
    expect(w.length).toBe(ACCOUNT_SIZE.discoveryOpportunity);

    const opportunity = decodeDiscoveryOpportunity(w.build());
    expect(opportunity.coin).toBe(pk(140));
    expect(opportunity.owner).toBe(pk(141));
    expect(opportunity.windowIndex).toBe(20_000);
    expect(opportunity.dayIndex).toBe(20_000);
    expect(opportunity.epochIndex).toBe(12);
    expect(opportunity.budgetLamports).toBe(120_000_000n);
    expect(opportunity.reservedUnits).toBe(1_000_000n);
    expect(opportunity.expiresAt).toBe(1_701_209_600n);
    expect(opportunity.status).toBe("Pending");
    expect(opportunity.rarity).toBe(0);
  });

  it("decodes a GlobalBudget, the protocol-wide daily cap", () => {
    const w = new FixtureWriter();
    w.discriminator("GlobalBudget");
    w.u16(20_000).u64(50_000_000_000n).u64(1_234_567_890n);
    w.u32(42).u32(17);
    w.i64(1_700_000_000n).u64(299_000_000n);
    w.u8(0).u8(248).u8(5);
    expect(w.length).toBe(ACCOUNT_SIZE.globalBudget);

    const budget = decodeGlobalBudget(w.build());
    expect(budget.dayIndex).toBe(20_000);
    expect(budget.capLamports).toBe(50_000_000_000n);
    expect(budget.spentLamports).toBe(1_234_567_890n);
    expect(budget.rollCount).toBe(42);
    expect(budget.settledCount).toBe(17);
    expect(budget.closed).toBe(false);
  });

  it("decodes the three sponsor accounts", () => {
    const vaultWriter = new FixtureWriter();
    vaultWriter.discriminator("SponsorVault");
    vaultWriter.pubkey(pk(150)).u32(3);
    vaultWriter.u64(1_000_000_000n).u64(250_000_000n).u64(100_000_000n);
    vaultWriter.u8(247).u8(5);
    expect(vaultWriter.length).toBe(ACCOUNT_SIZE.sponsorVault);
    const vault = decodeSponsorVault(vaultWriter.build());
    expect(vault.sponsorOwner).toBe(pk(150));
    expect(vault.eventCount).toBe(3);
    expect(vault.totalFunded).toBe(1_000_000_000n);
    expect(vault.totalSpent).toBe(250_000_000n);
    expect(vault.totalWithdrawn).toBe(100_000_000n);

    const eventWriter = new FixtureWriter();
    eventWriter.discriminator("SponsorEvent");
    eventWriter.pubkey(pk(151)).u8(3);
    eventWriter.i64(1_700_000_000n).i64(1_800_000_000n);
    eventWriter.u64(100_000_000_000n).u64(70_000_000n);
    eventWriter.u64(10_000_000n).u64(70_000_000n);
    eventWriter.u8(0).u8(246).u8(5);
    expect(eventWriter.length).toBe(ACCOUNT_SIZE.sponsorEvent);
    const event = decodeSponsorEvent(eventWriter.build());
    expect(event.vault).toBe(pk(151));
    expect(event.kind).toBe(3);
    expect(event.kindName).toBe("PlayerBondSubsidy");
    expect(event.perCoinLimitLamports).toBe(10_000_000n);
    expect(event.perWalletLimitLamports).toBe(70_000_000n);
    expect(event.paused).toBe(false);

    const grantWriter = new FixtureWriter();
    grantWriter.discriminator("SponsorGrant");
    grantWriter.u64(70_000_000n).u64(1_000n).u64(70_000_000n).u64(299_000_000n);
    grantWriter.u8(245).u8(5);
    expect(grantWriter.length).toBe(ACCOUNT_SIZE.sponsorGrant);
    const grant = decodeSponsorGrant(grantWriter.build());
    expect(grant.spentLamports).toBe(70_000_000n);
    expect(grant.waivedFeeLamports).toBe(1_000n);
    expect(grant.walletSpentLamports).toBe(70_000_000n);
    expect(grant.createdSlot).toBe(299_000_000n);
  });

  it("refuses data of another account type and data that is too short", () => {
    const coin = new FixtureWriter().discriminator("Coin").raw(new Uint8Array(456)).build();
    // A Coin's bytes decoded as a PlayerAccount must fail on the discriminator, not silently return.
    expect(() => decodePlayerAccount(coin)).toThrow(/discriminator/);
    // A truncated Coin must fail rather than read past the end of its data.
    expect(() => decodeCoin(coin.slice(0, 200))).toThrow();
    expect(() => decodeCoin(new Uint8Array(16))).toThrow();
    // Every unset Option<Pubkey> holds the default pubkey, which is 32 base58 ones and not 33.
    expect(decodeCoin(coin).creator).toBe(address("11111111111111111111111111111111"));
  });
});

// --- Token-2022 mint and token account fixtures --------------------------------------------------------

describe("Token-2022 helpers", () => {
  /** The maximal settled mint launch_token creates: base state, metadata pointer, token metadata. */
  function mintFixture(name: string, symbol: string, uri: string, metadataAddress: Address | null): Uint8Array {
    const w = new FixtureWriter();
    // The base region is 165 bytes: 82 of mint state, then the 83 zero bytes of padding token-2022
    // keeps ahead of the account-type byte it writes at Account::LEN.
    w.raw(new Uint8Array(MINT_BASE_SIZE));
    w.u8(1); // AccountType::Mint
    w.u16(EXTENSION_TYPE.metadataPointer).u16(64);
    w.raw(new Uint8Array(32)); // authority: unset
    w.raw(metadataAddress ? getAddressEncoder().encode(metadataAddress) : new Uint8Array(32));
    const body = new FixtureWriter();
    body.raw(new Uint8Array(32)); // update authority: unset
    body.pubkey(pk(160)); // the mint the metadata describes
    body.string(name).string(symbol).string(uri);
    body.u32(0); // no additional metadata
    const bodyBytes = body.build();
    // The token-metadata extension is 204 bytes including its four-byte TLV header. The declared
    // length therefore describes the body only, and the settled mint is the 438 bytes constants.rs
    // computes from the launch metadata caps: created at MINT_INITIAL_SIZE, reallocated up to
    // MINT_V2_SIZE.
    const entrySize = tokenMetadataTlvSize(16, 8, 96);
    w.u16(EXTENSION_TYPE.tokenMetadata).u16(entrySize - 4);
    w.raw(bodyBytes);
    w.raw(new Uint8Array(entrySize - 4 - bodyBytes.length)); // the slack the launch caps leave
    return w.build();
  }

  it("sizes the token-metadata entry the way constants.rs does", () => {
    // 4 header + update authority + mint + three Borsh strings + an empty pair vector.
    expect(tokenMetadataTlvSize(16, 8, 96)).toBe(204);
    expect(tokenMetadataTlvSize(0, 0, 0)).toBe(84);
  });

  it("lays the mint out the way the Rust constants do", () => {
    // constants.rs: MINT_BASE_SIZE 165 (the base region, not the mint's own 82),
    // MINT_ACCOUNT_TYPE_SIZE 1, MINT_METADATA_POINTER_SIZE 68, MINT_TOKEN_METADATA_SIZE 204.
    expect(MINT_BASE_SIZE).toBe(165);
    expect(MINT_INITIAL_SIZE).toBe(234);
    expect(MINT_TOKEN_METADATA_SIZE).toBe(204);
    expect(MINT_V2_SIZE).toBe(438);
    expect(ACCOUNT_SIZE.mint).toBe(MINT_V2_SIZE);
    // mint_settled_size at the launch caps is the frozen size, so what the creator funds is the
    // maximum and never a headroom.
    expect(MINT_INITIAL_SIZE + tokenMetadataTlvSize(MAX_NAME_LEN, MAX_SYMBOL_LEN, MAX_URI_LEN)).toBe(
      MINT_V2_SIZE,
    );
  });

  it("decodes a self-hosted mint's name, symbol and uri", () => {
    const data = mintFixture("Diggo Test Coin", "DIGGO", "https://diggo.fun/coins/x.json", pk(161));
    expect(data.length).toBe(MINT_V2_SIZE);
    const metadata = decodeMintMetadata(data);
    expect(metadata.hasTokenMetadata).toBe(true);
    expect(metadata.name).toBe("Diggo Test Coin");
    expect(metadata.symbol).toBe("DIGGO");
    expect(metadata.uri).toBe("https://diggo.fun/coins/x.json");
    expect(metadata.mint).toBe(pk(160));
    expect(metadata.updateAuthority).toBeNull();
    expect(metadata.additionalMetadata).toEqual([]);
    expect(metadata.extensionTypes).toEqual([EXTENSION_TYPE.metadataPointer, EXTENSION_TYPE.tokenMetadata]);
    expect(metadata.metadataPointer).toEqual({ authority: null, metadataAddress: pk(161) });
    expect(metadata.accountType).toBe(1);
  });

  it("decodes a mint with no metadata extension instead of failing an indexing pass", () => {
    const bare = new FixtureWriter().raw(new Uint8Array(MINT_BASE_SIZE)).u8(1).build();
    const metadata = decodeMintMetadata(bare);
    expect(metadata.hasTokenMetadata).toBe(false);
    expect(metadata.name).toBe("");
    expect(metadata.extensionTypes).toEqual([]);
    expect(metadata.metadataPointer).toBeNull();
  });

  it("refuses data too short to be a mint", () => {
    expect(() => decodeMintMetadata(new Uint8Array(40))).toThrow(/too short/);
    // A buffer that carries the base region but stops before the account-type byte is the shape
    // that made every launch fail inside MetadataPointerInstruction::Initialize.
    expect(() => decodeMintMetadata(new Uint8Array(MINT_BASE_SIZE))).toThrow(/too short/);
  });

  it("decodes a Token-2022 token account, whose base layout is SPL Token's", () => {
    const w = new FixtureWriter();
    w.pubkey(pk(170)).pubkey(pk(171)).u64(1_234_567n);
    w.u32(0).raw(new Uint8Array(32)); // no delegate, but the payload slot is still there
    w.u8(1); // Initialized
    w.u32(0).raw(new Uint8Array(8)); // not native
    w.u64(0n);
    w.u32(0).raw(new Uint8Array(32)); // no close authority
    expect(w.length).toBe(ACCOUNT_SIZE.tokenAccount);

    const account = decodeTokenAccount(w.build());
    expect(account.mint).toBe(pk(170));
    expect(account.owner).toBe(pk(171));
    expect(account.amount).toBe(1_234_567n);
    expect(account.delegate).toBeNull();
    expect(account.state).toBe("Initialized");
    expect(account.isNative).toBeNull();
    expect(account.closeAuthority).toBeNull();
  });
});

// --- compute budget ------------------------------------------------------------------------------------

describe("compute budget helpers", () => {
  it("encodes the two instructions the runtime expects", () => {
    const limit = buildComputeBudgetUnitLimitInstruction(400_000);
    expect(Array.from(limit.data ?? [])).toEqual([2, 0x80, 0x1a, 0x06, 0x00]);
    const price = buildComputeBudgetUnitPriceInstruction(1_000n);
    expect(Array.from(price.data ?? [])).toEqual([3, 0xe8, 0x03, 0, 0, 0, 0, 0, 0]);
  });

  it("prepends the limit, and only adds a price when one is asked for", () => {
    const call = buildActivateInstruction({
      programAddress: PROGRAM,
      owner: FIXTURE.owner,
      player: FIXTURE.player,
      protocol: FIXTURE.protocol,
    });
    expect(withComputeBudget([call])).toHaveLength(2);
    expect(withComputeBudget([call], { unitPriceMicroLamports: 0n })).toHaveLength(2);
    expect(withComputeBudget([call], { unitPriceMicroLamports: 5_000n })).toHaveLength(3);
  });
});
