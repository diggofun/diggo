/**
 * The single HTTP client for the Diggo.fun frontend.
 *
 * Every call goes through request(), which attaches the privacy-conscious per-browser
 * X-Diggo-Device hint (src/device.ts) and relies on the HttpOnly session cookie the Worker sets
 * on /api/auth/verify. Nothing here decides an outcome: discovery rolls, rarities, visual events,
 * block rewards, crew prices and claim eligibility are all decided on chain by instructions the
 * player's own wallet signs (src/solanaProgram.ts), and the Worker is an indexer: it reads those
 * instructions and serves the result. This module carries that result back to the UI and nothing
 * else.
 *
 * That is why there is no activation, roll, claim or upgrade call here any more. Those used to be
 * server decisions, and in v2 there is no backend path that can produce one: the endpoints are
 * gone rather than merely unused, so no future caller can reach for one by accident. The one
 * mutation left is reporting a signature the player's wallet already sent, which the Worker
 * verifies on chain before it records anything.
 *
 * The risk layer stays advisory. /api/verify/challenge and the 403 VERIFICATION_REQUIRED answer
 * still exist, and the UI still shows them, but no on-chain instruction depends on the answer: a
 * flagged player mines, bonds, rolls and claims exactly as an unflagged one does.
 */
import type {
  AchievementView,
  CosmeticsView,
  DiscoveryOpportunity,
  DiscoveryRecord,
  Leaderboards,
  MineInfo,
  MiningAccounting,
  MiningReport,
  NotificationsView,
  PlayerProfile,
  RewardClaimPayout,
  TokenSummary,
} from "../shared/types";
import { startAnalytics } from "./analytics";
import bs58 from "bs58";
import { DEVICE_HEADER, deviceId } from "./device";
import type { ChainMode } from "../shared/meteora";
import { normalizeMeteoraConfigPubkey } from "../shared/meteora";
import type { AdminDashboardPayload } from "../shared/adminDashboard";

/** An HTTP failure carrying the Worker's status and machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  /** The `retry-after` the Worker sent, in seconds, when it sent one (429 answers). */
  readonly retryAfterSec: number | null;

  constructor(message: string, status: number, code: string | null = null, retryAfterSec: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }

  /** True when the risk gate answered 403 VERIFICATION_REQUIRED (spec 52). */
  get verificationRequired(): boolean {
    return this.status === 403 && this.code === "VERIFICATION_REQUIRED";
  }
}

/** The retry-after a 429 carries, in seconds, or null when the Worker sent none. */
function retryAfterSeconds(response: Response): number | null {
  const header = response.headers.get("retry-after");
  if (header === null) return null;
  const value = Number(header);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as
    | (T & { error?: string; message?: string; code?: string })
    | null;
  if (!response.ok) {
    // Two error shapes are in play: worker/http.ts's apiError() sends { error }, while the reward
    // and claim endpoints send the more specific { code, message }. Reading both keeps the code
    // available to callers that branch on it (src/rewardsClaim.ts) instead of collapsing every
    // failure into "Request failed (409)".
    throw new ApiError(
      data?.error ?? data?.message ?? "Request failed (" + response.status + ")",
      response.status,
      data?.code ?? null,
      retryAfterSeconds(response),
    );
  }
  if (data === null) throw new ApiError("Malformed server response", response.status, null);
  return data;
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  form?: FormData;
}

async function request(path: string, options: RequestOptions = {}): Promise<Response> {
  const headers = new Headers();
  headers.set(DEVICE_HEADER, deviceId());
  let body: BodyInit | undefined;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  return fetch(path, {
    method: options.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    credentials: "same-origin",
  });
}

async function getJson<T>(path: string): Promise<T> {
  return parseResponse<T>(await request(path));
}

async function postJson<T>(path: string, body: unknown = {}): Promise<T> {
  return parseResponse<T>(await request(path, { method: "POST", body }));
}

function playerPath(wallet: string, suffix = ""): string {
  return "/api/player/" + encodeURIComponent(wallet) + suffix;
}

