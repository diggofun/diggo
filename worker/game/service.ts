import { DIGGO_CONFIG, type CrewComponent } from "../../shared/config";
import { upgradeOreCost } from "../../shared/crew";
import { onchainOreCapacity, onchainStoreOre } from "../../shared/ore";
import { activationEligibility, isEligibleForBlock } from "../../shared/streak";
import {
  consumeChallengeNonce,
  issueChallenge,
  loadChallenge,
  sessionWallet,
  verifyWalletSignature,
} from "../auth";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, isBase58Signature, json, readJson } from "../http";
import type { GameEnv, GameServices } from "./contracts";
import { BOOST_WEIGHT } from "../../shared/boost";
import { coinDecimals, coinReserve, gameChainMode, isPayableCoin, wholeAmount, type GameCoin, type GamePlayerState } from "./contracts";
import { d1GameStore } from "./d1-store";
import {
  accrueMining,
  activationBonusOre,
  applyGameActivation,
  discoveryEpoch,
  discoveryId,
  evaluateClaimRequirements,
  type ClaimRequirements,
  miningSettlementWindow,
  pickDiscoveryMint,
  playerCrewPower,
  releasedOnSchedule,
  settleShiftOre,
  unixSeconds,
  weekIndex,
  type ReferralCreditResult,
} from "./rules";
import { starterCrew, type GameClaim, type GameStore, type ReferralCreditRecord } from "./store";

const COMPONENTS: readonly CrewComponent[] = ["miners", "drills", "carts", "foreman", "storage"];

export interface GameHandlerContext {
  env: GameEnv;
  services: GameServices;
  store?: GameStore;
  /** Test clock in Unix seconds. Production uses the wall clock, also in seconds. */
  now?: () => number;
}

/**
 * The game clock, in Unix seconds. Every stored game timestamp, the 24h shift, the streak grace
 * and the reserve release schedule are seconds; defaulting to `Date.now` (milliseconds) here made
 * every 24h shift last 86.4 seconds and stopped all settlement in production.
 */
function unixNow(context: GameHandlerContext): number {
  return context.now ? Math.floor(context.now()) : unixSeconds();
}

function contextStore(context: GameHandlerContext): GameStore {
  return context.store ?? d1GameStore(context.env.DB);
}

type GamePlayerStateLike = GamePlayerState;

function serializeClaim(claim: GameClaim, coin: GameCoin | null = null) {
  return {
    id: claim.id,
    mint: claim.mint,
    amount: claim.amount.toString(),
    amountWhole: wholeAmount(claim.amount, coin),
    kind: claim.kind,
    status: claim.status,
    signature: claim.signature,
    createdAt: claim.createdAt,
  };
}

function serializeClaimWithCoin(claim: GameClaim, coin: import("./contracts").GameCoin | null) {
  return { ...serializeClaim(claim, coin), name: coin?.name ?? null, symbol: coin?.symbol ?? null, sponsored: coin?.sponsored === true };
}

async function authenticatedWallet(context: GameHandlerContext, request: Request, action: string): Promise<string | null> {
  const wallet = await sessionWallet(request, context.env);
  if (!wallet) return null;
  if (!(await checkRateLimit(request, context.env, `game-${action}`, 30))) return null;
  if (!(await checkWalletRateLimit(context.env, wallet, `game-${action}`, 30, 60))) return null;
  return wallet;
}

async function ensurePlayer(context: GameHandlerContext, wallet: string) {
  const store = contextStore(context);
  const now = unixNow(context);
  const existing = await store.getPlayer(wallet);
  if (existing) return existing;
  return store.ensurePlayer(wallet, now, starterCrew());
}

async function persistPlayer(context: GameHandlerContext, store: GameStore, player: GamePlayerStateLike): Promise<GamePlayerStateLike> {
  const version = await store.playerVersion(player.wallet);
  if (!(await store.savePlayer(player, version))) throw new Error("Game state changed");
  return (await store.getPlayer(player.wallet)) ?? player;
}

/**
 * Books the ORE the current shift has dug since the last settlement. The version is read before
 * the row, so a concurrent write makes the guarded save fail instead of overwriting newer state;
 * the next settlement then books the same interval from the unchanged cursor.
 */
export async function settlePlayerOre(context: GameHandlerContext, player: GamePlayerStateLike): Promise<GamePlayerStateLike> {
  const store = contextStore(context);
  const now = unixNow(context);
  if (!settleShiftOre(player, now)) return player;
  const version = await store.playerVersion(player.wallet);
  const fresh = (await store.getPlayer(player.wallet)) ?? player;
  const settlement = settleShiftOre(fresh, now);
  if (!settlement) return fresh;
  const updated = { ...fresh, oreBalance: settlement.oreBalance, oreEarned: settlement.oreEarned, lastOreAt: settlement.lastOreAt };
  if (!(await store.savePlayer(updated, version))) return (await store.getPlayer(player.wallet)) ?? fresh;
  return (await store.getPlayer(player.wallet)) ?? updated;
}

function secureRandomIndex(length: number): number {
  if (!Number.isSafeInteger(length) || length <= 0 || length > 0x1_0000_0000) {
    throw new Error("No eligible mine is available");
  }
  const range = 0x1_0000_0000;
  const limit = range - (range % length);
  const bytes = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(bytes);
    if (bytes[0] < limit) return bytes[0] % length;
  }
}

async function hasReserve(context: GameHandlerContext, mint: string): Promise<boolean> {
  const mine = await contextStore(context).getMine(mint);
  return !mine || mine.remaining > 0n;
}

async function isEligibleMine(context: GameHandlerContext, coin: GameCoin, now: number): Promise<boolean> {
  return !coin.graduated && coin.miningStartsAt <= now && await hasReserve(context, coin.mint);
}

