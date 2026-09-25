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
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "../http";
import type { GameEnv, GameServices } from "./contracts";
import { gameChainMode, TOKEN_SCALE, type GamePlayerState } from "./contracts";
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
const MAX_CLAIM_ATTEMPTS = 8;

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
  const newDay = player.lastActivationAt <= 0 || Math.floor(now / 86_400) !== Math.floor(player.lastActivationAt / 86_400);
  const updated: GamePlayerStateLike = {
    ...player,
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

async function settleMining(
  context: GameHandlerContext,
  player: GamePlayerStateLike,
  coin: import("./contracts").GameCoin,
): Promise<GamePlayerStateLike> {
  const now = unixNow(context);
  const assignedPower = player.activeMine === coin.mint && isEligibleForBlock(player.activeUntil, now)
    ? player.activeMiningPower || playerCrewPower(player)
    : 0;
  if (assignedPower <= 0) return player;
  const store = contextStore(context);
  const balance = await store.getBalance(player.wallet, coin.mint);
  const mine = await store.ensureMine(coin.mint, coin.miningStartsAt, assignedPower, now);
  const releasedBefore = releasedMiningAllocation(balance.lastSettledAt || coin.miningStartsAt, coin.miningStartsAt);
  const releasedNow = releasedMiningAllocation(now, coin.miningStartsAt);
  const next = accrueMining({
    mine: coin,
    wallet: player.wallet,
    now,
    lastSettledAt: balance.lastSettledAt || coin.miningStartsAt,
    assignedPower,
    totalEligiblePower: mine.totalEligiblePower,
    releasedBefore,
    releasedNow,
    claimableBefore: balance.claimable,
    reserveRemainingBefore: mine.remaining,
    committedBefore: mine.committed,
  });
  if (next.claimable === balance.claimable) return player;
  const settled = await store.settleMining(
    { ...mine, released: releasedNow, remaining: next.reserveRemaining, committed: next.committed },
    { ...balance, claimable: next.claimable, lastSettledAt: now },
    mine.version,
    balance.claimable,
    now,
  );
  if (!settled) return player;
  return player;
}

export async function handleClaim(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Claims are handled by the native path");
  const wallet = await authenticatedWallet(context, request, "claim");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const { mint } = await readJson<{ mint?: string }>(request);
  if (!isBase58Address(mint)) return apiError("Invalid mint");
  const store = contextStore(context);
  const player = await ensurePlayer(context, wallet);
  const coin = await context.services.coins.getMine(mint);
  if (!coin) return apiError("Mine not found", 404);
  const settled = await settleMining(context, player, coin);
  if (coin.graduated) {
    const pending = (await store.listPendingClaims(MAX_CLAIM_ATTEMPTS))
      .find((claim) => claim.kind === "MINING" && claim.mint === mint && claim.wallet === wallet);
    if (pending) {
      try {
        const payout = await context.services.payout.prepare(mint, wallet, pending.amount, pending.id);
        return json({ claim: serializeClaim(pending), payout, status: "PENDING", settled });
      } catch {
        return json({ claim: serializeClaim(pending), status: "PENDING", settlement: "payout_failed" });
      }
    }
  }
  let balance = await store.getBalance(wallet, mint);
  if (balance.claimable <= 0n) return apiError("No claimable mining balance", 409);
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const claim: GameClaim = {
      id: `mining:${wallet}:${mint}:${balance.lastSettledAt}`,
      wallet,
      mint,
      amount: balance.claimable,
      kind: "MINING",
      status: "PENDING",
      signature: null,
      createdAt: unixNow(context),
    };
    const created = await store.createClaim(claim, balance.claimable);
    if (!created) {
      const current = await store.getBalance(wallet, mint);
      if (current.claimable === 0n) return json({ claim: serializeClaim((await store.getClaim(claim.id)) ?? claim), status: "PENDING" });
      balance = current;
      continue;
    }
    if (coin.graduated) {
      try {
        const payout = await context.services.payout.prepare(mint, wallet, created.amount, created.id);
        return json({ claim: serializeClaim(created), payout, status: "PENDING", settled });
      } catch {
        return json({ claim: serializeClaim(created), status: "PENDING", settlement: "payout_failed" });
      }
    }
    return json({ claim: serializeClaim(created), status: "PENDING" });
  }
  return apiError("Mining state changed; retry claim", 409);
}

export async function handleClaimConfirmation(context: GameHandlerContext, request: Request): Promise<Response> {
  if (gameChainMode(context.env) !== "meteora") return apiError("Claims are handled by the native path");
  const wallet = await authenticatedWallet(context, request, "claim-confirm");
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ claimId?: string; signature?: string }>(request);
  const claimId = body.claimId?.trim() ?? "";
  const signature = body.signature?.trim() ?? "";
  if (!claimId || !isBase58Address(signature)) return apiError("Claim id and a valid transaction signature are required");
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
  const id = discoveryId({ secret: context.env.DISCOVERY_SECRET ?? "diggo-development", epoch, wallet });
  const coin = pickDiscoveryMint(id, coins);
  if (!coin) return apiError("No discovery coin is available", 409);
  const mine = await store.ensureMine(coin.mint, coin.miningStartsAt, 1, now);
  const claimId = `discovery:${wallet}:${epoch}`;
  const claim = await store.createDiscovery({ id, wallet, mint: coin.mint, amount: 1_000_000n, claimId, epoch, createdAt: now }, mine.remaining);
  if (!claim) return json({ discovered: false, reason: "already_dispatched_or_reserve_empty" }, { status: 200 });
  return json({ discovered: true, claim: serializeClaim(claim) });
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
  const coin = player.activeMine ? await context.services.coins.getMine(player.activeMine) : null;
  const balance = coin ? await store.getBalance(wallet, coin.mint) : null;
  const mine = coin ? await store.getMine(coin.mint) : null;
  const walletCreatedAt = context.services.wallet ? await context.services.wallet.walletCreatedAt(wallet) : null;
  const portfolioUsd = context.services.portfolio ? await context.services.portfolio.portfolioUsd(wallet) : null;
  const eligible = Boolean(walletCreatedAt && now - walletCreatedAt >= DISCOVERY_MIN_WALLET_AGE_SECONDS) &&
    player.activeDays >= 5 && player.validActivations >= 5 && isPortfolioEligible(portfolioUsd ?? 0);
  return {
    ...player,
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
    claims: (await store.listClaims(wallet, 20)).map(serializeClaim),
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
