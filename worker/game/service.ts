import { DIGGO_CONFIG, type CrewComponent } from "../../shared/config";
import { upgradeOreCost } from "../../shared/crew";
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
import { gameChainMode, TOKEN_SCALE, type GameCoin, type GamePlayerState } from "./contracts";
import { d1GameStore } from "./d1-store";
import {
  accrueMining,
  applyGameActivation,
  DISCOVERY_MIN_WALLET_AGE_SECONDS,
  discoveryEpoch,
  discoveryId,
  isPortfolioEligible,
  pickDiscoveryMint,
  playerCrewPower,
  releasedMiningAllocation,
  weekIndex,
  type ReferralCreditResult,
} from "./rules";
import { starterCrew, type GameClaim, type GameStore, type ReferralCreditRecord } from "./store";

const COMPONENTS: readonly CrewComponent[] = ["miners", "drills", "carts", "foreman", "storage"];

export interface GameHandlerContext {
  env: GameEnv;
  services: GameServices;
  store?: GameStore;
  now?: () => number;
}

function unixNow(context: GameHandlerContext): number {
  return Math.floor((context.now ?? Date.now)());
}

function contextStore(context: GameHandlerContext): GameStore {
  return context.store ?? d1GameStore(context.env.DB);
}

type GamePlayerStateLike = GamePlayerState;

function serializeClaim(claim: GameClaim) {
  return {
    id: claim.id,
    mint: claim.mint,
    amount: claim.amount.toString(),
    amountWhole: Number(claim.amount) / Number(TOKEN_SCALE),
    kind: claim.kind,
    status: claim.status,
    signature: claim.signature,
    createdAt: claim.createdAt,
  };
}

function serializeClaimWithCoin(claim: GameClaim, coin: import("./contracts").GameCoin | null) {
  return { ...serializeClaim(claim), name: coin?.name ?? null, symbol: coin?.symbol ?? null };
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
    if (await isEligibleMine(context, coin, now)) candidates.push(coin);
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
  const store = contextStore(context);
  const now = unixNow(context);
  const player = await ensurePlayer(context, wallet);
  const eligibility = activationEligibility({
    activatedAt: player.activatedAt > 0 ? player.activatedAt : null,
    activeUntil: player.activeUntil > 0 ? player.activeUntil : null,
    lastActivationAt: player.lastActivationAt > 0 ? player.lastActivationAt : null,
    streak: player.streak,
    longestStreak: player.longestStreak,
    streakFreezes: player.streakFreezes,
  }, now);
  if (!eligibility.eligible) return apiError("Activation is not available yet", 409);
  const outcome = applyGameActivation(player, now);
  const currentCoin = player.activeMine ? await context.services.coins.getMine(player.activeMine) : null;
  if (currentCoin) await settleMining(context, player, currentCoin);
  const latestPlayer = (await store.getPlayer(player.wallet)) ?? player;
  const assignedMine = await chooseEligibleMine(context, now, currentCoin);
  if (assignedMine && !(await anchorMiningStart(context, player, assignedMine.mint, now))) {
    return apiError("Mining could not be started; retry", 503, "MINING_ASSIGNMENT_UNAVAILABLE");
  }
  const newDay = player.lastActivationAt <= 0 || Math.floor(now / 86_400) !== Math.floor(player.lastActivationAt / 86_400);
  const updated: GamePlayerStateLike = {
    ...latestPlayer,
    activatedAt: outcome.window.activatedAt,
    activeUntil: outcome.window.activeUntil,
    lastActivationAt: now,
    streak: outcome.streak,
    longestStreak: outcome.longestStreak,
    streakFreezes: outcome.freezes,
    activeDays: player.activeDays + (newDay ? 1 : 0),
    validActivations: player.validActivations + (newDay ? 1 : 0),
    oreBalance: player.oreBalance + outcome.rewards.ore,
    oreEarned: player.oreEarned + outcome.rewards.ore,
    activeMine: assignedMine?.mint ?? null,
    activeMiningPower: assignedMine ? playerCrewPower(latestPlayer) : 0,
  };
  const saved = await persistPlayer(context, store, updated);
  return json({ player: saved, ore: saved.oreBalance });
}