async function chooseEligibleMine(context: GameHandlerContext, now: number, current?: GameCoin | null): Promise<GameCoin | null> {
  if (current && await isEligibleMine(context, current, now)) return current;
  const candidates: GameCoin[] = [];
  for (const coin of await context.services.coins.listActiveMines()) {
    if (!(await isEligibleMine(context, coin, now))) continue;
    // A paid boost makes a mine BOOST_WEIGHT times as likely to be picked.
    const weight = coin.boostedUntil !== undefined && coin.boostedUntil > now ? BOOST_WEIGHT : 1;
    for (let copy = 0; copy < weight; copy += 1) candidates.push(coin);
  }
  return candidates.length > 0 ? candidates[secureRandomIndex(candidates.length)]! : null;
}

async function anchorMiningStart(context: GameHandlerContext, player: GamePlayerStateLike, mint: string, now: number): Promise<boolean> {
  const store = contextStore(context);
  const balance = await store.getBalance(player.wallet, mint);
  if (balance.lastSettledAt > 0) return true;
  if (await store.saveBalance({ ...balance, lastSettledAt: now }, balance.claimable)) return true;
  // A concurrent settlement may have won the guarded write. Only accept it if that write also
  // established a real anchor; otherwise leave the player unassigned rather than allowing a later
  // settlement to fall back to the coin's launch time.
  return (await store.getBalance(player.wallet, mint)).lastSettledAt > 0;
}

/** Assign a mine only when the player has no viable assignment, then persist it with a guarded write. */
export async function ensurePlayerMine(context: GameHandlerContext, player: GamePlayerStateLike): Promise<GamePlayerStateLike> {
  const now = unixNow(context);
  if (!isEligibleForBlock(player.activeUntil, now, player.activatedAt)) {
    if (player.activeMiningPower !== 0) {
      const version = await contextStore(context).playerVersion(player.wallet);
      const inactive = { ...player, activeMiningPower: 0 };
      if (!(await contextStore(context).savePlayer(inactive, version))) return (await contextStore(context).getPlayer(player.wallet)) ?? player;
      return (await contextStore(context).getPlayer(player.wallet)) ?? inactive;
    }
    return player;
  }
  const store = contextStore(context);
  const current = player.activeMine ? await context.services.coins.getMine(player.activeMine) : null;
  // A mine link the player opened wins over the current assignment while that mine can be dug.
  const preferredMint = await store.getPreferredMine(player.wallet);
  if (preferredMint && preferredMint !== player.activeMine) {
    const preferred = await context.services.coins.getMine(preferredMint);
    if (preferred && await isEligibleMine(context, preferred, now)) return switchToMine(context, player, current, preferred, now);
  }
  if (current && await isEligibleMine(context, current, now)) {
    if (player.activeMiningPower > 0) return player;
    const version = await store.playerVersion(player.wallet);
    const repaired = { ...player, activeMiningPower: playerCrewPower(player) };
    if (!(await store.savePlayer(repaired, version))) return (await store.getPlayer(player.wallet)) ?? player;
    return (await store.getPlayer(player.wallet)) ?? repaired;
  }
  const mine = await chooseEligibleMine(context, now);
  if (!mine) {
    if (player.activeMine !== null || player.activeMiningPower > 0) {
      const version = await store.playerVersion(player.wallet);
      const paused = { ...player, activeMine: null, activeMiningPower: 0 };
      if (!(await store.savePlayer(paused, version))) return (await store.getPlayer(player.wallet)) ?? player;
      return (await store.getPlayer(player.wallet)) ?? paused;
    }
    return player;
  }
  if (!(await anchorMiningStart(context, player, mine.mint, now))) return player;
  const version = await store.playerVersion(player.wallet);
  const updated = { ...player, activeMine: mine.mint, activeMiningPower: playerCrewPower(player) };
  if (!(await store.savePlayer(updated, version))) return (await store.getPlayer(player.wallet)) ?? player;
  return (await store.getPlayer(player.wallet)) ?? updated;
}

/**
 * Moves an active crew to `next` mid-shift. The old mine is settled up to now first, and the new
 * mine's clock starts now, so no stretch of time is paid twice or on a mine the crew was not on.
 */
async function switchToMine(
  context: GameHandlerContext,
  player: GamePlayerStateLike,
  current: GameCoin | null,
  next: GameCoin,
  now: number,
): Promise<GamePlayerStateLike> {
  const store = contextStore(context);
  let latest = player;
  if (current && player.activeMine === current.mint && !current.graduated) {
    await settleMining(context, player, current);
    latest = (await store.getPlayer(player.wallet)) ?? player;
  }
  const balance = await store.getBalance(latest.wallet, next.mint);
  if (balance.lastSettledAt < now && !(await store.saveBalance({ ...balance, lastSettledAt: now }, balance.claimable))) return latest;
  const version = await store.playerVersion(latest.wallet);
  const updated = { ...latest, activeMine: next.mint, activeMiningPower: playerCrewPower(latest) };
  if (!(await store.savePlayer(updated, version))) return (await store.getPlayer(latest.wallet)) ?? latest;
  return (await store.getPlayer(latest.wallet)) ?? updated;
}

export async function handleActivationChallenge(
  context: GameHandlerContext,
  request: Request,
): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Game activation is only available in Meteora mode");
  const { wallet } = await readJson<{ wallet?: string }>(request);
  if (!isBase58Address(wallet)) return apiError("Invalid Solana wallet");
  if (!(await checkRateLimit(request, context.env, "game-activation-challenge", 20))) return apiError("Too many requests", 429);
  const challenge = await issueChallenge(context.env, {
    wallet,
    action: "game-activate",
    title: "Activate your Diggo crew",
  });
  return json({ nonce: challenge.nonce, message: challenge.message, expiresAt: challenge.expiresAt });
}