export interface DiggoConfig {
  cluster: string;
  chainMode: ChainMode;
  meteoraConfigPubkey: string;
  posthogApiKey?: string;
  posthogHost?: string;
  turnstileSiteKey: string;
  programId: string;
  vanitySuffix: string;
}

export interface Bootstrap {
  tokens: TokenSummary[];
  config: DiggoConfig;
}

/**
 * The Worker's bootstrap payload.
 *
 * It is flat - the token list plus the cluster settings as siblings - and the client folds the
 * settings into the one `config` object the app carries. Reading `data.config` straight off the
 * response (as this used to) yields undefined, which leaves every chain-dependent surface inert:
 * `config.programId` stays empty, so no launch, roll, bond or player read is ever attempted.
 */
interface BootstrapPayload {
  tokens?: TokenSummary[];
  cluster?: string;
  chainMode?: ChainMode;
  meteoraConfigPubkey?: string;
  meteoraConfig?: string | null;
  meteoraDbcConfig?: string | null;
  programId?: string;
  posthogApiKey?: string;
  posthogHost?: string;
  turnstileSiteKey?: string;
  vanitySuffix?: string;
}

export async function getBootstrap(): Promise<Bootstrap> {
  try {
    const data = await getJson<BootstrapPayload>("/api/bootstrap?limit=1000");
    const config: DiggoConfig = {
      cluster: data.cluster === "devnet" ? "devnet" : "mainnet-beta",
      chainMode: data.chainMode === "native" ? "native" : "meteora",
      meteoraConfigPubkey: normalizeMeteoraConfigPubkey(
        data.meteoraConfigPubkey ?? data.meteoraDbcConfig ?? data.meteoraConfig,
      ),
      posthogApiKey: data.posthogApiKey,
      posthogHost: data.posthogHost,
      turnstileSiteKey: data.turnstileSiteKey ?? "",
      programId: data.programId ?? "",
      vanitySuffix: data.vanitySuffix ?? "diggo",
    };
    void startAnalytics(config);
    return { tokens: data.tokens ?? [], config };
  } catch {
    return {
      tokens: [],
      config: {
        cluster: "mainnet-beta",
        chainMode: "meteora",
        meteoraConfigPubkey: "",
        turnstileSiteKey: "",
        programId: "",
        vanitySuffix: "diggo",
      },
    };
  }
}

export async function getToken(mintOrSlug: string): Promise<TokenSummary> {
  const data = await getJson<{ token: TokenSummary }>("/api/tokens/" + encodeURIComponent(mintOrSlug));
  return data.token;
}

export async function getChallenge(wallet: string): Promise<{ nonce: string; message: string }> {
  return postJson("/api/auth/challenge", { wallet });
}

export async function verifyWallet(
  wallet: string,
  nonce: string,
  signature: string,
  referralCode?: string | null,
): Promise<{ wallet: string; expiresIn: number }> {
  const query = referralCode ? "?ref=" + encodeURIComponent(referralCode) : "";
  return postJson("/api/auth/verify" + query, { wallet, nonce, signature });
}

export interface ReferralView {
  id: string;
  referredWallet: string;
  username: string | null;
  joinedAt: number | null;
  volumeLamports: string;
  status: "PENDING" | "QUALIFIED" | "REWARDED" | "REJECTED";
  oreEntitled: number;
  oreCredited: number;
}

export interface ReferralPanel {
  wallet: string;
  code: string;
  link: string;
  cooldownSeconds: number;
  thresholdLamports: string;
  weeklyCap: number;
  totals: { invited: number; pending: number; qualified: number; oreEarned: number; oreCredited: number; skinUnlocked: boolean };
  referrals: ReferralView[];
  page: number;
  pages: number;
}

export async function getReferrals(page = 1): Promise<ReferralPanel> {
  return getJson<ReferralPanel>("/api/referrals?page=" + page);
}

export async function checkReferralCode(code: string): Promise<{ available: boolean; code?: string; message?: string }> {
  return getJson("/api/referrals/code/" + encodeURIComponent(code));
}

