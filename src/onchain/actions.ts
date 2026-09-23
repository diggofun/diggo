/**
 * Every game action, as a wallet-signed transaction.
 *
 * The shape is the same everywhere, and it is the point of v2: read the accounts the program
 * will check, build the instruction from those exact reads, and let the player's own wallet
 * sign it. There is no backend call in this module that decides an outcome, no key it holds,
 * and no path where the server's opinion of the game is what the chain records.
 *
 * Actions only a wallet can take (activation, crew, claims, rolls) are signed by that
 * wallet. Actions anyone may take (advance, seed, settle, expire, graduate, sweep) take a payer
 * and are permissionless by design, so the same builder serves the player and a public crank.
 *
 * Instruction building, PDA derivation and account decoding all come from shared/program.ts and
 * shared/pdas.ts (WS-D), which are the single client transcription of the frozen contract.
 */
import { address, type Address } from "@solana/kit";
import {
  LAUNCH_RENT_LAMPORTS,
  SPONSOR_EVENT_KIND,
  buildActivateInstruction,
  buildAdvanceMineInstruction,
  buildAssignPowerInstruction,
  buildBuyInstruction,
  buildClaimCreatorFeesInstruction,
  buildClaimRewardsInstruction,
  buildCollectOreInstruction,
  buildCommitEpochSeedInstruction,
  buildCrankTipInstruction,
  buildCreateDiscoveryRollInstruction,
  buildExpireOpportunityInstruction,
  buildGraduateMarketInstruction,
  buildInitializePlayerInstruction,
  buildLaunchTokenInstruction,
  buildPoolBuyInstruction,
  buildPoolSellInstruction,
  buildRemovePowerInstruction,
  buildRequestUnbondInstruction,
  buildSellInstruction,
  buildSettleDiscoveryInstruction,
  buildSweepFeesInstruction,
  buildSwitchMineInstruction,
  buildUpgradeCrewInstruction,
  buildWithdrawBondInstruction,
  decodeCoin,
  decodeClockSysvar,
  decodeMiningPosition,
  decodePlayerAccount,
  discoveryDayIndexAt,
  SYSVAR_CLOCK_ADDRESS,
  type DecodedCoin,
  type DecodedPlayerAccount,
  type DecodedSponsorEvent,
  type LaunchTokenArgs,
} from "../../shared/program";
import {
  deriveCoinPda,
  deriveGlobalBudgetPda,
  deriveMintPda,
  deriveOpportunityPda,
  derivePlayerPda,
  derivePositionPda,
  deriveSponsorGrantPda,
} from "../../shared/pdas";
import {
  accountExists,
  fetchAndDecode,
  fetchCoinVenue,
  findOpportunity,
  playerTokenAccount,
  type CoinVenueState,
  type SwapVenue,
} from "./rpc";
import {
  curveSpotPriceLamportsPerUnit,
  poolSpotPriceLamportsPerUnit,
  quoteCurveBuy,
  quoteCurveSell,
  quotePoolBuy,
  quotePoolSell,
  splitPlatformBucket,
  splitFees,
  type FeeSplit,
  type TradeFeeBps,
} from "../../shared/curve";
import { isPendingTransactionError, signSendConfirm, submit, type DiggoWallet, type SubmissionResult } from "./tx";

/** The player has no PlayerAccount PDA yet. */
export class NotInitializedError extends Error {
  constructor() {
    super("Create your player account first.");
    this.name = "NotInitializedError";
  }
}

async function readPlayer(
  programAddress: Address,
  owner: Address,
): Promise<DecodedPlayerAccount | null> {
  return fetchAndDecode(await derivePlayerPda(programAddress, owner), decodePlayerAccount);
}

/** Reads the chain's discovery day from the Clock sysvar, never from the browser clock. */
async function readChainDayIndex(): Promise<number> {
  const clock = await fetchAndDecode(SYSVAR_CLOCK_ADDRESS, decodeClockSysvar);
  if (!clock) throw new Error("Could not read Solana's current chain time.");
  return discoveryDayIndexAt(clock.unixTimestamp);
}

/**
 * The sponsor accounts a subsidised instruction needs. All three travel together: the program
 * reads the event and the grant on the same path, so a vault without them is not a subsidy.
 */
export interface SponsorSubsidy {
  vault: Address;
  event: Address;
  grant: Address;
}

/** Resolves the three sponsor accounts for one event and one subject. */
export async function resolveSubsidy(
  programAddress: Address,
  event: Address,
  vault: Address,
  subject: Address,
): Promise<SponsorSubsidy> {
  return { vault, event, grant: await deriveSponsorGrantPda(programAddress, event, subject) };
}

/** Splits a subsidy into the three builder arguments shared/program.ts expects. */
function sponsorArgs(subsidy: SponsorSubsidy | null | undefined) {
  return {
    sponsorVault: subsidy?.vault ?? null,
    sponsorEvent: subsidy?.event ?? null,
    sponsorGrant: subsidy?.grant ?? null,
  };
}

// --- player creation, activation and ORE ---------------------------------------------------

/**
 * Creates the PlayerAccount PDA. The owner pays its rent, and nothing else: there is no deposit to
 * post, so this one instruction is the whole cost of starting to play. A PlayerAccountSubsidy
 * event can pay that rent from a sponsor vault inside the same instruction, because a PDA cannot
 * be a Signer.
 */