export async function handleActivate(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Activation is handled by the native path");
  const wallet = await authenticatedWallet(context, request, "activate");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ nonce?: string; signature?: string }>(request);
  if (!body.nonce || !body.signature) return apiError("Activation signature required", 400);
  const challenge = await loadChallenge(context.env, `game-activate:challenge:${body.nonce}`);
  if (!challenge || challenge.wallet !== wallet) return apiError("Activation challenge is invalid or expired", 401);
  if (!verifyWalletSignature(wallet, challenge.message, body.signature)) return apiError("Invalid activation signature", 401);
  if ((await consumeChallengeNonce(context.env, { nonce: body.nonce, wallet, action: "game-activate" })) !== "ok") {
    return apiError("Activation challenge was already used", 409);
  }
  const result = await activatePlayer(context, wallet);
  if (!result.ok) return apiError(result.message, result.status, result.code);
  return json({ player: result.player, ore: result.player.oreBalance });
}

export type ActivationResult =
  | { ok: true; player: GamePlayerStateLike }
  | { ok: false; status: number; message: string; code?: string };

/**
 * Everything an authenticated activation does to game state: settle the previous shift, apply
 * the streak and reactivation rules, open a 24h shift, book the activation ORE and assign a mine.
 * The route and the mining backfill both call this, so a replayed history follows the live rules.
 */
export async function activatePlayer(context: GameHandlerContext, wallet: string): Promise<ActivationResult> {
  const store = contextStore(context);
  const now = unixNow(context);
  // Book what the previous shift dug before its window is replaced by the new one.
  const player = await settlePlayerOre(context, await ensurePlayer(context, wallet));
  const eligibility = activationEligibility({
    activatedAt: player.activatedAt > 0 ? player.activatedAt : null,
    activeUntil: player.activeUntil > 0 ? player.activeUntil : null,
    lastActivationAt: player.lastActivationAt > 0 ? player.lastActivationAt : null,
    streak: player.streak,
    longestStreak: player.longestStreak,
    streakFreezes: player.streakFreezes,
  }, now);
  if (!eligibility.eligible) return { ok: false, status: 409, message: "Activation is not available yet" };
  const outcome = applyGameActivation(player, now);
  const currentCoin = player.activeMine ? await context.services.coins.getMine(player.activeMine) : null;
  if (currentCoin) await settleMining(context, player, currentCoin);
  const latestPlayer = (await store.getPlayer(player.wallet)) ?? player;
  const assignedMine = await chooseEligibleMine(context, now, currentCoin);
  if (assignedMine && !(await anchorMiningStart(context, player, assignedMine.mint, now))) {
    return { ok: false, status: 503, message: "Mining could not be started; retry", code: "MINING_ASSIGNMENT_UNAVAILABLE" };
  }
  const newDay = player.lastActivationAt <= 0 || Math.floor(now / 86_400) !== Math.floor(player.lastActivationAt / 86_400);
  const activationOre = onchainStoreOre(
    latestPlayer.oreBalance,
    activationBonusOre(latestPlayer, now) + outcome.rewards.ore,
    onchainOreCapacity(latestPlayer.crew),
  );
  const updated: GamePlayerStateLike = {
    ...latestPlayer,
    activatedAt: outcome.window.activatedAt,
    activeUntil: outcome.window.activeUntil,
    lastActivationAt: now,
    lastOreAt: now,
    streak: outcome.streak,
    longestStreak: outcome.longestStreak,
    streakFreezes: outcome.freezes,
    activeDays: player.activeDays + (newDay ? 1 : 0),
    validActivations: player.validActivations + (newDay ? 1 : 0),
    oreBalance: activationOre.balance,
    oreEarned: latestPlayer.oreEarned + activationOre.stored,
    activeMine: assignedMine?.mint ?? null,
    activeMiningPower: assignedMine ? playerCrewPower(latestPlayer) : 0,
  };
  const saved = await persistPlayer(context, store, updated);
  return { ok: true, player: saved };
}

export async function handleUpgrade(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Crew upgrades are handled by the native path");
  const wallet = await authenticatedWallet(context, request, "upgrade");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const { component } = await readJson<{ component?: string }>(request);
  if (!COMPONENTS.includes(component as CrewComponent)) return apiError("Invalid crew component");
  const store = contextStore(context);
  // Settle first so ORE the crew already dug can pay for the upgrade.
  const player = await settlePlayerOre(context, await ensurePlayer(context, wallet));
  const level = player.crew[component as CrewComponent];
  if (level >= DIGGO_CONFIG.crew.maxLevel) return apiError("Crew component is already at maximum level");
  const cost = upgradeOreCost(component as CrewComponent, level, player.crew.foreman);
  if (player.oreBalance < cost) return apiError("Not enough ORE for this upgrade", 409);
  const updated: GamePlayerStateLike = {
    ...player,
    oreBalance: player.oreBalance - cost,
    crew: { ...player.crew, [component as CrewComponent]: level + 1 },
    activeMiningPower: player.activeUntil > unixNow(context) ? playerCrewPower({ ...player, crew: { ...player.crew, [component as CrewComponent]: level + 1 } }) : 0,
  };
  const saved = await persistPlayer(context, store, updated);
  return json({ player: saved, spent: cost, power: playerCrewPower(saved) });
}