export async function saveReferralCode(code: string): Promise<{ code: string; changed: boolean }> {
  return postJson("/api/referrals/code", { code });
}

export async function getWalletSession(): Promise<{ wallet: string } | null> {
  const response = await request("/api/auth/session");
  if (response.status === 401) return null;
  return parseResponse<{ wallet: string }>(response);
}

export async function uploadTokenImage(file: File): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  const data = await parseResponse<{ url: string }>(await request("/api/media", { form }));
  return data.url;
}

/**
 * Registers a coin the caller's wallet just launched directly on-chain (see
 * src/solanaProgram.ts#launchCoinOnChain) so the Worker's D1 cache — and therefore the rest of
 * the site — picks it up. The Worker independently re-reads the mint from chain and rejects the
 * call if the session wallet doesn't match the on-chain creator, so this cannot be used to claim
 * someone else's launch or to inject fake metadata for a token that doesn't exist.
 */
export async function registerLaunchedToken(
  mint: string,
  metadata: { description?: string; imageUrl?: string },
): Promise<TokenSummary> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const data = await postJson<{ token: TokenSummary }>("/api/tokens/register", { mint, ...metadata });
      return data.token;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Could not register the on-chain launch");
      if (!lastError.message.includes("not launched on-chain yet") || attempt === 5) break;
      await new Promise((resolve) => window.setTimeout(resolve, 1_500 * (attempt + 1)));
    }
  }
  throw lastError ?? new Error("Could not register the on-chain launch");
}

/* Mining and crew: indexer reads only (spec 29, 30, 71-75).
 *
 * Activation, the mining report, switching mines and upgrading crew are all on-chain
 * instructions now, signed by the player's wallet — see src/solanaProgram.ts. The Worker reads
 * the accounts those instructions write and serves the result, which is what these functions
 * return. There is deliberately no mutation here: a client that wanted to activate or upgrade
 * through the Worker has no endpoint to call, because the Worker has no way to decide either. */

export async function getMineInfo(mint: string): Promise<MineInfo> {
  const data = await getJson<{ mine: MineInfo }>("/api/mines/" + encodeURIComponent(mint) + "/info");
  return data.mine;
}

/**
 * The player's indexed mining state, which the Worker derives from the on-chain PlayerAccount
 * and MiningPosition. It is a cache of chain state and never an input to an instruction.
 */
export async function getMiningState(wallet: string): Promise<{
  player: PlayerProfile;
  mine: MineInfo | null;
  report: MiningReport | null;
}> {
  return getJson("/api/player/" + encodeURIComponent(wallet) + "/mining");
}

export async function getPlayerProfile(wallet: string): Promise<PlayerProfile> {
  const data = await getJson<{ player: PlayerProfile }>(playerPath(wallet));
  return data.player;
}

/** The small, stable part of the v2 portfolio used by the global header. */
export interface PortfolioSummary {
  mining: {
    streak: number;
    oreWhole: number;
  };
}

/** Fetches a portfolio projection from the shared v2 endpoint. */
export async function getPortfolio<T = PortfolioSummary>(wallet: string): Promise<T> {
  const data = await getJson<{ portfolio: T }>("/api/portfolio/" + encodeURIComponent(wallet));
  return data.portfolio;
}

/* Public usernames (worker/profile.ts). Reading one is public; setting one needs the session. */

export interface PublicProfile {
  wallet: string;
  /** The chosen display name, or null when the player never set one. */
  username: string | null;
}

export async function getProfile(wallet: string): Promise<PublicProfile> {
  return getJson<PublicProfile>("/api/profile/" + encodeURIComponent(wallet));
}

export async function setUsername(username: string): Promise<{ username: string }> {
  return postJson<{ username: string }>("/api/profile/username", { username });
}

/* Reward claims: real token rewards, kept strictly apart from ORE progression (spec 53, 57) */

export type RewardClaimStatus = "ELIGIBLE" | "PENDING" | "CLAIMED" | "HELD" | "EXPIRED";