export async function handleUpgrade(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Crew upgrades are handled by the native path");
  const wallet = await authenticatedWallet(context, request, "upgrade");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const { component } = await readJson<{ component?: string }>(request);
  if (!COMPONENTS.includes(component as CrewComponent)) return apiError("Invalid crew component");
  const store = contextStore(context);
  const player = await ensurePlayer(context, wallet);
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
  const assignedPower = player.activeMine === coin.mint && isEligibleForBlock(player.activeUntil, now, player.activatedAt)
    ? player.activeMiningPower || playerCrewPower(player)
    : 0;
  if (assignedPower <= 0) return player;
  const store = contextStore(context);
  const balance = await store.getBalance(player.wallet, coin.mint);
  const mine = await store.ensureMine(coin.mint, coin.miningStartsAt, assignedPower, now);
  const visibleEligiblePower = await store.getEligiblePower(coin.mint, now);
  const totalEligiblePower = Math.max(assignedPower, visibleEligiblePower);
  const releasedBefore = releasedMiningAllocation(balance.lastSettledAt || coin.miningStartsAt, coin.miningStartsAt);
  const releasedNow = releasedMiningAllocation(now, coin.miningStartsAt);
  const next = accrueMining({
    mine: coin,
    wallet: player.wallet,
    now,
    lastSettledAt: balance.lastSettledAt || coin.miningStartsAt,
    assignedPower,
    totalEligiblePower,
    releasedBefore,
    releasedNow,
    claimableBefore: balance.claimable,
    reserveRemainingBefore: mine.remaining,
    committedBefore: mine.committed,
  });
  if (next.claimable === balance.claimable) return player;
  const settled = await store.settleMining(
    { ...mine, released: releasedNow, remaining: next.reserveRemaining, committed: next.committed, totalEligiblePower },
    { ...balance, claimable: next.claimable, lastSettledAt: now },
    mine.version,
    balance.claimable,
    now,
  );
  if (!settled) return player;
  return player;
}

/** Settle the current mine, then assign and settle a fallback when it has no capacity left. */
export async function settlePlayerMining(context: GameHandlerContext, player: GamePlayerStateLike): Promise<GamePlayerStateLike> {
  const store = contextStore(context);
  let current = player;
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
}

/**
 * Every reward the wallet has actually accrued, mining and discovery alike, that is ready to pay.
 *
 * Only balances are read here. Nothing is reserved and nothing is debited: the vault refuses to sign
 * a batch it cannot fund, and the game ledger is only advanced once the chain has confirmed. That
 * ordering is what keeps a failed or expired prepare from costing the player their balance.
 */
async function collectClaimable(
  context: GameHandlerContext,
  wallet: string,
  now: number,
): Promise<ClaimableItem[]> {
  const store = contextStore(context);
  const player = await ensurePlayer(context, wallet);
  // Settling first is required, not cosmetic: a mine the player just switched into has an unlocked
  // share that is not yet on the balance row, and claiming without settling would under-pay them.
  await settlePlayerMining(context, player);

  // Keyed by mint, not by claim: mining and discovery can both pay the same coin, and two separate
  // transfers to the same associated token account would be redundant and would trip the vault's
  // one-item-per-mint rule. One transfer settles all of that mint's claims at once.
  const byMint = new Map<string, ClaimableItem>();
  const add = (mint: string, claimId: string, amount: bigint, name: string | null, symbol: string | null) => {
    const existing = byMint.get(mint);
    if (existing) {
      existing.amount += amount;
      existing.claimIds.push(claimId);
      return;
    }
    byMint.set(mint, { mint, amount, claimIds: [claimId], name, symbol });
  };
  const pending = (await store.listClaimsForWallet(wallet)).filter((claim) => claim.status === "PENDING");
  for (const claim of pending) {
    const coin = await context.services.coins.getMine(claim.mint);
    add(claim.mint, claim.id, claim.amount, coin?.name ?? null, coin?.symbol ?? null);
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
      add(created.mint, created.id, created.amount, coin?.name ?? null, coin?.symbol ?? null);
    }
  }
  return [...byMint.values()].sort((a, b) => a.mint.localeCompare(b.mint));
}

/**
 * Prepares one transaction paying every accrued reward, needing exactly one wallet signature.
 *
 * Solana places no limit on how many SPL transfers one message may carry, so the whole balance is
 * one atomic payout rather than a queue of per-coin prompts. The batch is prepared in the vault's
 * own key, so the player authorises the exact instruction set the server computed; they never sign
 * a transfer they did not ask for, and the confirmation below re-derives what actually landed.
 */
export async function handleClaimAll(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Claim all is handled by the native path");
  const wallet = await authenticatedWallet(context, request, "claim-all");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const now = unixNow(context);
  const items = await collectClaimable(context, wallet, now);
  if (items.length === 0) return apiError("No rewards are ready to claim", 409, "NOTHING_TO_CLAIM");
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
          amountWhole: (Number(item.amount) / Number(TOKEN_SCALE)).toString(),
        };
      }),
      signatureCount: 1,
      totalItems: items.length,
      remainingItems: Math.max(0, items.length - batchItems.length),
      complete: items.length <= batchItems.length,
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