export async function settleMining(
  context: GameHandlerContext,
  player: GamePlayerStateLike,
  coin: import("./contracts").GameCoin,
): Promise<GamePlayerStateLike> {
  const now = unixNow(context);
  if (player.activeMine !== coin.mint) return player;
  const store = contextStore(context);
  const balance = await store.getBalance(player.wallet, coin.mint);
  // The crew digs for the whole shift, online or not: settle up to min(now, activeUntil) even when
  // the shift has already ended, and never across the gap before the current shift started.
  const window = miningSettlementWindow(player, balance.lastSettledAt, coin.miningStartsAt, now);
  if (!window) return player;
  const assignedPower = player.activeMiningPower || playerCrewPower(player);
  if (assignedPower <= 0) return player;
  const mine = await store.ensureMine(coin.mint, coin.miningStartsAt, assignedPower, now, coinReserve(coin));
  const visibleEligiblePower = await store.getEligiblePower(coin.mint, now);
  const totalEligiblePower = Math.max(assignedPower, visibleEligiblePower);
  // Released against the reserve the mine was created with, not the default launch allocation.
  const releasedBefore = releasedOnSchedule(window.start, coin, mine.initialReserve);
  const releasedNow = releasedOnSchedule(window.end, coin, mine.initialReserve);
  const next = accrueMining({
    mine: coin,
    wallet: player.wallet,
    now: window.end,
    lastSettledAt: window.start,
    assignedPower,
    totalEligiblePower,
    releasedBefore,
    releasedNow,
    claimableBefore: balance.claimable,
    reserveRemainingBefore: mine.remaining,
    committedBefore: mine.committed,
  });
  if (next.claimable === balance.claimable) return player;
  const released = releasedNow > mine.released ? releasedNow : mine.released;
  const settled = await store.settleMining(
    {
      ...mine,
      released: released < next.committed ? next.committed : released,
      remaining: next.reserveRemaining,
      committed: next.committed,
      totalEligiblePower,
    },
    { ...balance, claimable: next.claimable, lastSettledAt: window.end },
    mine.version,
    balance.claimable,
    window.end,
  );
  if (!settled) return player;
  return player;
}

/** Settle ORE and the current mine, then assign and settle a fallback when it has no capacity left. */
export async function settlePlayerMining(context: GameHandlerContext, player: GamePlayerStateLike): Promise<GamePlayerStateLike> {
  const store = contextStore(context);
  let current = await settlePlayerOre(context, player);
  const oldCoin = current.activeMine ? await context.services.coins.getMine(current.activeMine) : null;
  if (oldCoin && !oldCoin.graduated) {
    await settleMining(context, current, oldCoin);
    current = (await store.getPlayer(current.wallet)) ?? current;
  }
  current = await ensurePlayerMine(context, current);
  const mine = current.activeMine ? await context.services.coins.getMine(current.activeMine) : null;
  if (mine && !mine.graduated) {
    await settleMining(context, current, mine);
    current = (await store.getPlayer(current.wallet)) ?? current;
  }
  return current;
}

/** @deprecated Individual claims are removed; only the aggregate route is part of the client contract. */
export async function handleClaim(_context: GameHandlerContext, _request: Request): Promise<Response> {
  return apiError("Individual claims are no longer supported", 410, "CLAIM_ALL_REQUIRED");
}

/** Upper bound on transfers in one message. Comfortably under the packed-account ceiling. */
const MAX_CLAIM_ALL_ITEMS = 12;

async function claimAllBatchId(wallet: string, items: ClaimableItem[]): Promise<string> {
  // Derive the id from the exact claim set. A retry with nothing new returns the identical signed
  // batch, while newly accrued rewards cannot hide behind a live batch that does not contain them.
  const state = items.map((item) => ({ claimIds: item.claimIds, mint: item.mint, amount: item.amount.toString() }));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(state)));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `claimall:${wallet}:${hash}`;
}

interface ClaimableItem {
  mint: string;
  amount: bigint;
  /** Every claim settled by this one transfer. A mint can carry both mined and discovery rewards. */
  claimIds: string[];
  name: string | null;
  symbol: string | null;
  decimals: number;
}

/** Why a reward is being held back from this batch. Reported verbatim so the client can explain itself. */
export type PendingClaimReason = "awaiting_graduation" | "vault_unfunded" | "vault_unknown";

export interface PendingClaim {
  mint: string;
  name: string | null;
  symbol: string | null;
  decimals: number;
  amount: bigint;
  claimIds: string[];
  reason: PendingClaimReason;
}

export interface CollectClaimableResult {
  items: ClaimableItem[];
  pending: PendingClaim[];
  /** How many distinct mints a reward is being held for, which is what the UI can act on. */
  pendingMints: number;
}

/**
 * Every reward the wallet has actually accrued that is ready to pay right now.
 *
 * Eligibility is deliberately stricter than "has a balance". A pre-graduation mine pays its
 * rewards out of the bonding curve, and those tokens are not in the vault's SPL account until the
 * graduation leftover is swept, so a reward there is real but not yet payable. Because
 * `prepareBatch` is all-or-nothing and throws on the first mint it cannot fund, one unpayable mint
 * would otherwise cancel a whole batch of correctly-funded graduated rewards. So the batch is
 * assembled only from mints that are both graduated and provably covered by vault inventory, and
 * everything else is left untouched on the balance and returned as an explicit pending reason.
 *
 * Only balances are read here. Nothing is reserved and nothing is debited: the vault refuses to sign
 * a batch it cannot fund, and the game ledger is only advanced once the chain has confirmed. That
 * ordering is what keeps a failed or expired prepare from costing the player their balance.
 */