export interface RewardClaimView {
  id: string;
  mint: string;
  amount: number;
  status: RewardClaimStatus;
  createdAt: number;
  eligibleUntil: number;
  claimedAt: number | null;
  txSignature: string | null;
  accounting: MiningAccounting;
  /**
   * How the settled reward reaches the wallet (spec 57). Always the user-signed claim_rewards
   * route: `ready` means the tokens are still in the mine's reserve and the player's own wallet
   * has to submit the transaction, `txSignature` is set once the backend has verified and
   * recorded it.
   */
  payout?: RewardClaimPayout | null;
}

export interface RewardClaimChallenge {
  nonce: string;
  message: string;
  rewardId: string;
  mint: string;
  amount: number;
  status: RewardClaimStatus;
  eligibleUntil: number;
  accounting: MiningAccounting;
}

export async function getPlayerRewards(wallet: string): Promise<RewardClaimView[]> {
  const data = await getJson<{ claims: RewardClaimView[] }>(playerPath(wallet, "/rewards"));
  return data.claims ?? [];
}

export async function getRewardClaimChallenge(rewardId: string): Promise<RewardClaimChallenge> {
  return postJson("/api/rewards/claim/challenge", { rewardId });
}

export async function claimReward(
  rewardId: string,
  nonce: string,
  signature: string,
): Promise<{ claimed: boolean; alreadyClaimed: boolean; claim: RewardClaimView | null }> {
  return postJson("/api/rewards/claim", { rewardId, nonce, signature });
}

/** What the backend says once it has verified a submitted claim_rewards transaction. */
export interface RewardClaimConfirmation {
  status: "CONFIRMED";
  /** True when this exact signature was already recorded; confirming twice is not an error. */
  idempotent: boolean;
  claim: RewardClaimView | null;
}

/**
 * Reports the transaction the player's own wallet submitted for a settled reward. The backend
 * verifies it on chain before recording anything, so a landed payout is never lost to a slow RPC
 * on the client side; reconciliation treats an unreported signature as a halted mint.
 */
export async function confirmRewardClaimPayout(
  rewardId: string,
  signature: string,
): Promise<RewardClaimConfirmation> {
  return postJson("/api/rewards/claim/confirm", { rewardId, signature });
}

/* Discoveries: the chain decides, the indexer reports (spec 55, 56).
 *
 * A roll is `create_discovery_roll`, an outcome is `settle_discovery` recomputing
 * sha256(epoch_seed || owner || window) on chain, and both are transactions the player's wallet
 * signs. The Worker indexes the DiscoverySettled events and serves the history; it has no roll to
 * author and no outcome to pick, so the endpoints that used to do both are gone. */

export async function getDiscoveries(
  wallet: string,
): Promise<{ discoveries: DiscoveryRecord[]; opportunity: DiscoveryOpportunity | null }> {
  const data = await getJson<{ discoveries?: DiscoveryRecord[]; opportunity?: DiscoveryOpportunity | null }>(
    playerPath(wallet, "/discoveries"),
  );
  return { discoveries: data.discoveries ?? [], opportunity: data.opportunity ?? null };
}

/* Sponsorship: the one surface a creator needs before signing a launch.
 *
 * There is no on-chain registry that enumerates sponsor events — they are PDAs keyed on
 * (vault, event_id) — so a client learns the addresses from the indexer and then reads each
 * event on chain, where the program is the authority on whether it is spending. The indexer
 * answer is a hint; src/solanaProgram.ts#findLaunchSubsidy is the decision. */

export interface SponsorEventSummary {
  /** The vault's own event_count at creation, which is the event PDA's second seed. */
  eventId: number;
  /** The SponsorEvent PDA. */
  event: string;
  /** The SponsorVault PDA the event spends from. */
  vault: string;
  /** 0 launch rent, 1 platform fee waiver, 2 player account, 3 player bond. */
  kind: number;
  startAt: number;
  endAt: number;
  budgetLamports: string;
  spentLamports: string;
  perCoinLimitLamports: string;
  perWalletLimitLamports: string;
  paused: boolean;
}