export async function createPlayerAccount(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  subsidy?: SponsorSubsidy | null;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildInitializePlayerInstruction({
      programAddress: params.programAddress,
      owner: params.wallet.address,
      ...sponsorArgs(params.subsidy),
    }),
  ]);
}

/**
 * Idempotent: creates the player account only when the PDA does not exist. Every other action
 * calls this first, so a brand-new wallet is never met with "create your player account first"
 * from a transaction it just tried to send.
 */
export async function ensurePlayerInitialized(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  subsidy?: SponsorSubsidy | null;
}): Promise<{ created: boolean; signature: string | null }> {
  const player = await readPlayer(params.programAddress, params.wallet.address);
  if (player) return { created: false, signature: null };
  return { created: true, signature: await createPlayerAccount(params) };
}

/** Settles accrual, rolls the activation window and applies the streak rule. Free, always. */
export async function activatePlayer(params: {
  programAddress: Address;
  wallet: DiggoWallet;
}): Promise<string> {
  await ensurePlayerInitialized({ programAddress: params.programAddress, wallet: params.wallet });
  return signSendConfirm(params.wallet, [
    buildActivateInstruction({ programAddress: params.programAddress, owner: params.wallet.address }),
  ]);
}

/** Settles lazily accrued ORE into the balance, clamped by the player's storage capacity. */
export async function collectOre(params: {
  programAddress: Address;
  wallet: DiggoWallet;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildCollectOreInstruction({ programAddress: params.programAddress, owner: params.wallet.address }),
  ]);
}

/**
 * Spends ORE on one crew component. The price comes from the program's own curve table, so the
 * number the form showed and the number the chain charges are the same one.
 *
 * `curveTable` is passed only when the timelocked override account exists; while it does not,
 * every instruction falls back to the compiled-in tables.
 */
export async function upgradeCrew(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  component: number;
  curveTable?: Address | null;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildUpgradeCrewInstruction({
      programAddress: params.programAddress,
      owner: params.wallet.address,
      component: params.component,
      curveTable: params.curveTable ?? null,
    }),
  ]);
}

// --- positions and claims -----------------------------------------------------------------

/** Creates the MiningPosition PDA for a coin. No power argument: the program derives it. */
export async function assignPower(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  await ensurePlayerInitialized({ programAddress: params.programAddress, wallet: params.wallet });
  return signSendConfirm(params.wallet, [
    buildAssignPowerInstruction({
      programAddress: params.programAddress,
      owner: params.wallet.address,
      mint: params.mint,
    }),
  ]);
}

/** Settles the index delta and closes the position, refunding its rent to the owner. */
export async function removePower(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildRemovePowerInstruction({
      programAddress: params.programAddress,
      owner: params.wallet.address,
      mint: params.mint,
    }),
  ]);
}

/**
 * Moves the player's position from one coin to another in a single instruction: the old
 * position's index delta is settled, the old PDA is closed, and the new position is created.
 * Activation and streak are untouched.
 */
export async function switchMine(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  fromMint: Address;
  toMint: Address;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildSwitchMineInstruction({
      programAddress: params.programAddress,
      owner: params.wallet.address,
      fromMint: params.fromMint,
      toMint: params.toMint,
    }),
  ]);
}

/** The default pubkey, which is what `active_mine` holds before a player joins anything. */
export const DEFAULT_PUBKEY: Address = address("11111111111111111111111111111111");

/**
 * Puts the player on a mine, whichever instruction that actually needs.
 *
 * A player joining their first mine needs `assign_power`, which creates the MiningPosition PDA.
 * A player moving between mines needs `switch_mine`, which settles the old position and creates
 * the new one in one transaction. The program refuses the wrong one — `assign_power` fails on an
 * existing position and `switch_mine` fails on a missing one — so the choice is made from a read
 * of the position that exists rather than from a guess, and a player who has never joined
 * anything is created first.
 */