export async function collectClaimable(
  context: GameHandlerContext,
  wallet: string,
  now: number,
): Promise<CollectClaimableResult> {
  const store = contextStore(context);
  const player = await ensurePlayer(context, wallet);
  // Settling first is required, not cosmetic: a mine the player just switched into has an unlocked
  // share that is not yet on the balance row, and claiming without settling would under-pay them.
  await settlePlayerMining(context, player);

  // Keyed by mint, not by claim: mining and discovery can both pay the same coin, and two separate
  // transfers to the same associated token account would be redundant and would trip the vault's
  // one-item-per-mint rule. One transfer settles all of that mint's claims at once.
  const byMint = new Map<string, ClaimableItem>();
  const add = (mint: string, claimId: string, amount: bigint, coin: GameCoin | null) => {
    const existing = byMint.get(mint);
    if (existing) {
      existing.amount += amount;
      existing.claimIds.push(claimId);
      return;
    }
    byMint.set(mint, { mint, amount, claimIds: [claimId], name: coin?.name ?? null, symbol: coin?.symbol ?? null, decimals: coinDecimals(coin) });
  };
  const pending = (await store.listClaimsForWallet(wallet)).filter((claim) => claim.status === "PENDING");
  for (const claim of pending) {
    const coin = await context.services.coins.getMine(claim.mint);
    add(claim.mint, claim.id, claim.amount, coin);
  }
  for (const entry of await store.listBalances(wallet)) {
    if (entry.claimable <= 0n) continue;
    const coin = await context.services.coins.getMine(entry.mint);
    const claimId = `claimall:${wallet}:${entry.mint}:${entry.lastSettledAt}`;
    const created = await store.createClaim(
      { id: claimId, wallet, mint: entry.mint, amount: entry.claimable, kind: "MINING", status: "PENDING", signature: null, createdAt: now },
      entry.claimable,
    );
    if (created) {
      add(created.mint, created.id, created.amount, coin);
    }
  }

  // Graduation and funding are per-mint facts, so each candidate mint is decided exactly once.
  const candidates = [...byMint.values()].sort((a, b) => a.mint.localeCompare(b.mint));
  const items: ClaimableItem[] = [];
  const held: PendingClaim[] = [];
  for (const candidate of candidates) {
    const coin = await context.services.coins.getMine(candidate.mint);
    if (!coin) {
      // An unknown launch is not proof of graduation; hold rather than promise a payout that may
      // never become fundable. The amount stays on the claim, so nothing is lost by waiting.
      held.push({ ...candidate, reason: "awaiting_graduation" });
      continue;
    }
    if (!isPayableCoin(coin)) {
      held.push({ ...candidate, reason: "awaiting_graduation" });
      continue;
    }
    const inventory = await context.services.payout.vaultInventory(candidate.mint);
    if (inventory === null) {
      held.push({ ...candidate, reason: "vault_unknown" });
      continue;
    }
    if (inventory.available < candidate.amount) {
      held.push({ ...candidate, reason: "vault_unfunded" });
      continue;
    }
    items.push(candidate);
  }
  return {
    items,
    pending: held.sort((a, b) => a.mint.localeCompare(b.mint)),
    pendingMints: held.length,
  };
}

/**
 * Prepares one transaction paying every accrued reward, needing exactly one wallet signature.
 *
 * Solana places no limit on how many SPL transfers one message may carry, so the whole balance is
 * one atomic payout rather than a queue of per-coin prompts. The batch is prepared in the vault's
 * own key, so the player authorises the exact instruction set the server computed; they never sign
 * a transfer they did not ask for, and the confirmation below re-derives what actually landed.
 */
/**
 * Reads the two chain-derived inputs (wallet age, portfolio value) and decides whether the wallet
 * may collect. A source that is missing or reads nothing counts as not met, never as met.
 */
export async function loadClaimRequirements(
  context: GameHandlerContext,
  player: Pick<GamePlayerStateLike, "wallet" | "activeDays" | "validActivations">,
): Promise<ClaimRequirements> {
  const now = unixNow(context);
  const walletCreatedAt = context.services.wallet ? await context.services.wallet.walletCreatedAt(player.wallet) : null;
  const portfolioUsd = context.services.portfolio ? await context.services.portfolio.portfolioUsd(player.wallet) : null;
  return evaluateClaimRequirements({
    walletCreatedAt,
    now,
    activeDays: player.activeDays,
    validActivations: player.validActivations,
    portfolioUsd,
  });
}

export async function handleClaimAll(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Claim all is handled by the native path");
  const wallet = await authenticatedWallet(context, request, "claim-all");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const now = unixNow(context);
  // Mining is open to everyone; collecting is not. This is the one gate between an accrued reward
  // and a signed payout, checked before anything is read or reserved, and it fails closed.
  let requirements: ClaimRequirements;
  try {
    requirements = await loadClaimRequirements(context, await ensurePlayer(context, wallet));
  } catch {
    return apiError("Claim requirements could not be checked right now", 503, "CLAIM_REQUIREMENTS_UNAVAILABLE");
  }
  if (!requirements.met) {
    return json(
      { error: "Claiming opens once your wallet meets the requirements", code: "CLAIM_REQUIREMENTS_NOT_MET", requirements },
      { status: 403 },
    );
  }
  const { items, pending, pendingMints } = await collectClaimable(context, wallet, now);
  const pendingView = pending.map((entry) => ({
    mint: entry.mint,
    name: entry.name,
    symbol: entry.symbol,
    amount: entry.amount.toString(),
    amountWhole: wholeAmount(entry.amount, entry).toString(),
    reason: entry.reason,
  }));
  if (items.length === 0) {
    // A wallet holding only unpayable rewards is a normal, expected state, not an error to hide:
    // the rewards are real and stay on the claim, they just cannot be transferred yet. Reporting
    // the reason is what stops the client implying the player has nothing at all.
    return json(
      {
        error: pendingMints > 0
          ? "Your rewards are not claimable yet"
          : "No rewards are ready to claim",
        code: "NOTHING_TO_CLAIM",
        pendingCount: pendingMints,
        pending: pendingView,
      },
      { status: 409 },
    );
  }
  // Extremely diversified wallets can exceed the conservative packed-message ceiling. Pay the first
  // slice and report the remainder explicitly; after it settles, another call continues naturally.
  const batchItems = items.slice(0, MAX_CLAIM_ALL_ITEMS);
  const batchId = await claimAllBatchId(wallet, batchItems);
  try {
    const batch = await context.services.payout.prepareBatch(
      wallet,
      batchItems.map((item) => ({ claimIds: item.claimIds, mint: item.mint, amount: item.amount })),
      batchId,
    );
    return json({
      batch: { id: batch.id, transaction: batch.transaction, expiresAt: String(batch.expiresAt) },
      items: batch.items.map((item) => {
        const known = batchItems.find((entry) => entry.mint === item.mint);
        return {
          claimIds: item.claimIds,
          mint: item.mint,
          name: known?.name ?? null,
          symbol: known?.symbol ?? null,
          amount: item.amount.toString(),
          amountWhole: wholeAmount(item.amount, known).toString(),
        };
      }),
      signatureCount: 1,
      totalItems: items.length,
      remainingItems: Math.max(0, items.length - batchItems.length),
      complete: items.length <= batchItems.length,
      // Held rewards are reported explicitly so the client can say what is waiting and why,
      // instead of implying that a partial batch was the player's whole balance.
      pendingCount: pendingMints,
      pending: pendingView,
    });
  } catch {
    // A failed preparation reserved nothing on chain and debited nothing in the ledger, so the
    // player can retry unchanged once the underlying cause (vault funding, caps, config) is fixed.
    return apiError("Claim all is not available right now", 503, "CLAIM_ALL_UNAVAILABLE");
  }
}