/**
 * The sponsor events the indexer knows about. A cluster whose indexer does not serve them yet
 * answers with an empty list, which the launch form reads as "the creator pays" — the honest
 * default rather than a promise the chain would not keep.
 */
export async function getSponsorEvents(): Promise<SponsorEventSummary[]> {
  try {
    const data = await getJson<{ events?: SponsorEventSummary[] }>("/api/sponsors/events");
    return data.events ?? [];
  } catch {
    return [];
  }
}

/**
 * The same list for one sponsor vault, which is what the admin screen manages. It is scoped by
 * owner so a sponsor only ever sees their own events, and the Worker enforces that by session.
 */
export async function getSponsorEventsForOwner(owner: string): Promise<SponsorEventSummary[]> {
  const data = await getJson<{ events?: SponsorEventSummary[] }>(
    "/api/sponsors/" + encodeURIComponent(owner) + "/events",
  );
  return data.events ?? [];
}

/* Progressive friction: the only client-visible part of the risk system (spec 52, 62) */

export interface VerifyChallengeResult {
  cleared: boolean;
  strategy: "turnstile" | "signature";
  challengeRequired?: boolean;
  nonce?: string;
  message?: string;
  expiresIn?: number;
  rewardState?: string;
  publicMessage?: string;
}

/** Sends whatever proof the caller has; the Worker answers with the next step or a clearance. */
export async function verifyChallenge(input: {
  wallet: string;
  action: string;
  resource?: string;
  turnstileToken?: string;
  nonce?: string;
  signature?: string;
}): Promise<VerifyChallengeResult> {
  return postJson("/api/verify/challenge", input);
}

/* Leaderboards, achievements, cosmetics, notifications (spec 34, 68, 75) */

export interface RankedEntry {
  rank: number;
  wallet: string;
  /** Public username when the player set one; the screen falls back to the shortened wallet. */
  username?: string | null;
  power: number;
  crewTier: number;
  crewTotalLevel: number;
  streak: number;
  longestStreak: number;
  activeDays: number;
  achievementCount: number;
  seasonalPoints: number;
  oreBalance: number;
  activeMint: string | null;
}

/** The legacy keys plus the spec-68 progression categories the Worker now returns. */
export interface LeaderboardsView extends Leaderboards {
  crew?: RankedEntry[];
  streak?: RankedEntry[];
  achievements?: RankedEntry[];
  seasonal?: RankedEntry[];
  season?: { id: string; name: string; endsAt: number };
  policy?: { realValuePrizes: boolean; rewardsTokenAmounts: boolean; requiresAdditionalAntiSybilProtectionForRealValuePrizes: boolean };
}

export async function getLeaderboards(): Promise<LeaderboardsView> {
  return getJson<LeaderboardsView>("/api/leaderboards");
}

export async function getAchievements(
  wallet: string,
): Promise<{ achievements: AchievementView[]; earnedCount: number; oreGranted: number }> {
  return getJson<{ achievements: AchievementView[]; earnedCount: number; oreGranted: number }>(
    playerPath(wallet, "/achievements"),
  );
}

export async function getCosmetics(): Promise<CosmeticsView> {
  return getJson<CosmeticsView>("/api/cosmetics");
}

export async function equipCosmetic(
  cosmeticId: string,
): Promise<{ equipped: Record<string, string>; slot: string }> {
  return postJson("/api/cosmetics/equip", { cosmeticId });
}

export async function unequipCosmetic(slot: string): Promise<{ equipped: Record<string, string>; slot: string }> {
  return postJson("/api/cosmetics/unequip", { slot });
}

export async function getNotifications(): Promise<NotificationsView> {
  return getJson<NotificationsView>("/api/notifications");
}

export async function markNotificationsRead(ids?: number[]): Promise<{ updated: number; unread: number }> {
  return postJson("/api/notifications/read", ids ? { ids } : {});
}

/* Anti-abuse admin surface (spec 65-67); reachable only for a wallet listed in ADMIN_WALLETS */