export async function joinMine(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<{ signature: string | null; mode: "assign" | "switch" | "none" }> {
  const initialized = await ensurePlayerInitialized({
    programAddress: params.programAddress,
    wallet: params.wallet,
  });
  const owner = params.wallet.address;
  const toCoin = await deriveCoinPda(params.programAddress, params.mint);
  const existing = await fetchAndDecode(
    await derivePositionPda(params.programAddress, toCoin, owner),
    decodeMiningPosition,
  );
  if (existing) {
    // Already on this mine. The instruction would settle a delta of zero and close the position
    // it is about to recreate, so there is nothing to send; report the creation's signature when
    // there was one so the caller still has a transaction to point at.
    return { signature: initialized.signature, mode: "none" };
  }
  const player = await readPlayer(params.programAddress, owner);
  const fromMint = player && player.activeMine !== DEFAULT_PUBKEY ? player.activeMine : null;
  const fromCoin = fromMint
    ? await deriveCoinPda(params.programAddress, fromMint)
    : null;
  const fromPosition = fromCoin
    ? await fetchAndDecode(
        await derivePositionPda(params.programAddress, fromCoin, owner),
        decodeMiningPosition,
      )
    : null;
  if (fromCoin && fromMint && fromPosition) {
    return {
      signature: await switchMine({
        programAddress: params.programAddress,
        wallet: params.wallet,
        fromMint,
        toMint: params.mint,
      }),
      mode: "switch",
    };
  }
  return {
    signature: await assignPower({
      programAddress: params.programAddress,
      wallet: params.wallet,
      mint: params.mint,
    }),
    mode: "assign",
  };
}

/**
 * Claims the block rewards a position has accrued into the player's own token account.
 *
 * Submitted tolerantly: rewards leave the program's reserve only through this instruction and
 * the caller reports the signature afterwards, so a landed payout must not be lost to a slow
 * RPC. A transaction the chain rejected still throws.
 */
export async function claimRewards(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<SubmissionResult> {
  const owner = params.wallet.address;
  return submit(
    params.wallet,
    [
      buildClaimRewardsInstruction({
        programAddress: params.programAddress,
        owner,
        mint: params.mint,
        ownerTokens: await playerTokenAccount(owner, params.mint),
      }),
    ],
    true,
  );
}

// --- legacy bond withdrawal ----------------------------------------------------------------
//
// There is no postBond: a wallet mines at full power with no deposit, so there is nothing to post
// and nothing to unlock. The two actions below are kept for the one case that still has lamports
// in it — a bond posted before the change — and they are the only way those lamports move.

/**
 * Legacy: starts the unbond cooldown on a bond that is already posted. The program requires no
 * active MiningPosition, so this refuses with PositionStillActive until the player leaves their
 * mine — which the UI mirrors by offering "leave mine" first rather than letting the wallet
 * prompt fail.
 */
export async function requestUnbond(params: {
  programAddress: Address;
  wallet: DiggoWallet;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildRequestUnbondInstruction({ programAddress: params.programAddress, owner: params.wallet.address }),
  ]);
}

/**
 * Legacy: returns a posted bond after the cooldown, or returns it to the sponsor vault when the
 * bond came from one. No partial exit exists, so the whole amount moves at once.
 */
export async function withdrawBond(params: {
  programAddress: Address;
  wallet: DiggoWallet;
}): Promise<string> {
  const owner = params.wallet.address;
  const player = await readPlayer(params.programAddress, owner);
  if (!player) throw new NotInitializedError();
  // The vault a sponsor-funded bond returns to is the one the player recorded; passing it back
  // is what lets the program check that the bond goes home rather than to the player.
  const sponsorVault = player.bondSource === "sponsor" ? player.bondSponsorVault : null;
  return signSendConfirm(params.wallet, [
    buildWithdrawBondInstruction({ programAddress: params.programAddress, owner, sponsorVault }),
  ]);
}

// --- discovery ----------------------------------------------------------------------------

/**
 * Creates the player's discovery opportunity for the current window.
 *
 * Nothing random happens here. The roll is written while the epoch's seed is still unknown, the
 * day and week budgets are charged immediately, and the opportunity PDA — one per (coin, owner,
 * window) — is what makes a reroll impossible rather than merely disallowed.
 *
 * The opportunity window still comes from a player read taken immediately before building. The
 * global budget day does not: the program derives it from Solana's Clock sysvar, so a player
 * account that has not rolled since yesterday must not supply yesterday's budget PDA.
 *
 * The clock is read again immediately before signing. If RPC slot lag crosses UTC midnight in
 * that small window, the instruction is rebuilt once with the fresh day. This happens before any
 * wallet signature is requested; a submitted or pending transaction is never retried.
 */
export async function createDiscoveryRoll(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<{ signature: string; opportunity: Address; windowIndex: number }> {
  await ensurePlayerInitialized({ programAddress: params.programAddress, wallet: params.wallet });
  const owner = params.wallet.address;
  const player = await readPlayer(params.programAddress, owner);
  if (!player) throw new NotInitializedError();
  const coin = await deriveCoinPda(params.programAddress, params.mint);
  let dayIndex = await readChainDayIndex();
  let instruction = buildCreateDiscoveryRollInstruction({
      programAddress: params.programAddress,
      owner,
      mint: params.mint,
      windowIndex: player.rollWindow,
      dayIndex,
    });
  const freshDayIndex = await readChainDayIndex();
  if (freshDayIndex !== dayIndex) {
    dayIndex = freshDayIndex;
    instruction = buildCreateDiscoveryRollInstruction({
      programAddress: params.programAddress,
      owner,
      mint: params.mint,
      windowIndex: player.rollWindow,
      dayIndex,
    });
  }
  const signature = await signSendConfirm(params.wallet, [instruction]);
  return {
    signature,
    opportunity: await deriveOpportunityPda(params.programAddress, coin, owner, player.rollWindow),
    windowIndex: player.rollWindow,
  };
}

/**
 * Settles a pending opportunity. Permissionless: the payer may be the owner or any wallet
 * willing to send the transaction, and the opportunity PDA's rent is refunded to whoever
 * settles it. The program recomputes `sha256(seed || owner || window)` itself, so this carries
 * no outcome and the client never needs to know one.
 */
export async function settleDiscovery(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
  /** The wallet the opportunity was created for; defaults to the payer. */
  owner?: Address;
}): Promise<string> {
  const payer = params.wallet.address;
  const owner = params.owner ?? payer;
  const coin = await deriveCoinPda(params.programAddress, params.mint);
  const player = await readPlayer(params.programAddress, owner);
  const opportunity = player ? await findOpportunity(params.programAddress, coin, owner, player) : null;
  if (!opportunity) throw new Error("There is no pending discovery to settle for that wallet.");
  return signSendConfirm(params.wallet, [
    buildSettleDiscoveryInstruction({
      programAddress: params.programAddress,
      payer,
      owner,
      mint: params.mint,
      ownerTokens: await playerTokenAccount(owner, params.mint),
      windowIndex: opportunity.opportunity.windowIndex,
      globalBudget: await deriveGlobalBudgetPda(params.programAddress, opportunity.opportunity.dayIndex),
    }),
  ]);
}

/**
 * Closes a pending opportunity that is past its window. Permissionless, pays nothing and
 * refunds no budget — which is exactly why charging the budget at roll creation is safe.
 */
export async function expireOpportunity(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
  owner: Address;
}): Promise<string> {
  const coin = await deriveCoinPda(params.programAddress, params.mint);
  const player = await readPlayer(params.programAddress, params.owner);
  const opportunity = player ? await findOpportunity(params.programAddress, coin, params.owner, player) : null;
  if (!opportunity) throw new Error("There is no pending discovery to expire for that wallet.");
  return signSendConfirm(params.wallet, [
    buildExpireOpportunityInstruction({
      programAddress: params.programAddress,
      payer: params.wallet.address,
      owner: params.owner,
      mint: params.mint,
      windowIndex: opportunity.opportunity.windowIndex,
    }),
  ]);
}