/**
 * Settles a whole prepared batch from the player's single signature.
 *
 * Confirmation is the only place a reward stops being accrued and starts being paid, and it happens
 * strictly after the chain has been read back. A transaction that has not landed yet returns an empty
 * settled list with 200 so the client polls instead of showing a success it cannot prove.
 */
export async function handleClaimAllConfirm(context: GameHandlerContext, request: Request): Promise<Response> {
  return handleClaimAllConfirmImpl(context, request);
}

async function handleClaimAllConfirmImpl(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Claim all is handled by the native path");
  const wallet = await authenticatedWallet(context, request, "claim-all-confirm");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ batchId?: string; signature?: string }>(request);
  const batchId = body.batchId?.trim() ?? "";
  const signature = body.signature?.trim() ?? "";
  if (!batchId || !isBase58Signature(signature)) return apiError("Batch id and a valid transaction signature are required");
  const store = contextStore(context);
  let settled: GameClaim[];
  try {
    const items = await context.services.payout.confirmBatch(wallet, batchId, signature);
    const pendingIds = new Set(items.flatMap((item) => item.claimIds));
    const allClaims = await store.listClaimsForWallet(wallet);
    settled = allClaims.filter((claim) => pendingIds.has(claim.id));
    const claims = allClaims.filter((claim) => pendingIds.has(claim.id));
    if (claims.some((claim) => claim.status === "PAID" && claim.signature !== signature)) {
      return apiError("Transaction signature does not match the claim", 409);
    }
    if (claims.length !== pendingIds.size) throw new Error("claim batch contains a claim this wallet does not own");
    if (!(await store.markClaimBatchPaid(claims.map((claim) => claim.id), signature))) {
      const current = (await store.listClaimsForWallet(wallet)).filter((claim) => pendingIds.has(claim.id));
      if (current.some((claim) => claim.status !== "PAID")) {
        throw new Error("claim payout settled but the game ledger could not be updated");
      }
    }
    settled = (await store.listClaimsForWallet(wallet)).filter((claim) => pendingIds.has(claim.id));
    for (const claim of settled) {
      if (claim.status !== "PAID") throw new Error("claim batch is not fully settled");
    }
  } catch (error) {
    if (error instanceof Error && /does not match|not found|not awaiting/.test(error.message)) {
      return apiError(error.message, 409);
    }
    throw error;
  }
  if (settled.length === 0) return json({ batch: { id: batchId, status: "PENDING" }, claims: [] });
  const coins = await Promise.all(settled.map((claim) => context.services.coins.getMine(claim.mint)));
  return json({
    batch: { id: batchId, status: "SETTLED", signature },
    claims: settled.map((claim, index) => ({
      ...serializeClaimWithCoin(claim, coins[index] ?? null),
      claimId: claim.id,
      status: "PAID" as const,
      signature,
    })),
  });
}

export async function handleClaimConfirmation(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Claims are handled by the native path");
  const wallet = await authenticatedWallet(context, request, "claim-confirm");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ claimId?: string; signature?: string }>(request);
  const claimId = body.claimId?.trim() ?? "";
  const signature = body.signature?.trim() ?? "";
  if (!claimId || !isBase58Signature(signature)) return apiError("Claim id and a valid transaction signature are required");
  const store = contextStore(context);
  const claim = await store.getClaim(claimId);
  if (!claim || claim.wallet !== wallet || claim.mint.length === 0) return apiError("Claim not found", 404);
  if (claim.status === "PAID") {
    if (claim.signature !== signature) return apiError("Transaction signature does not match the claim", 409);
    return json({ claim: serializeClaim(claim), status: "PAID" });
  }
  if (!(await context.services.payout.confirm(claim.id, signature))) {
    return json({ claim: serializeClaim(claim), status: "PENDING" });
  }
  if (!(await store.markClaimPaid(claim.id, signature))) {
    const settled = await store.getClaim(claim.id);
    if (settled?.status !== "PAID") throw new Error("claim payout settled but the game ledger could not be updated; retry confirmation");
  }
  return json({ claim: serializeClaim((await store.getClaim(claim.id)) ?? claim), status: "PAID" });
}

export type DiscoveryAttempt =
  | { ok: false; status: number; message: string; code?: string }
  | { ok: true; discovered: false; reason: string }
  | { ok: true; discovered: true; claim: GameClaim; coin: GameCoin | null; fresh: boolean };