export interface AdminRestriction {
  kind: string;
  reasonCode: string;
  createdAt: number;
  expiresAt: number | null;
  createdBy: string;
}

export interface AdminAccount {
  wallet: string;
  riskLevel: string;
  rewardState: string;
  accountAgeSeconds: number;
  activeDays: number;
  streak: number;
  crewLevel: number;
  crewTier: number;
  discoveries: number;
  claimedValueUsd: number;
  trust: number;
  flags: string[];
  relatedAccounts: number;
  restrictions: AdminRestriction[];
}

export interface BreakerState {
  scope: string;
  mint: string | null;
  open: boolean;
  reason: string | null;
  actor: string | null;
  updatedAt: number;
}

export interface AdminAlert {
  name: string;
  metric: string;
  severity: "info" | "warning" | "critical";
  threshold: number;
  floor: number;
  value: number;
  metricValue: number;
  observedAt: number;
}

export interface AdminCounter {
  name: string;
  bucket_hour: number;
  tags: string;
  value: number;
}

export interface AdminAuditEntry {
  id: string;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
  created_at: number;
}

export interface AdminMetrics {
  actor: string;
  window: { from: number; to: number; clusterSeconds: number };
  metrics: Record<string, number>;
  alerts: AdminAlert[];
  breakers: BreakerState[];
  counters: AdminCounter[];
  audit: AdminAuditEntry[];
}

export interface AdminAbuseView {
  actor: string;
  /** The enforcement switch as the console should describe it: are HIGH accounts held or watched? */
  enforcement: AdminEnforcement;
  accounts: AdminAccountEntry[];
  count: number;
}

/** The operator's view of the risk enforcement switch (spec 63). */
export interface AdminEnforcement {
  /** "enforce" acts on a score-derived decision; "shadow" only records it. */
  mode: string;
  /** Per-action overrides, so one action can be enforced while the global mode shadows. */
  overrides: Record<string, string>;
  /** How many listed accounts currently differ from what the score asked for. */
  shadowedAccounts: number;
}

/** An account row plus the shadow-mode pair: what the score asked for, and whether it was acted on. */
export interface AdminAccountEntry extends AdminAccount {
  computedState: string;
  shadowed: boolean;
}

/* The appeals queue (spec 66-67). A player appeals a hold; only an admin can decide it. */

export interface AdminAppeal {
  id: string;
  wallet: string;
  message: string;
  status: string;
  /** The reward state in force when the player wrote this, for context on the decision. */
  stateAtSubmission: string;
  createdAt: number;
  resolvedAt: number | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  /** The neutral sentence the player sees; authored by the server, never by this console. */
  publicMessage: string;
}

export interface AdminAppealsResponse {
  actor: string;
  appeals: AdminAppeal[];
  count: number;
  open: number;
}

/** A signed step-up proof: single use, bound to one action and one exact payload (spec 65). */
export interface AdminStepUpProof {
  nonce: string;
  signature: string;
}

/** The message an admin wallet has to sign before a mutation is accepted. */
export interface AdminStepUpChallenge {
  nonce: string;
  message: string;
}

export async function getAdminAbuse(
  params: { wallet?: string; risk?: string; limit?: number } = {},
): Promise<AdminAbuseView> {
  const query = new URLSearchParams();
  if (params.wallet) query.set("wallet", params.wallet);
  if (params.risk) query.set("risk", params.risk);
  if (params.limit) query.set("limit", String(params.limit));
  const suffix = query.toString().length > 0 ? "?" + query.toString() : "";
  return getJson<AdminAbuseView>("/api/admin/abuse" + suffix);
}

export async function getAdminMetrics(): Promise<AdminMetrics> {
  return getJson<AdminMetrics>("/api/admin/metrics");
}

export interface MeteoraPoolRegistration {
  pool: string;
  mint: string;
  config: string;
}

export async function registerMeteoraPool(pool: string): Promise<MeteoraPoolRegistration> {
  return postJson<MeteoraPoolRegistration>("/api/meteora/pools/register", { pool });
}