// --- the crank ----------------------------------------------------------------------------

/**
 * Walks a coin's ledger forward. Permissionless and deterministic: each call is a continuation
 * of the previous one, and the program works with no crank at all because every user-signed
 * instruction opportunistically advances the coin it touches.
 */
export async function advanceMine(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildAdvanceMineInstruction({
      programAddress: params.programAddress,
      payer: params.wallet.address,
      mint: params.mint,
    }),
  ]);
}

/**
 * Reveals the epoch seed by reading the SlotHashes sysvar at exactly the coin's
 * `epoch_seed_target_slot`. Permissionless, one transaction per coin per epoch, and the only
 * source of randomness in the design — it is a recorded fact, not a choice.
 */
export async function commitEpochSeed(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildCommitEpochSeedInstruction({
      programAddress: params.programAddress,
      payer: params.wallet.address,
      mint: params.mint,
    }),
  ]);
}

/**
 * Moves a graduated coin's curve reserves into its locked pool. Permissionless and
 * condition-driven on-chain: once `sol_reserve >= graduation_target` is true, anyone may pay
 * for the pool accounts, and the Worker stops being a privileged trigger.
 */
export async function graduateMarket(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildGraduateMarketInstruction({
      programAddress: params.programAddress,
      payer: params.wallet.address,
      mint: params.mint,
    }),
  ]);
}

/**
 * Sweeps a coin's accrued fees to the fixed destinations held in ProtocolConfig. No
 * instruction anywhere takes a destination argument, so this cannot be pointed anywhere.
 */
export async function sweepFees(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  const coinAddress = await deriveCoinPda(params.programAddress, params.mint);
  const coin = await fetchAndDecode(coinAddress, decodeCoin);
  if (!coin) throw new Error("That coin does not exist on chain.");
  return signSendConfirm(params.wallet, [
    buildSweepFeesInstruction({
      programAddress: params.programAddress,
      payer: params.wallet.address,
      mint: params.mint,
      creator: coin.creator,
    }),
  ]);
}

/** Only the wallet that launched the coin may take its creator fees. */
export async function claimCreatorFees(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildClaimCreatorFeesInstruction({
      programAddress: params.programAddress,
      creator: params.wallet.address,
      mint: params.mint,
    }),
  ]);
}

/**
 * Pays a crank at most `min(max_tip, CRANK_TIP_BPS * accrued fees)` out of the coin's accrued
 * fees only — never a reserve and never the pool. That is what keeps a public crank
 * self-sustaining without costing the protocol anything it was not already paying out.
 */
export async function crankTip(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
  maxTipLamports: bigint;
}): Promise<string> {
  return signSendConfirm(params.wallet, [
    buildCrankTipInstruction({
      programAddress: params.programAddress,
      payer: params.wallet.address,
      mint: params.mint,
      maxTip: params.maxTipLamports,
    }),
  ]);
}

/**
 * The permissionless actions one coin currently allows, in the order a crank would try them.
 * The program decides which of them do work; this is a checklist for a UI, not a policy, and
 * every entry is safe to send even when it is a no-op.
 */
export type CrankAction = "advance" | "commitSeed" | "graduate" | "sweep" | "tip";