export function discoveryClaimId(wallet: string, epoch: number): string {
  return `discovery:${wallet}:${epoch}`;
}

/**
 * One discovery roll for one wallet and one daily epoch. Digging is open to every wallet with a
 * live shift - no wallet age, play-day or portfolio gate here - because those only gate the PAYOUT
 * (see loadClaimRequirements and handleClaimAll): a roll just accrues a pending reward. The roll
 * is keyed by (secret, epoch, wallet) and the claim id by (wallet, epoch), so the player's button
 * and the scheduled sweep can both call this and at most one pending reward per wallet per day is
 * ever recorded.
 */
/** A discovery is worth 0.001 of a whole token, whatever the mint's decimals (1_000_000 raw at 9). */
export function discoveryAmount(coin: Pick<GameCoin, "decimals">): bigint {
  const amount = 10n ** BigInt(coinDecimals(coin)) / 1_000n;
  return amount > 0n ? amount : 1n;
}

export async function attemptDiscovery(context: GameHandlerContext, player: GamePlayerStateLike): Promise<DiscoveryAttempt> {
  const store = contextStore(context);
  const wallet = player.wallet;
  const now = unixNow(context);
  // A Discovery pays real tokens, so it may only roll inside a live activation window, using the
  // same boundary that credits mining blocks: activation instant inclusive, activeUntil exclusive.
  // Without this an expired crew could still roll, and since the roll is commit-reveal and
  // idempotent per epoch it would be a one-shot real-token reward for a day never worked.
  if (!isEligibleForBlock(player.activeUntil, now, player.activatedAt)) {
    return { ok: false, status: 403, message: "Activate your crew to roll for a discovery", code: "ACTIVATION_REQUIRED" };
  }
  const secret = context.env.DISCOVERY_SECRET?.trim();
  if (!secret || secret.length < 32) return { ok: false, status: 503, message: "Discovery is unavailable until DISCOVERY_SECRET is configured" };
  const epoch = discoveryEpoch(now);
  const existing = await store.getClaim(discoveryClaimId(wallet, epoch));
  if (existing) return { ok: true, discovered: true, claim: existing, coin: await context.services.coins.getMine(existing.mint), fresh: false };
  const coins = (await context.services.coins.listActiveMines()).filter((coin) => coin.miningStartsAt <= now && !coin.graduated);
  const id = discoveryId({ secret, epoch, wallet });
  const coin = pickDiscoveryMint(id, coins);
  if (!coin) return { ok: false, status: 409, message: "No discovery coin is available" };
  const mine = await store.ensureMine(coin.mint, coin.miningStartsAt, 1, now, coinReserve(coin));
  const claim = await store.createDiscovery(
    { id, wallet, mint: coin.mint, amount: discoveryAmount(coin), claimId: discoveryClaimId(wallet, epoch), epoch, createdAt: now },
    mine.remaining,
  );
  if (!claim) return { ok: true, discovered: false, reason: "already_dispatched_or_reserve_empty" };
  return { ok: true, discovered: true, claim, coin, fresh: true };
}

export async function handleDiscovery(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Discovery is handled by the native path");
  const wallet = await authenticatedWallet(context, request, "discovery");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const player = await ensurePlayer(context, wallet);
  const result = await attemptDiscovery(context, player);
  if (!result.ok) return apiError(result.message, result.status, result.code);
  if (!result.discovered) return json({ discovered: false, reason: result.reason }, { status: 200 });
  return json({ discovered: true, claim: serializeClaimWithCoin(result.claim, result.coin) });
}

export interface ShiftSweepResult {
  checked: number;
  settled: number;
  failed: number;
  oreBooked: number;
  discoveries: number;
}

/**
 * The scheduled settlement pass. Settlement is otherwise lazy (it runs when a player reads their
 * state or activates), so without this a crew that dug while its player was offline showed
 * nothing until the next visit. Every step is idempotent: ORE and tokens advance per-wallet
 * cursors, and a discovery is unique per wallet and day.
 */
export async function settleActiveShifts(context: GameHandlerContext, limit = 200): Promise<ShiftSweepResult> {
  const store = contextStore(context);
  const now = unixNow(context);
  const wallets = await store.listWalletsToSettle(now, limit);
  const result: ShiftSweepResult = { checked: wallets.length, settled: 0, failed: 0, oreBooked: 0, discoveries: 0 };
  const rollDiscoveries = Boolean(context.env.DISCOVERY_SECRET && context.env.DISCOVERY_SECRET.trim().length >= 32);
  for (const wallet of wallets) {
    try {
      const player = await store.getPlayer(wallet);
      if (!player) continue;
      const settled = await settlePlayerMining(context, player);
      result.oreBooked += Math.max(0, settled.oreEarned - player.oreEarned);
      result.settled += 1;
      if (rollDiscoveries && isEligibleForBlock(settled.activeUntil, now, settled.activatedAt)) {
        const attempt = await attemptDiscovery(context, settled);
        if (attempt.ok && attempt.discovered && attempt.fresh) result.discoveries += 1;
      }
    } catch (error) {
      result.failed += 1;
      console.error(JSON.stringify({ event: "game.settle_failed", wallet, error: String(error) }));
    }
  }
  return result;
}