export type GameCrewComponent = "miners" | "drills" | "carts" | "foreman" | "storage";

export interface GameCoin {
  mint: string;
  symbol: string;
  name: string;
  createdAt: number;
  miningStartsAt: number;
  graduated: boolean;
}

export interface GameClaim {
  id: string;
  mint: string;
  amount: string;
  amountWhole: number;
  kind: string;
  status: "PENDING" | "PAID";
  signature: string | null;
  createdAt: number;
  name?: string | null;
  symbol?: string | null;
}

export interface GameState {
  wallet: string;
  chainMode: ChainMode;
  createdAt: number;
  oreBalance: number;
  oreEarned: number;
  streak: number;
  longestStreak: number;
  streakFreezes: number;
  activeUntil: number;
  lastActivationAt: number;
  activatedAt: number;
  lastOreAt: number;
  activeDays: number;
  validActivations: number;
  activeMine: {
    coin: GameCoin;
    balance: { claimable: string; amountWhole: number; lastSettledAt: number };
    reserve: { initial: string; released: string; committed: string; paid: string; remaining: string } | null;
  } | null;
  activation: { active: boolean; activeUntil: number };
  discovery: { eligible: boolean; epoch: number; portfolioUsd: number | null };
  crew: Record<GameCrewComponent, number>;
  claims: GameClaim[];
  balances?: Array<{ mint: string; name: string | null; symbol: string | null; claimable?: string; amount?: string; amountWhole: number | string }>;
  claimAll?: { supported: boolean; count: number; signatures: 1; maxItems: number };
}

export interface MeteoraPortfolio {
  wallet: string;
  game: GameState;
  claimable: string;
  pendingUntilGraduation: string;
  graduated: boolean;
}

export interface PreparedClaimBatch {
  id: string;
  /** Base64 legacy transaction already signed in the vault authority's slot. */
  transaction: string;
  /** Unix seconds; the wallet should not sign after this deadline. */
  expiresAt: string;
}

export interface PreparedClaimAllItem {
  /** Mining and discovery rewards for this mint are aggregated into one transfer. */
  claimIds: string[];
  mint: string;
  name: string | null;
  symbol: string | null;
  amount: string;
  amountWhole: string;
}

export interface SettledClaimAllItem {
  id: string;
  claimId: string;
  kind: string;
  mint: string;
  name: string | null;
  symbol: string | null;
  amount: string;
  amountWhole: number;
  status: "PAID";
  signature: string;
  createdAt: number;
}

export async function getGameState(wallet: string): Promise<GameState> {
  const data = await getJson<{ profile: { game: GameState } }>(
    "/api/game/player/" + encodeURIComponent(wallet),
  );
  return data.profile.game;
}

export async function getMeteoraPortfolio(wallet: string): Promise<MeteoraPortfolio> {
  const data = await getJson<{ portfolio: MeteoraPortfolio }>("/api/portfolio/" + encodeURIComponent(wallet));
  return data.portfolio;
}

export async function requestGameActivationChallenge(wallet: string): Promise<{ nonce: string; message: string; expiresAt: number }> {
  return postJson("/api/game/activation-challenge", { wallet });
}

export async function activateGame(nonce: string, signature: string): Promise<{
  player: { streak: number; activeUntil: number; activeMine: string | null; oreBalance: number };
  ore: number;
}> {
  return postJson("/api/game/activate", { nonce, signature });
}

export async function upgradeGameCrew(component: GameCrewComponent): Promise<{ player: GameState; spent: number; power: number }> {
  return postJson("/api/game/upgrade", { component });
}

export async function prepareGameClaimAll(): Promise<{
  batch: PreparedClaimBatch;
  items: PreparedClaimAllItem[];
  signatureCount: 1;
  totalItems: number;
  remainingItems: number;
  complete: boolean;
}> {
  return postJson("/api/game/claim/all", {});
}

export async function confirmGameClaimAll(
  batchId: string,
  signature: string,
): Promise<{
  batch:
    | { id: string; status: "PENDING" }
    | { id: string; status: "SETTLED"; signature: string };
  claims: SettledClaimAllItem[];
}> {
  return postJson("/api/game/claim/all/confirm", { batchId, signature });
}