export function availableCrankActions(
  coin: Pick<
    DecodedCoin,
    | "graduated"
    | "epochSeedTargetSlot"
    | "epochSeedEpoch"
    | "epochIndex"
    | "solReserve"
    | "graduationTarget"
    | "creatorFeeClaimable"
    | "platformFeeClaimable"
  >,
  currentSlot: bigint,
): CrankAction[] {
  const actions: CrankAction[] = ["advance"];
  const seedArmed = coin.epochSeedTargetSlot > 0n && coin.epochSeedEpoch !== coin.epochIndex;
  if (seedArmed && currentSlot >= coin.epochSeedTargetSlot) actions.push("commitSeed");
  if (!coin.graduated && coin.graduationTarget > 0n && coin.solReserve >= coin.graduationTarget) {
    actions.push("graduate");
  }
  if (coin.creatorFeeClaimable + coin.platformFeeClaimable > 0n) actions.push("sweep", "tip");
  return actions;
}

// --- launch -------------------------------------------------------------------------------

/** Everything the launch form collects, in the units the form collects it in. */
export interface LaunchCoinInput {
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  /** Whole tokens, before the decimals multiplier. */
  totalSupplyWhole: number;
  /** Share of supply the Mining Reserve holds, in bps. */
  reserveBps: number;
  /** Share of supply the Discovery Reserve holds, in bps. */
  discoveryReserveBps: number;
  /** Share of the curve's inventory pre-graduation mining may emit, in bps. */
  curveMiningBps: number;
  curveMiningRunwayDays: number;
  /** Real SOL the curve must collect before the coin graduates, in whole SOL. */
  graduationTargetSol: number;
  blockIntervalSeconds: number;
  epochLengthSeconds: number;
  reductionBps: number;
  /** Whole tokens. */
  minimumRewardWhole: number;
  creatorFeeBps: number;
  platformFeeBps: number;
  /** Optional creator buy executed in the same transaction, in whole SOL. */
  initialBuySol?: number;
}

export interface LaunchCoinResult {
  signature: string;
  mint: Address;
  nonce: number;
  /** True when a sponsor event paid the rent, so the creator paid only the network fee. */
  sponsored: boolean;
}

const solToLamports = (sol: number) => BigInt(Math.round(sol * 1_000_000_000));

/**
 * A display estimate of the network fee for a launch transaction: one signature at roughly
 * 1,000 micro-lamports per compute unit over a launch's compute budget. It is deliberately not a
 * contract value — the program has no opinion about fees — and it is shown next to the rent
 * rather than folded into it so the number a creator is quoted stays the number the chain
 * charges.
 */
export const ESTIMATED_LAUNCH_TX_FEE_LAMPORTS = 130_000n;

/**
 * The nonce the mint PDA is derived from. It is a `u8` and the PDA is
 * `[b"mint", creator, nonce]`, so a creator has 256 possible mints per wallet and a taken one is
 * skipped rather than retried by the program. The scan starts at a random offset so two
 * launches in the same second do not race for the same slot.
 */
async function findFreeMintNonce(programAddress: Address, creator: Address): Promise<number> {
  const start = Math.floor(Math.random() * 256);
  for (let offset = 0; offset < 256; offset += 1) {
    const nonce = (start + offset) & 0xff;
    if (!(await accountExists(await deriveMintPda(programAddress, creator, nonce)))) return nonce;
  }
  throw new Error("This wallet has used all 256 mint slots. Use a different wallet to launch.");
}

/**
 * Launches a coin directly on-chain. The creator pays the rent by default; when a
 * LaunchRentSubsidy event covers it, the sponsor vault pays the mint, Coin and vault rent inside
 * the same instruction and the creator pays only the network fee.
 *
 * There is no backend queue and no vanity grinding: the mint is a program-derived address, so it
 * cannot be ground for a suffix. The caller registers the coin with the indexer afterwards
 * (src/api.ts), which is a cache write and never a gate.
 */
export async function launchCoin(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  input: LaunchCoinInput;
  /** The sponsor accounts, when an active LaunchRentSubsidy event covers this creator. */
  subsidy?: SponsorSubsidy | null;
}): Promise<LaunchCoinResult> {
  const creator = params.wallet.address;
  const nonce = await findFreeMintNonce(params.programAddress, creator);
  const mint = await deriveMintPda(params.programAddress, creator, nonce);
  const scale = 10n ** BigInt(params.input.decimals);
  const args: LaunchTokenArgs = {
    nonce,
    decimals: params.input.decimals,
    name: params.input.name,
    symbol: params.input.symbol,
    uri: params.input.uri,
    totalSupply: BigInt(Math.round(params.input.totalSupplyWhole)) * scale,
    reserveBps: params.input.reserveBps,
    discoveryReserveBps: params.input.discoveryReserveBps,
    curveMiningBps: params.input.curveMiningBps,
    curveMiningRunwayDays: params.input.curveMiningRunwayDays,
    creatorFeeBps: params.input.creatorFeeBps,
    platformFeeBps: params.input.platformFeeBps,
    graduationTarget: solToLamports(params.input.graduationTargetSol),
    blockInterval: Math.round(params.input.blockIntervalSeconds),
    epochLength: Math.round(params.input.epochLengthSeconds),
    reductionBps: params.input.reductionBps,
    minimumReward: BigInt(Math.round(params.input.minimumRewardWhole)) * scale,
  };
  const instructions = [
    buildLaunchTokenInstruction({
      programAddress: params.programAddress,
      creator,
      args,
      mint,
      ...sponsorArgs(params.subsidy),
    }),
  ];
  const initialBuySol = params.input.initialBuySol ?? 0;
  if (initialBuySol > 0) {
    instructions.push(
      buildBuyInstruction({
        programAddress: params.programAddress,
        buyer: creator,
        mint,
        buyerTokens: await playerTokenAccount(creator, mint),
        solIn: solToLamports(initialBuySol),
        // The creator's own buy runs in the launch transaction, before any other trade can move
        // the curve, so there is no third-party price to protect against. A zero floor is
        // therefore honest here; every other buy in this module requires a real one.
        minTokensOut: 0n,
      }),
    );
  }
  let signature: string;
  try {
    signature = await signSendConfirm(params.wallet, instructions);
  } catch (error) {
    if (isPendingTransactionError(error)) error.mint = mint;
    throw error;
  }
  return { signature, mint, nonce, sponsored: Boolean(params.subsidy) };
}