export interface PlayerGameState extends Omit<GamePlayerState, "activeMine"> {
  chainMode: "meteora" | "native";
  activation: { active: boolean; activeUntil: number };
  /** `eligible` is whether a roll can happen right now (a live shift); the payout gate is `claim`. */
  discovery: { eligible: boolean; epoch: number; portfolioUsd: number | null };
  /** What the wallet needs before it can collect, each requirement on its own. */
  claim: ClaimRequirements;
  activeMine: {
    coin: import("./contracts").GameCoin | null;
    balance: { claimable: string; amountWhole: number; lastSettledAt: number };
    reserve: { initial: string; released: string; committed: string; paid: string; remaining: string } | null;
  } | null;
  claims: ReturnType<typeof serializeClaim>[];
  balances: Array<{
    mint: string;
    name: string | null;
    symbol: string | null;
    claimable: string;
    amountWhole: number;
    lastSettledAt: number;
  }>;
  claimAll: { supported: true; count: number; signatures: 1; maxItems: number };
}

/** Full state returned to the integration route, including balances and claim history. */
export async function getPlayerGameState(context: GameHandlerContext, wallet: string): Promise<PlayerGameState> {
  return getPlayerGameStateDetail(context, wallet);
}

export async function getPlayerGameStateDetail(
  context: GameHandlerContext,
  wallet: string,
): Promise<PlayerGameState> {
  const store = contextStore(context);
  const player = await ensurePlayer(context, wallet);
  const now = unixNow(context);
  const settledPlayer = await settlePlayerMining(context, player);
  const coin = settledPlayer.activeMine ? await context.services.coins.getMine(settledPlayer.activeMine) : null;
  const balance = coin ? await store.getBalance(wallet, coin.mint) : null;
  const mine = coin ? await store.getMine(coin.mint) : null;
  const balances = await store.listBalances(wallet);
  // The button is driven by what would actually be paid by one call: mints that are both graduated
  // and covered by vault inventory. A pre-graduation balance is a real reward the player owns, but
  // it cannot be transferred yet, so counting it here would advertise a payout the vault would
  // refuse. The held rewards are reported separately instead of inflating this count.
  const claimableMints = await countPayableMints(context, wallet);
  const balanceViews = await Promise.all(balances.map(async (entry) => {
    const metadata = await context.services.coins.getMine(entry.mint);
    return {
      mint: entry.mint,
      name: metadata?.name ?? null,
      symbol: metadata?.symbol ?? null,
      claimable: entry.claimable.toString(),
      amountWhole: wholeAmount(entry.claimable, metadata),
      lastSettledAt: entry.lastSettledAt,
    };
  }));
  const claim = await loadClaimRequirements(context, player);
  const active = isEligibleForBlock(player.activeUntil || null, now, player.activatedAt || null);
  return {
    ...settledPlayer,
    crew: { ...player.crew },
    chainMode: gameChainMode(context.env),
    activation: { active, activeUntil: player.activeUntil },
    discovery: { eligible: active, epoch: discoveryEpoch(now), portfolioUsd: claim.portfolioUsd },
    claim,
    activeMine: coin ? {
      coin,
      balance: { claimable: balance?.claimable.toString() ?? "0", amountWhole: wholeAmount(balance?.claimable ?? 0n, coin), lastSettledAt: balance?.lastSettledAt ?? 0 },
      reserve: mine ? {
        initial: mine.initialReserve.toString(), released: mine.released.toString(), committed: mine.committed.toString(),
        paid: mine.paid.toString(), remaining: mine.remaining.toString(),
      } : null,
    } : null,
    claims: await Promise.all((await store.listClaims(wallet, 20)).map(async (claim) =>
      serializeClaimWithCoin(claim, await context.services.coins.getMine(claim.mint)))),
    balances: balanceViews,
    claimAll: { supported: true, count: claimableMints, signatures: 1 as const, maxItems: MAX_CLAIM_ALL_ITEMS },
  };
}

/**
 * How many distinct mints a single claim-all call could pay right now.
 *
 * This deliberately reuses the same graduation and funding rule as the payout path rather than
 * counting raw balances, so the number the UI shows is the number the next call can actually move.
 * A vault read that fails is treated as not-payable, because a count is a promise about the next
 * call and an unread chain cannot support one.
 */
async function countPayableMints(context: GameHandlerContext, wallet: string): Promise<number> {
  const store = contextStore(context);
  const mints = new Set<string>();
  for (const balance of await store.listBalances(wallet)) if (balance.claimable > 0n) mints.add(balance.mint);
  for (const claim of await store.listClaimsForWallet(wallet)) if (claim.status === "PENDING") mints.add(claim.mint);
  let payable = 0;
  for (const mint of mints) {
    const coin = await context.services.coins.getMine(mint);
    if (!isPayableCoin(coin)) continue;
    const inventory = await context.services.payout.vaultInventory(mint);
    if (inventory && inventory.available > 0n) payable += 1;
  }
  return payable;
}

export async function creditReferralOre(
  context: GameHandlerContext,
  referrer: string,
  referee: string,
  amount = 250,
  now = Math.floor(Date.now() / 1_000),
): Promise<ReferralCreditResult> {
  if (referrer === referee) return { credited: false, reason: "weekly_cap", amount };
  const normalizedAmount = Number.isSafeInteger(amount) && amount > 0 ? amount : 0;
  if (normalizedAmount === 0) return { credited: false, reason: "weekly_cap", amount };
  const store = contextStore(context);
  const id = `referral:${referrer}:${referee}`;
  const existing = await store.getReferralCredit(id);
  if (existing) return { credited: false, reason: "duplicate", amount };
  await store.ensurePlayer(referrer, now, starterCrew());
  const week = weekIndex(now);
  const record: ReferralCreditRecord = { id, referrer, referee, amount: normalizedAmount, week, createdAt: now };
  if (!(await store.applyReferralCredit(record))) {
    return {
      credited: false,
      reason: (await store.getReferralCredit(id)) ? "duplicate" : "weekly_cap",
      amount,
    };
  }
  const totals = await store.referralWeekTotals(referrer, week);
  return { credited: true, amount: normalizedAmount, creditedThisWeek: totals.count, oreThisWeek: totals.ore };
}