export async function runGameDiscovery(): Promise<{ discovered: boolean; claim?: GameClaim; reason?: string }> {
  return postJson("/api/game/discovery", {});
}

export async function getAdminDashboard(): Promise<AdminDashboardPayload> {
  return adminRequest<AdminDashboardPayload>("/api/admin/dashboard");
}

/**
 * The admin surface's own transport. It is the one place that talks to /api/admin/* without the
 * shared request() helper, because an admin call has to keep the Worker's own { error } message
 * and status rather than the neutral copy the player-facing calls show.
 */
export async function adminRequest<T>(
  path: string,
  options: { method?: "GET" | "POST"; body?: unknown } = {},
): Promise<T> {
  const headers = new Headers();
  headers.set(DEVICE_HEADER, deviceId());
  const hasBody = options.body !== undefined;
  if (hasBody) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    method: options.method ?? (hasBody ? "POST" : "GET"),
    headers,
    body: hasBody ? JSON.stringify(options.body) : undefined,
    credentials: "same-origin",
  });
  const data = (await response.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!response.ok) {
    throw new ApiError(
      data?.error ?? data?.message ?? "Request failed (" + response.status + ")",
      response.status,
    );
  }
  if (data === null) throw new ApiError("Malformed server response", response.status);
  return data;
}

export async function getAdminAbuseView(limit = 50): Promise<AdminAbuseView> {
  return adminRequest<AdminAbuseView>("/api/admin/abuse?limit=" + String(limit));
}

export async function getAdminAppeals(status?: string): Promise<AdminAppealsResponse> {
  const suffix = status && status !== "ALL" ? "?status=" + encodeURIComponent(status) : "";
  return adminRequest<AdminAppealsResponse>("/api/admin/appeals" + suffix);
}

/** Asks for the message this admin wallet has to sign to perform one exact mutation. */
export function adminStepUpChallenge(
  action: string,
  payload: Record<string, unknown>,
): Promise<AdminStepUpChallenge> {
  return adminRequest<AdminStepUpChallenge>("/api/admin/stepup", { body: { action, payload } });
}

/**
 * One signed admin mutation: ask for the challenge, sign it with the admin wallet, and send the
 * proof with the payload. `signMessage` is the wallet's own signer, so this module never holds a
 * key. Every change asks again — the proof is single use and bound to this payload.
 */
export async function adminSignedRequest<T>(
  path: string,
  action: string,
  payload: Record<string, unknown>,
  signMessage: (message: Uint8Array) => Promise<Uint8Array>,
): Promise<T> {
  const issued = await adminStepUpChallenge(action, payload);
  const signature = bs58.encode(await signMessage(new TextEncoder().encode(issued.message)));
  const stepUp: AdminStepUpProof = { nonce: issued.nonce, signature };
  return adminRequest<T>(path, { body: { ...payload, stepUp } });
}

export async function setBreaker(input: {
  scope: string;
  mint?: string;
  open: boolean;
  reason: string;
}): Promise<{ breaker: BreakerState; breakers: BreakerState[] }> {
  return postJson("/api/admin/breakers", input);
}

export async function setRestriction(input: {
  wallet: string;
  kind: string;
  reasonCode?: string;
  expiresInSec?: number;
  lift?: boolean;
}): Promise<{ restriction?: AdminRestriction; lifted?: boolean }> {
  return postJson("/api/admin/restrictions", input);
}

/* Trading: unchanged chain-facing calls */

export async function recordTrade(
  mint: string,
  // The amount is the exact decimal string the swap reported (see SwapExecution.recordedAmount): a
  // raw base-unit figure above 2^53 does not survive a JS Number.
  trade: { signature: string; side: "buy" | "sell"; amount: string },
): Promise<{ priceSol: number; priceUsd: number }> {
  return postJson("/api/tokens/" + encodeURIComponent(mint) + "/trades", trade);
}