/**
 * What a launch costs the creator, in lamports. The rent is the frozen account table's three
 * accounts (mint, Coin, vault); the transaction fee is an estimate shown next to it. A sponsored
 * launch costs the transaction fee alone, which is the only thing a sponsorship event can ever
 * move.
 */
export function launchCostLamports(options: { sponsored: boolean }): {
  rentLamports: bigint;
  feeLamports: bigint;
  totalLamports: bigint;
} {
  const rentLamports = options.sponsored ? 0n : LAUNCH_RENT_LAMPORTS;
  return {
    rentLamports,
    feeLamports: ESTIMATED_LAUNCH_TX_FEE_LAMPORTS,
    totalLamports: rentLamports + ESTIMATED_LAUNCH_TX_FEE_LAMPORTS,
  };
}

// --- trading ------------------------------------------------------------------------------

/** The slippage floor a form applies when it has a quote: 2%. */
export const DEFAULT_SLIPPAGE_BPS = 200;

export interface SwapQuote {
  venue: SwapVenue;
  side: "buy" | "sell";
  /** What the wallet pays: lamports for a buy, raw base units for a sell. */
  inRaw: bigint;
  /** What the wallet receives: raw base units for a buy, lamports for a sell. */
  outRaw: bigint;
  /** The floor to send on chain, always > 0. */
  minOutRaw: bigint;
  creatorFeeRaw: bigint;
  platformFeeRaw: bigint;
  /**
   * The part of the protocol's own bucket that funds the crank-tip pool at sweep time, when
   * ProtocolConfig.crank_pool_fee_bps is set. It is not a third fee on the trade (CCR-F2): the
   * trader pays creatorFeeRaw + platformFeeRaw, and the bucket splits afterwards.
   */
  crankPoolFeeRaw: bigint;
  /** creatorFeeRaw + platformFeeRaw: what the trade actually pays. */
  feeRaw: bigint;
  slippageBps: number;
}

function applySlippage(amount: bigint, slippageBps: number): bigint {
  const bps = BigInt(Math.min(Math.max(Math.trunc(slippageBps), 0), 10_000));
  return (amount * (10_000n - bps)) / 10_000n;
}

/**
 * Quotes a trade on whichever venue the coin is actually on, using the shared mirror of the
 * program's own math and the program's exact fee order:
 *
 * - a buy's explicit fees come off the top of the gross SOL, so the curve or pool only sees the
 *   net input;
 * - a sell's fees are deducted from the gross curve or pool output, and the wallet receives the
 *   net.
 *
 * Returns null when there is nothing to quote — a non-positive amount, or a graduated coin whose
 * pool reserves have not been read — so a caller can show "unknown" instead of a number this
 * module made up. A quote the program itself would refuse throws QuoteError.
 */
export function quoteSwap(
  state: CoinVenueState,
  side: "buy" | "sell",
  amountRaw: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): SwapQuote | null {
  if (amountRaw <= 0n) return null;
  const venue = state.venue;
  const bps: TradeFeeBps = {
    creatorFeeBps: state.coin.creatorFeeBps,
    platformFeeBps: state.coin.platformFeeBps,
  };
  const build = (inRaw: bigint, outRaw: bigint, fees: FeeSplit): SwapQuote => ({
    venue,
    side,
    inRaw,
    outRaw,
    minOutRaw: applySlippage(outRaw, slippageBps),
    creatorFeeRaw: fees.creatorFee,
    platformFeeRaw: fees.platformFee,
    crankPoolFeeRaw: splitPlatformBucket(fees.platformFee, state.crankPoolFeeBps).crankPool,
    feeRaw: fees.totalFee,
    slippageBps,
  });

  if (venue === "pool") {
    if (!state.pool) return null;
    if (side === "buy") {
      const fees = splitFees(amountRaw, bps);
      return build(amountRaw, quotePoolBuy(state.pool, fees.net), fees);
    }
    const gross = quotePoolSell(state.pool, amountRaw);
    return build(amountRaw, splitFees(gross, bps).net, splitFees(gross, bps));
  }

  if (side === "buy") {
    const fees = splitFees(amountRaw, bps);
    return build(amountRaw, quoteCurveBuy(state.coin, fees.net), fees);
  }
  const gross = quoteCurveSell(state.coin, amountRaw);
  const fees = splitFees(gross, bps);
  return build(amountRaw, fees.net, fees);
}