export async function handleDiscovery(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Discovery is handled by the native path");
  const wallet = await authenticatedWallet(context, request, "discovery");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const store = contextStore(context);
  const player = await ensurePlayer(context, wallet);
  const now = unixNow(context);
  if (now - player.createdAt < DISCOVERY_MIN_WALLET_AGE_SECONDS) return apiError("Wallet is too new for discovery", 403);
  if (!context.services.wallet) return apiError("Wallet age could not be verified", 403);
  const walletCreatedAt = await context.services.wallet.walletCreatedAt(wallet);
  if (!walletCreatedAt || now - walletCreatedAt < DISCOVERY_MIN_WALLET_AGE_SECONDS) return apiError("Wallet age could not be verified", 403);
  if (!context.services.portfolio || !isPortfolioEligible(await context.services.portfolio.portfolioUsd(wallet))) return apiError("Discovery portfolio requirement not met", 403);
  if (player.activeDays < 5 || player.validActivations < 5) return apiError("Discovery play requirement not met", 403);
  const coins = (await context.services.coins.listActiveMines()).filter((coin) => coin.miningStartsAt <= now && !coin.graduated);
  const epoch = discoveryEpoch(now);
  const secret = context.env.DISCOVERY_SECRET?.trim();
  if (!secret || secret.length < 32) return apiError("Discovery is unavailable until DISCOVERY_SECRET is configured", 503);
  const id = discoveryId({ secret, epoch, wallet });
  const coin = pickDiscoveryMint(id, coins);
  if (!coin) return apiError("No discovery coin is available", 409);
  const mine = await store.ensureMine(coin.mint, coin.miningStartsAt, 1, now);
  const claimId = `discovery:${wallet}:${epoch}`;
  const claim = await store.createDiscovery({ id, wallet, mint: coin.mint, amount: 1_000_000n, claimId, epoch, createdAt: now }, mine.remaining);
  if (!claim) return json({ discovered: false, reason: "already_dispatched_or_reserve_empty" }, { status: 200 });
  return json({ discovered: true, claim: serializeClaimWithCoin(claim, coin) });
}

export interface PlayerGameState extends Omit<GamePlayerState, "activeMine"> {
  chainMode: "meteora" | "native";
  activation: { active: boolean; activeUntil: number };
  discovery: { eligible: boolean; epoch: number; portfolioUsd: number | null };
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
  // The button is driven by what would actually be paid: balances with something in them plus
  // discovery and other claims already reserved but not yet transferred.
  const pendingClaimable = balances.filter((entry) => entry.claimable > 0n).length +
    (await store.listClaimsForWallet(wallet)).filter((claim) => claim.status === "PENDING").length;
  const balanceViews = await Promise.all(balances.map(async (entry) => {
    const metadata = await context.services.coins.getMine(entry.mint);
    return {
      mint: entry.mint,
      name: metadata?.name ?? null,
      symbol: metadata?.symbol ?? null,
      claimable: entry.claimable.toString(),
      amountWhole: Number(entry.claimable) / Number(TOKEN_SCALE),
      lastSettledAt: entry.lastSettledAt,
    };
  }));
  const walletCreatedAt = context.services.wallet ? await context.services.wallet.walletCreatedAt(wallet) : null;
  const portfolioUsd = context.services.portfolio ? await context.services.portfolio.portfolioUsd(wallet) : null;
  const eligible = Boolean(walletCreatedAt && now - walletCreatedAt >= DISCOVERY_MIN_WALLET_AGE_SECONDS) &&
    player.activeDays >= 5 && player.validActivations >= 5 && isPortfolioEligible(portfolioUsd ?? 0);
  return {
    ...settledPlayer,
    crew: { ...player.crew },
    chainMode: gameChainMode(context.env),
    activation: { active: isEligibleForBlock(player.activeUntil || null, now, player.activatedAt || null), activeUntil: player.activeUntil },
    discovery: { eligible, epoch: discoveryEpoch(now), portfolioUsd },
    activeMine: coin ? {
      coin,
      balance: { claimable: balance?.claimable.toString() ?? "0", amountWhole: Number(balance?.claimable ?? 0n) / Number(TOKEN_SCALE), lastSettledAt: balance?.lastSettledAt ?? 0 },
      reserve: mine ? {
        initial: mine.initialReserve.toString(), released: mine.released.toString(), committed: mine.committed.toString(),
        paid: mine.paid.toString(), remaining: mine.remaining.toString(),
      } : null,
    } : null,
    claims: await Promise.all((await store.listClaims(wallet, 20)).map(async (claim) =>
      serializeClaimWithCoin(claim, await context.services.coins.getMine(claim.mint)))),
    balances: balanceViews,
    claimAll: { supported: true, count: pendingClaimable, signatures: 1 as const, maxItems: MAX_CLAIM_ALL_ITEMS },
  };
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
