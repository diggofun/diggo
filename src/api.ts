/**
 * The single HTTP client for the Diggo.fun frontend.
 *
 * Every call goes through request(), which attaches the privacy-conscious per-browser
 * X-Diggo-Device hint (src/device.ts) and relies on the HttpOnly session cookie the Worker sets
 * on /api/auth/verify. Nothing here decides an outcome: discovery rolls, rarities, visual events,
 * block rewards and claim eligibility are all computed server-side, and this module only carries
 * the answer back to the UI (spec 55).
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
  TokenSummary,
} from "../shared/types";
import { startAnalytics } from "./analytics";
import { DEVICE_HEADER, deviceId } from "./device";

/** An HTTP failure carrying the Worker's status and machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }

  /** True when the risk gate answered 403 VERIFICATION_REQUIRED (spec 52). */
  get verificationRequired(): boolean {
    return this.status === 403 && this.code === "VERIFICATION_REQUIRED";
  }
}

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!response.ok) {
    throw new ApiError(
      data?.error ?? "Request failed (" + response.status + ")",
      response.status,
      data?.code ?? null,
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

export async function getBootstrap(): Promise<Bootstrap> {
  try {
    const data = await getJson<Bootstrap>("/api/bootstrap?limit=1000");
    void startAnalytics(data.config);
    return data;
  } catch {
    return {
      tokens: [],
      config: {
        cluster: "devnet",
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
): Promise<{ wallet: string; expiresIn: number }> {
  return postJson("/api/auth/verify", { wallet, nonce, signature });
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

/* Mining: activation, reports, switching and crew (spec 29, 30, 71-75) */

export interface ActivationOutcome {
  report: MiningReport;
  player: PlayerProfile;
  mine: MineInfo | null;
}

export async function getActivationChallenge(wallet: string): Promise<{ nonce: string; message: string }> {
  return postJson("/api/mine/activate/challenge", { wallet });
}

export async function activateMine(
  wallet: string,
  nonce: string,
  signature: string,
  mint?: string,
): Promise<ActivationOutcome> {
  return postJson("/api/mine/activate", { wallet, nonce, signature, mint });
}

/** Idempotent per activation window; a repeat call returns the stored report (spec 29). */
export async function collectMiningReport(): Promise<{
  report: MiningReport;
  player: PlayerProfile;
  idempotent: boolean;
}> {
  return postJson("/api/mine/report/collect");
}

export async function getMineInfo(mint: string): Promise<MineInfo> {
  const data = await getJson<{ mine: MineInfo }>("/api/mines/" + encodeURIComponent(mint) + "/info");
  return data.mine;
}

export async function switchMine(mint: string): Promise<{ player: PlayerProfile; mine: MineInfo | null }> {
  return postJson("/api/mine/switch", { mint });
}

export async function upgradeCrew(
  component: string,
): Promise<{ player: PlayerProfile; spent: number; power: number }> {
  return postJson("/api/crew/upgrade", { component });
}

export async function getPlayerProfile(wallet: string): Promise<PlayerProfile> {
  const data = await getJson<{ player: PlayerProfile }>(playerPath(wallet));
  return data.player;
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

/* Discoveries: the server authors the opportunity and rolls the outcome (spec 55, 56) */

export interface DiscoveryOpportunityView {
  opportunity: DiscoveryOpportunity | null;
  crewActive?: boolean;
  eligible?: boolean;
  challengeRequired?: boolean;
  publicMessage?: string;
}

export interface DiscoveryRollView {
  discovery: DiscoveryRecord | null;
  window: string;
  rolled: boolean;
}

export async function requestDiscoveryOpportunity(): Promise<DiscoveryOpportunityView> {
  return postJson("/api/discovery/opportunity");
}

export async function rollDiscovery(mint?: string): Promise<DiscoveryRollView> {
  return postJson("/api/discovery/roll", mint ? { mint } : {});
}

export async function getDiscoveryClaimChallenge(
  discoveryId: string,
): Promise<{ nonce: string; message: string; expiresIn: number }> {
  return postJson("/api/discovery/claim/challenge", { discoveryId });
}

export async function claimDiscovery(
  discoveryId: string,
  nonce: string,
  signature: string,
): Promise<{ status: string; txSignature?: string | null; queued?: boolean }> {
  return postJson("/api/discovery/claim", { discoveryId, nonce, signature });
}

export async function getDiscoveries(
  wallet: string,
): Promise<{ discoveries: DiscoveryRecord[]; opportunity: DiscoveryOpportunity | null }> {
  const data = await getJson<{ discoveries?: DiscoveryRecord[]; opportunity?: DiscoveryOpportunity | null }>(
    playerPath(wallet, "/discoveries"),
  );
  return { discoveries: data.discoveries ?? [], opportunity: data.opportunity ?? null };
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
  accounts: AdminAccount[];
  count: number;
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
  trade: { signature: string; side: "buy" | "sell"; amount: number },
): Promise<{ priceSol: number; priceUsd: number }> {
  return postJson("/api/tokens/" + encodeURIComponent(mint) + "/trades", trade);
}