/**
 * A form's amount in the units the program counts in: lamports for a buy, raw base units for a
 * sell. One function so the amount a quote was priced on and the amount the instruction carries
 * are the same integer, never two roundings of the same decimal.
 */
export function swapAmountRaw(amount: number, side: "buy" | "sell", decimals: number): bigint {
  if (!Number.isFinite(amount) || amount <= 0) return 0n;
  return side === "buy"
    ? BigInt(Math.round(amount * 1_000_000_000))
    : BigInt(Math.round(amount * 10 ** decimals));
}

/** A trade ready to be signed: the venue the program will accept, and a non-zero floor. */
export interface SwapPlan {
  venue: SwapVenue;
  side: "buy" | "sell";
  amountRaw: bigint;
  minOutRaw: bigint;
  expectedOutRaw: bigint;
  slippageBps: number;
}

/**
 * Thrown when a trade cannot be given a real slippage floor. A caller must treat this as "do not
 * send": a floor of zero is not a trade with no slippage protection, it is a standing offer to be
 * filled at any price.
 */
export class QuoteUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuoteUnavailableError";
  }
}

/**
 * The only place a trade becomes amounts to send. Every rejection here is a trade that would
 * otherwise have gone out unprotected: an unreadable venue, a venue that prices the trade at
 * nothing, or a quote so small that slippage truncates the floor to zero.
 */
export function planSwap(
  state: CoinVenueState,
  side: "buy" | "sell",
  amountRaw: bigint,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): SwapPlan {
  if (amountRaw <= 0n) throw new QuoteUnavailableError("Enter an amount to trade.");
  let quote: SwapQuote | null;
  try {
    quote = quoteSwap(state, side, amountRaw, slippageBps);
  } catch (error) {
    throw new QuoteUnavailableError(
      error instanceof Error ? error.message : "This trade could not be priced.",
    );
  }
  if (!quote) {
    throw new QuoteUnavailableError(
      state.venue === "pool"
        ? "This coin's locked pool could not be read, so there is no price to trade against yet. Retry in a moment."
        : "Could not price this trade against the curve, so nothing was sent. Retry in a moment.",
    );
  }
  if (quote.minOutRaw <= 0n) {
    throw new QuoteUnavailableError(
      "This trade is too small to protect against slippage. Increase the amount.",
    );
  }
  return {
    venue: quote.venue,
    side: quote.side,
    amountRaw: quote.inRaw,
    minOutRaw: quote.minOutRaw,
    expectedOutRaw: quote.outRaw,
    slippageBps: quote.slippageBps,
  };
}

/**
 * Spot price in SOL per whole token, from the venue that actually backs the price. Null when the
 * venue's reserves are not readable, so a caller falls back to the indexed price instead of
 * displaying a zero.
 */
export function venueSpotPriceSol(state: CoinVenueState, decimals: number): number | null {
  const perUnit =
    state.venue === "pool"
      ? state.pool
        ? poolSpotPriceLamportsPerUnit(state.pool)
        : null
      : curveSpotPriceLamportsPerUnit(state.coin);
  if (perUnit === null) return null;
  return (perUnit * 10 ** decimals) / 1_000_000_000;
}

/**
 * The instruction for one trade, on one venue. Pure, so the routing it decides can be asserted
 * without a wallet or an RPC.
 */
export function buildSwapInstruction(params: {
  programAddress: Address;
  trader: Address;
  traderTokens: Address;
  mint: Address;
  venue: SwapVenue;
  side: "buy" | "sell";
  amountRaw: bigint;
  minOutRaw: bigint;
}) {
  const { programAddress, trader, traderTokens, mint, venue, side, amountRaw, minOutRaw } = params;
  if (venue === "pool") {
    return side === "buy"
      ? buildPoolBuyInstruction({
          programAddress,
          buyer: trader,
          mint,
          buyerTokens: traderTokens,
          solIn: amountRaw,
          minTokensOut: minOutRaw,
        })
      : buildPoolSellInstruction({
          programAddress,
          seller: trader,
          mint,
          sellerTokens: traderTokens,
          tokensIn: amountRaw,
          minSolOut: minOutRaw,
        });
  }
  return side === "buy"
    ? buildBuyInstruction({
        programAddress,
        buyer: trader,
        mint,
        buyerTokens: traderTokens,
        solIn: amountRaw,
        minTokensOut: minOutRaw,
      })
    : buildSellInstruction({
        programAddress,
        seller: trader,
        mint,
        sellerTokens: traderTokens,
        tokensIn: amountRaw,
        minSolOut: minOutRaw,
      });
}

/**
 * Prices a trade against the chain again and then sends it, with the floor from that fresh
 * quote. The quote a form is displaying can be seconds old and the account it came from can have
 * failed to read at all; in both cases signing with a stale floor is the failure this exists to
 * make impossible.
 */
export async function executeSwap(params: {
  programAddress: Address;
  wallet: DiggoWallet;
  mint: Address;
  side: "buy" | "sell";
  /** Whole SOL to pay for a buy, whole tokens to sell for a sell. */
  amount: number;
  decimals: number;
  slippageBps?: number;
}): Promise<{
  signature: string;
  /** What the indexer should record, as an exact decimal string. */
  recordedAmount: string;
  plan: SwapPlan;
  state: CoinVenueState;
}> {
  const amountRaw = swapAmountRaw(params.amount, params.side, params.decimals);
  if (amountRaw <= 0n) throw new QuoteUnavailableError("Enter an amount to trade.");
  const state = await fetchCoinVenue(params.programAddress, params.mint);
  if (!state) {
    throw new QuoteUnavailableError(
      "This coin's on-chain state could not be read, so the trade was not sent. Retry in a moment.",
    );
  }
  const plan = planSwap(state, params.side, amountRaw, params.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  const trader = params.wallet.address;
  const instruction = buildSwapInstruction({
    programAddress: params.programAddress,
    trader,
    traderTokens: await playerTokenAccount(trader, params.mint),
    mint: params.mint,
    venue: plan.venue,
    side: plan.side,
    amountRaw: plan.amountRaw,
    minOutRaw: plan.minOutRaw,
  });
  const signature = await signSendConfirm(params.wallet, [instruction]);
  return {
    signature,
    recordedAmount: rawAmountToDecimal(
      plan.side === "buy" ? plan.expectedOutRaw : plan.amountRaw,
      params.decimals,
    ),
    plan,
    state,
  };
}

/**
 * A raw base-unit amount as an exact decimal string, without going through a float.
 * `Number(raw) / 10 ** decimals` rounds anything above 2^53, which is a real token amount for a
 * nine-decimal mint: the index would record a number nobody traded.
 */
export function rawAmountToDecimal(raw: bigint, decimals: number): string {
  const places = Number.isFinite(decimals) && decimals > 0 ? Math.floor(decimals) : 0;
  const scale = 10n ** BigInt(places);
  const whole = raw / scale;
  const fraction = raw - whole * scale;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction.toString().padStart(places, "0").replace(/0+$/, "")}`;
}

// --- sponsorship, as the UI sees it --------------------------------------------------------

/**
 * One sponsor event with the address it lives at. Events are PDAs keyed on (vault, event_id) and
 * there is deliberately no on-chain registry that enumerates them, so a client learns about them
 * from the indexer and then reads each one here. Reading it is what makes the answer
 * authoritative: the indexer's row says an event exists, and this says whether it is spending
 * right now.
 */
export interface SponsorEventView {
  eventId: number;
  address: Address;
  vault: Address;
  decoded: DecodedSponsorEvent;
}

/** The lamports an event may still spend. */
export function sponsorEventRemaining(event: DecodedSponsorEvent): bigint {
  const remaining = event.budgetLamports - event.spentLamports;
  return remaining > 0n ? remaining : 0n;
}

/**
 * Whether the event is spending right now: inside its window, not paused, and with budget left.
 * The program enforces all three; the UI mirrors them so a creator can be told "Sponsored" before
 * they sign rather than after.
 */
export function sponsorEventActive(event: DecodedSponsorEvent, nowSeconds: number): boolean {
  return (
    !event.paused &&
    sponsorEventRemaining(event) > 0n &&
    BigInt(nowSeconds) >= event.startAt &&
    BigInt(nowSeconds) <= event.endAt
  );
}

/**
 * The event a launch would actually be paid by: the active event of the right kind with the most
 * budget left. It is a choice among equally valid sponsors, never a judgement about the coin —
 * sponsorship can move rent and fees and nothing else.
 */
export function selectSponsorEvent(
  events: SponsorEventView[],
  kind: number,
  nowSeconds: number,
): SponsorEventView | null {
  const eligible = events.filter(
    (view) => view.decoded.kind === kind && sponsorEventActive(view.decoded, nowSeconds),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, view) =>
    sponsorEventRemaining(view.decoded) > sponsorEventRemaining(best.decoded) ? view : best,
  );
}

/**
 * Whether a launch by this creator would be sponsored, and by which event.
 *
 * The per-coin limit is checked against the event's own remaining budget rather than against a
 * grant, because the grant for this coin does not exist until the launch creates it: the program
 * enforces the real per-coin limit at that moment. An event whose remaining budget is below one
 * launch's rent therefore cannot be shown as covering it.
 */
export function findLaunchSubsidy(
  events: SponsorEventView[],
  nowSeconds: number,
): SponsorEventView | null {
  const event = selectSponsorEvent(events, SPONSOR_EVENT_KIND.launchRentSubsidy, nowSeconds);
  if (!event) return null;
  const limit =
    event.decoded.perCoinLimitLamports > 0n
      ? event.decoded.perCoinLimitLamports
      : event.decoded.budgetLamports;
  return sponsorEventRemaining(event.decoded) >= limit && limit >= LAUNCH_RENT_LAMPORTS
    ? event
    : null;
}

/** The same question for a player's own account rent. */
export function findPlayerSubsidy(
  events: SponsorEventView[],
  kind: number,
  nowSeconds: number,
  minimumLamports: bigint,
): SponsorEventView | null {
  const event = selectSponsorEvent(events, kind, nowSeconds);
  if (!event) return null;
  return sponsorEventRemaining(event.decoded) >= minimumLamports ? event : null;
}
