/**
 * Random memecoin Discoveries: the most security-sensitive subsystem in Diggo (spec 22-28,
 * 44-45, 54-56, 70).
 *
 * Rules this module exists to enforce:
 *
 * - The server decides everything. Whether a discovery happens, which token it is, which rarity
 *   it got, which visual event the player sees and how many units are paid are all derived
 *   server-side from env.DISCOVERY_SECRET via shared/random.ts (spec 55). The client sends no
 *   seed, no rarity, no token and no amount.
 * - One roll per window, ever. An opportunity is authored server-side per active Crew per time
 *   window, carries a deterministic event_id and a server nonce, and is consumed by a single
 *   guarded UPDATE. A client cannot spam requests hoping for a Rare, cannot cancel an
 *   unfavourable roll, and cannot pick the best of several parallel attempts (spec 56).
 * - Value is capped even when detection fails. Account/day, account/week, token/day,
 *   token/period, per-request and global/day budgets are all evaluated before anything is
 *   granted, and the grant is additionally bounded by the token's own indexed Discovery Reserve
 *   and its on-chain epoch budget (spec 45, 64).
 * - Nothing here trusts the spot price. The token amount is normalized from robustness-checked
 *   samples only, and a token whose price confidence is too low is never paid (spec 26, 27).
 *
 * Fails closed: with no DISCOVERY_SECRET, or with an unreadable breaker, no discovery is
 * granted. Falling back to a predictable seed would be strictly worse than paying nothing.
 */
import {
  clampDiscoveryTunables,
  configFromEnv,
  DIGGO_CONFIG,
  type DiggoConfig,
  type RewardState,
} from "../shared/config";
import { crewTier } from "../shared/crew";
import {
  discoveryBudgetCheck,
  discoveryBudgetRemaining,
  discoveryEligibility,
  heldUsageCountedUsd,
  type DiscoveryCapReason,
  type DiscoveryUsage,
} from "../shared/discovery";
import { discoveryVisualEvent } from "../shared/discoveryVisual";
import {
  COMMIT_REVEAL_ALGORITHM,
  DEFAULT_EPOCH_SECONDS,
  commitmentOf,
  commitmentView,
  createCommitRevealRandomSource,
  deriveEpochSeed,
  epochInfo,
  epochOf,
  rollVerificationRecipe,
  verifyCommitment,
  type RngCommitmentRecord,
} from "../shared/commitReveal";
import { maturityBps } from "../shared/ore";
import type { RandomSource } from "../shared/random";
import {
  capRarityByBudget,
  normalizedDiscoveryAmount,
  rarityTier,
  resolveRarity,
  rollDiscoveryRarity,
  tokenEligibilityScore,
  type PriceSample,
  type TokenEligibilityInput,
} from "../shared/rarity";
import type { DiscoveryOpportunity, DiscoveryRecord } from "../shared/types";
import {
  challengeKey,
  consumeChallengeNonce,
  issueChallenge,
  loadChallenge,
  sessionWallet,
  verifyWalletSignature,
} from "./auth";
import { isBreakerOpen } from "./breakers";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit, isBase58Address, json, readJson } from "./http";
import { getRobustPrice, internalPriceSamples, type OracleQuote } from "./oracle";
import { activationStateOf, crewLevelsOf, getOrCreatePlayer, type PlayerRow } from "./player";
import { gateAction, recordActivity } from "./risk";
import { metric } from "./telemetry";

// --- tunables ----------------------------------------------------------------------------------

/** The shipped defaults, now owned by DIGGO_CONFIG (shared/config.ts). */
export const DISCOVERY_DEFAULT_WINDOW_SECONDS = DIGGO_CONFIG.discovery.windowSeconds;
/** 2.5% per window by default: roughly 0.6 expected grants a day, well inside the daily budget. */
export const DISCOVERY_DEFAULT_ROLL_CHANCE_BPS = DIGGO_CONFIG.discovery.rollChanceBps;
/** How many candidate tokens one roll considers, bounding the work a single request can do. */
export const DISCOVERY_MAX_CANDIDATES = 60;
/** Price observations kept per mint; older rows are pruned when a new one is written. */
export const DISCOVERY_PRICE_SAMPLE_RETENTION = 200;
/** The action name a discovery claim challenge is bound to (see worker/auth.ts issueChallenge). */
export const CLAIM_DISCOVERY_ACTION = "claim_discovery";
/** How long a signed claim challenge stays usable; short, because it is signed immediately. */
export const CLAIM_CHALLENGE_TTL_SECONDS = 300;

export interface DiscoveryTunables {
  windowSeconds: number;
  rollChanceBps: number;
}

/**
 * The effective configuration for one request: DIGGO_CONFIG plus the deployment's environment
 * override layer (see configFromEnv in shared/config.ts). Discovery reads its tunables through
 * here, so an operator tunes the same parameters the tests do, with the same clamping - a bad
 * env var can neither open the floodgates nor stop the subsystem (spec 15, 80).
 */
export function discoveryConfig(env: RuntimeEnv): DiggoConfig {
  return configFromEnv(env);
}

/** Window length and roll chance, clamped to DISCOVERY_TUNABLE_BOUNDS. */
export function discoveryTunables(env: RuntimeEnv): DiscoveryTunables {
  return discoveryTunablesOf(discoveryConfig(env));
}

export function discoveryTunablesOf(config: DiggoConfig): DiscoveryTunables {
  return clampDiscoveryTunables(
    {
      windowSeconds: config.discovery.windowSeconds,
      rollChanceBps: config.discovery.rollChanceBps,
    },
    config.discovery,
  );
}

// --- windows, event ids and nonces --------------------------------------------------------------

export function discoveryWindowIndex(now: number, tunables: DiscoveryTunables): number {
  return Math.floor(now / tunables.windowSeconds);
}

export function discoveryWindowLabel(windowIndex: number): string {
  return `w${windowIndex}`;
}

/**
 * Deterministic identity of one opportunity: the same wallet in the same window always produces
 * the same event id, so lazy regeneration is idempotent and can never mint a second opportunity.
 */
export function discoveryEventId(wallet: string, windowIndex: number): string {
  return `dsc:v1:${wallet}:${windowIndex}`;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

interface DiscoverySecret {
  source: RandomSource;
  secret: string;
}

interface DrawContext extends DiscoverySecret {
  wallet: string;
  eventId: string;
  window: string;
}

/**
 * One uniform draw per derived event id. Deriving separate ids instead of reusing one preserves
 * the "one roll per opportunity" property of shared/random.ts for every decision this module
 * makes (hit/miss, target token, rarity).
 */
async function draw(ctx: DrawContext, purpose: string): Promise<number> {
  return ctx.source.roll({
    serverSecret: ctx.secret,
    eventId: purpose ? `${ctx.eventId}:${purpose}` : ctx.eventId,
    accountId: ctx.wallet,
    window: ctx.window,
  });
}

/**
 * Loads the server secret. Fails closed: without a real server secret there is no unpredictable
 * seed, so the subsystem refuses to roll rather than fall back to anything guessable (spec 55).
 */
function serverSecretFor(env: RuntimeEnv): string | null {
  const secret = env.DISCOVERY_SECRET;
  return secret && secret.length >= 16 ? secret : null;
}

async function refuseWithoutSecret(env: RuntimeEnv): Promise<null> {
  await metric(env, "discovery.roll_denied", 1, { reason: "discovery_secret_missing" });
  console.error(
    JSON.stringify({
      event: "discovery.secret_missing",
      detail: "DISCOVERY_SECRET is not configured (or too short); refusing to roll a real-value discovery",
    }),
  );
  return null;
}

// --- commit-reveal RNG epochs (spec 55, 56) -------------------------------------------------------

/** Bounds for the commit-reveal epoch length; a day by default, per the migration path in spec 55. */
export const RNG_EPOCH_BOUNDS = { min: 3_600, max: 2_592_000 } as const;

/**
 * The epoch length the deployment rolls its commitments over. Configurable, because a devnet
 * rehearsal wants minutes rather than a day, but bounded so neither an accidental zero nor an
 * accidentally decade-long epoch can reach production.
 */
export function rngEpochSecondsOf(env: RuntimeEnv): number {
  const raw = Number(env.DISCOVERY_EPOCH_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_EPOCH_SECONDS;
  return Math.min(RNG_EPOCH_BOUNDS.max, Math.max(RNG_EPOCH_BOUNDS.min, Math.floor(raw)));
}

interface RngCommitmentRow {
  epoch: number;
  algorithm: string;
  epoch_seconds: number;
  starts_at: number;
  ends_at: number;
  commitment: string;
  seed: string | null;
  revealed_at: number | null;
  created_at: number;
}

export function toRngCommitmentRecord(row: RngCommitmentRow): RngCommitmentRecord {
  return {
    epoch: row.epoch,
    algorithm: row.algorithm,
    epochSeconds: row.epoch_seconds,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    commitment: row.commitment,
    seed: row.seed,
    revealedAt: row.revealed_at,
    createdAt: row.created_at,
  };
}

async function loadCommitment(env: RuntimeEnv, epoch: number): Promise<RngCommitmentRow | null> {
  return env.DB.prepare("SELECT * FROM rng_commitments WHERE epoch = ?1").bind(epoch).first<RngCommitmentRow>();
}

export interface DiscoveryRng extends DiscoverySecret {
  kind: string;
  epoch: number;
  epochSeconds: number;
  startsAt: number;
  endsAt: number;
  commitment: string;
}

/**
 * Publishes `sha256(seed)` for one epoch, if it is not published already.
 *
 * INSERT OR IGNORE is what makes the commitment binding: the first commitment for an epoch wins
 * forever, so the seed cannot be swapped afterwards. If the secret has changed since the
 * commitment was published, this epoch's derived seed no longer matches it, and the call returns
 * null so the epoch rolls nothing rather than rolling against a seed nobody committed to.
 */
async function ensureEpochCommitment(
  env: RuntimeEnv,
  serverSecret: string,
  epoch: number,
  epochSeconds: number,
  now: number,
): Promise<DiscoveryRng | null> {
  const info = epochInfo(epoch, epochSeconds);
  const seed = await deriveEpochSeed(serverSecret, info.epoch);
  const commitment = await commitmentOf(seed);
  const existing = await loadCommitment(env, info.epoch);
  if (!existing) {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rng_commitments
         (epoch, algorithm, epoch_seconds, starts_at, ends_at, commitment, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
      .bind(info.epoch, COMMIT_REVEAL_ALGORITHM, info.epochSeconds, info.startsAt, info.endsAt, commitment, now)
      .run();
  }
  const row = existing ?? (await loadCommitment(env, info.epoch));
  if (!row) return null;
  if (row.commitment !== commitment) {
    // The seed behind this commitment is not the one we can derive any more, so every roll of this
    // epoch would be unverifiable. Refuse instead of publishing an outcome no one can check.
    await metric(env, "discovery.commitment_mismatch", 1, { epoch: String(info.epoch) });
    console.error(
      JSON.stringify({ event: "discovery.commitment_mismatch", epoch: info.epoch, row: row.commitment }),
    );
    return null;
  }
  return {
    kind: COMMIT_REVEAL_ALGORITHM,
    source: createCommitRevealRandomSource(info.epoch, seed),
    secret: seed,
    epoch: info.epoch,
    epochSeconds: info.epochSeconds,
    startsAt: info.startsAt,
    endsAt: info.endsAt,
    commitment: row.commitment,
  };
}

/**
 * The RNG context for a roll: the current epoch's seed and the RandomSource bound to it. The seed
 * is derived from DISCOVERY_SECRET and the epoch, so it cannot be influenced by anything the
 * rolling wallet does, and it is reconstructible by anyone once the epoch ends.
 */
export async function discoveryRngFor(
  env: RuntimeEnv,
  now: number,
): Promise<DiscoveryRng | null> {
  const serverSecret = serverSecretFor(env);
  if (!serverSecret) return refuseWithoutSecret(env);
  const epochSeconds = rngEpochSecondsOf(env);
  return ensureEpochCommitment(env, serverSecret, epochOf(now, epochSeconds), epochSeconds, now);
}

export interface RngCommitmentSummary {
  secretConfigured: boolean;
  currentEpoch: number | null;
  nextEpoch: number | null;
  published: number[];
  revealed: number[];
}

/**
 * Publishes the commitment for the epoch in progress and for the one after it, and reveals every
 * ended epoch whose seed is still sealed. Called from the cron trigger and from the public
 * commitments endpoint, so the commitment for an epoch is on record before that epoch's first roll
 * and the reveal happens without an operator doing anything.
 */
export async function prepublishRngCommitments(
  env: RuntimeEnv,
  now = Math.floor(Date.now() / 1_000),
): Promise<RngCommitmentSummary> {
  const serverSecret = serverSecretFor(env);
  const epochSeconds = rngEpochSecondsOf(env);
  const currentEpoch = epochOf(now, epochSeconds);
  const summary: RngCommitmentSummary = {
    secretConfigured: serverSecret !== null,
    currentEpoch,
    nextEpoch: currentEpoch + 1,
    published: [],
    revealed: [],
  };
  if (!serverSecret) return summary;

  for (const epoch of [currentEpoch, currentEpoch + 1]) {
    const before = await loadCommitment(env, epoch);
    const rng = await ensureEpochCommitment(env, serverSecret, epoch, epochSeconds, now);
    if (rng && !before) summary.published.push(epoch);
  }

  const pending = await env.DB.prepare(
    "SELECT epoch, commitment FROM rng_commitments WHERE seed IS NULL AND ends_at <= ?1 ORDER BY epoch ASC LIMIT 50",
  )
    .bind(now)
    .all<{ epoch: number; commitment: string }>();
  for (const row of pending.results ?? []) {
    const seed = await deriveEpochSeed(serverSecret, row.epoch);
    if (!(await verifyCommitment(seed, row.commitment))) {
      await metric(env, "discovery.reveal_mismatch", 1, { epoch: String(row.epoch) });
      console.error(JSON.stringify({ event: "discovery.reveal_mismatch", epoch: row.epoch }));
      continue;
    }
    // Guarded by ends_at so this UPDATE can never unseal a running epoch, whatever calls it.
    const result = await env.DB.prepare(
      "UPDATE rng_commitments SET seed = ?1, revealed_at = ?2 WHERE epoch = ?3 AND ends_at <= ?2 AND seed IS NULL",
    )
      .bind(seed, now, row.epoch)
      .run();
    if (result.meta.changes === 1) {
      summary.revealed.push(row.epoch);
      await metric(env, "discovery.seed_revealed", 1, { epoch: String(row.epoch) });
    }
  }
  return summary;
}

// --- opportunity persistence ---------------------------------------------------------------------

interface OpportunityRow {
  id: string;
  wallet: string;
  event_id: string;
  window_index: number;
  window: string;
  nonce: string;
  status: string;
  consumed_at: number | null;
  expires_at: number;
  discovery_id: string | null;
  mint: string | null;
  rarity: string | null;
  reason: string | null;
}

export function toOpportunityView(row: OpportunityRow): DiscoveryOpportunity {
  return {
    id: row.id,
    eventId: row.event_id,
    accountId: row.wallet,
    window: row.window,
    windowIndex: row.window_index,
    nonce: row.nonce,
    status: row.status as DiscoveryOpportunity["status"],
    consumedAt: row.consumed_at,
    expiresAt: row.expires_at,
    discoveryId: row.discovery_id,
  };
}

async function loadOpportunity(
  env: RuntimeEnv,
  wallet: string,
  windowIndex: number,
): Promise<OpportunityRow | null> {
  return env.DB.prepare(
    "SELECT * FROM discovery_opportunities WHERE wallet = ?1 AND window_index = ?2",
  )
    .bind(wallet, windowIndex)
    .first<OpportunityRow>();
}

/**
 * Lazily authors the current window's opportunity. Idempotent by UNIQUE(wallet, window_index), so
 * concurrent creation has exactly one winner and repeating the call inside a window returns the
 * same event id and nonce.
 */
async function ensureOpportunity(
  env: RuntimeEnv,
  rng: DiscoveryRng,
  wallet: string,
  windowIndex: number,
  tunables: DiscoveryTunables,
): Promise<OpportunityRow> {
  const existing = await loadOpportunity(env, wallet, windowIndex);
  if (existing) return existing;
  const eventId = discoveryEventId(wallet, windowIndex);
  const window = discoveryWindowLabel(windowIndex);
  const nonce = toHex(
    await rng.source.deriveBytes({ serverSecret: rng.secret, eventId, accountId: wallet, window }, 16),
  );
  await env.DB.prepare(
    `INSERT OR IGNORE INTO discovery_opportunities
       (id, wallet, event_id, window_index, window, nonce, status, expires_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PENDING', ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      wallet,
      eventId,
      windowIndex,
      window,
      nonce,
      (windowIndex + 1) * tunables.windowSeconds,
    )
    .run();
  const created = await loadOpportunity(env, wallet, windowIndex);
  if (!created) throw new Error("Failed to author discovery opportunity");
  return created;
}

/**
 * The single-use guard (spec 56). Returns true only for the request that wins the transition; a
 * parallel or repeated roll in the same window sees false and gets nothing.
 */
async function consumeOpportunity(env: RuntimeEnv, opportunityId: string, now: number): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE discovery_opportunities
        SET status = 'CONSUMED', consumed_at = ?1
      WHERE id = ?2 AND status IN ('PENDING', 'ELIGIBLE')`,
  )
    .bind(now, opportunityId)
    .run();
  return result.meta.changes === 1;
}

// --- budget accounting ---------------------------------------------------------------------------

const COUNTED_STATUSES = "('PENDING','ELIGIBLE','CLAIMED','HELD')";
/** Everything except a hold: the value that counts against every cap without a ceiling. */
const UNHELD_STATUSES = "('PENDING','ELIGIBLE','CLAIMED')";

interface UsageRow {
  unheld: number;
  held: number;
}

/**
 * Rolling value actually granted, per account, per token and globally. Only granted states count:
 * a REJECTED row never consumed budget, so counting it would let a refused attempt eat a
 * legitimate player's allowance.
 *
 * HELD value is counted separately and only up to the configured share of each cap
 * (heldUsageCountedUsd), and only while the hold is inside its review window: a grant parked for
 * review is a promise, but an uncleared backlog of them must not be able to reserve every cap and
 * deny ordinary players their budget (spec 45, 64).
 */
async function budgetUsage(
  env: RuntimeEnv,
  wallet: string,
  mint: string,
  now: number,
  config: DiggoConfig,
): Promise<DiscoveryUsage> {
  const day = config.time.secondsPerDay;
  const week = config.time.secondsPerWeek;
  const period = config.discovery.tokenPeriodSeconds;
  const heldCutoff = now - config.discovery.heldGrantReviewSeconds;
  const scoped = (clause: string, value: string, since: number) =>
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ${UNHELD_STATUSES} THEN value_usd ELSE 0 END), 0) AS unheld,
         COALESCE(SUM(CASE WHEN status = 'HELD' AND created_at >= ?3 THEN value_usd ELSE 0 END), 0) AS held
         FROM discoveries
         WHERE ${clause} AND status IN ${COUNTED_STATUSES} AND created_at >= ?2`,
    )
      .bind(value, since, heldCutoff)
      .first<UsageRow>();
  // Held value counts against the cap it is being measured against, never above that cap's share.
  const counted = (row: UsageRow | null, capUsd: number) =>
    (row?.unheld ?? 0) + heldUsageCountedUsd(row?.held ?? 0, capUsd, config);
  const rules = config.discovery;
  const [accountDaily, accountWeekly, tokenDaily, tokenPeriod, globalDaily] = await Promise.all([
    scoped("wallet = ?1", wallet, now - day),
    scoped("wallet = ?1", wallet, now - week),
    scoped("mint = ?1", mint, now - day),
    scoped("mint = ?1", mint, now - period),
    env.DB.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN status IN ${UNHELD_STATUSES} THEN value_usd ELSE 0 END), 0) AS unheld,
         COALESCE(SUM(CASE WHEN status = 'HELD' AND created_at >= ?2 THEN value_usd ELSE 0 END), 0) AS held
         FROM discoveries
         WHERE status IN ${COUNTED_STATUSES} AND created_at >= ?1`,
    )
      .bind(now - day, heldCutoff)
      .first<UsageRow>(),
  ]);
  return {
    accountDailyUsd: counted(accountDaily, rules.accountDailyCapUsd),
    accountWeeklyUsd: counted(accountWeekly, rules.accountWeeklyCapUsd),
    tokenDailyUsd: counted(tokenDaily, rules.tokenDailyCapUsd),
    tokenPeriodUsd: counted(tokenPeriod, rules.tokenPeriodCapUsd),
    globalDailyUsd: counted(globalDaily, rules.globalDailyCapUsd),
  };
}

/**
 * Counts holds nobody cleared inside the review window (spec 45, 53, 64).
 *
 * A hold is a promise kept in escrow while a human (or the risk pipeline) decides, and an
 * unresolved one must not reserve a budget slot forever - which is already true without touching
 * it: budgetUsage() stops counting a HELD grant the moment it leaves the review window, so every
 * cap gets that budget back on its own. What must NOT happen is the grant being resolved by the
 * clock: a REJECTED row is irreversible and destroys a real reward a player was granted, so an
 * unresolved hold stays HELD until a human or the risk pipeline resolves it. Nothing on the roll or
 * claim path mutates it, which is why this only reports and counts. Guarded by a cheap existence
 * check because it runs on the roll path.
 */
export async function countStaleDiscoveryHolds(
  env: RuntimeEnv,
  now = Math.floor(Date.now() / 1_000),
  config: DiggoConfig = DIGGO_CONFIG,
): Promise<number> {
  const cutoff = now - config.discovery.heldGrantReviewSeconds;
  const stale = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM discoveries WHERE status = 'HELD' AND created_at <= ?1",
  )
    .bind(cutoff)
    .first<{ total: number }>();
  const waiting = Number(stale?.total ?? 0);
  if (waiting > 0) {
    await metric(env, "discovery.hold_awaiting_review", waiting, {});
    console.log(JSON.stringify({ event: "discovery.hold_awaiting_review", waiting, cutoff }));
  }
  return waiting;
}

// --- token selection -----------------------------------------------------------------------------

interface CandidateRow {
  mint: string;
  symbol: string;
  /** LAUNCHING mines quote on the bonding curve only; anything else has a real DEX market. */
  status: string;
  decimals: number;
  price_usd: number;
  market_cap_usd: number;
  liquidity_usd: number;
  discovery_reserve_remaining: number;
  discovery_epoch_budget: number;
  discovery_epoch_spent: number;
  discovery_epoch_ends_at: number;
  mint_authority_revoked: number;
  freeze_authority_revoked: number;
  liquidity_locked: number;
  volume_24h_usd: number;
  trade_count_24h: number;
}

/**
 * Candidate mines for one roll. Tokens that cannot be valued honestly never enter the pool: a
 * paused reserve, no reserve left, too little liquidity or 24h volume, or a market cap below the
 * configured floor are filtered out here, so an illiquid token is never selected and then dressed
 * up as a high rarity (spec 26).
 */
async function candidateTokens(
  env: RuntimeEnv,
  excludeMint: string | null,
  now: number,
  config: DiggoConfig,
): Promise<CandidateRow[]> {
  const result = await env.DB.prepare(
    `SELECT t.mint, t.symbol, t.status, t.decimals, t.price_usd, t.market_cap_usd, t.liquidity_usd,
            t.discovery_reserve_remaining, t.discovery_epoch_budget, t.discovery_epoch_spent,
            t.discovery_epoch_ends_at, t.mint_authority_revoked, t.freeze_authority_revoked,
            t.liquidity_locked,
            COALESCE((SELECT SUM(tr.amount * tr.price_usd) FROM trades tr
                       WHERE tr.mint = t.mint AND tr.block_time >= ?1), 0) AS volume_24h_usd,
            COALESCE((SELECT COUNT(*) FROM trades tr
                       WHERE tr.mint = t.mint AND tr.block_time >= ?1), 0) AS trade_count_24h
       FROM tokens t
      WHERE t.status = 'MINING_ACTIVE'
        AND t.discovery_paused = 0
        AND t.discovery_reserve_remaining > 0
        AND t.market_cap_usd >= ?2
        AND t.liquidity_usd >= ?3
        AND (t.mint != ?4 OR ?4 IS NULL)
      ORDER BY t.mint
      LIMIT ?5`,
  )
    .bind(
      now - config.time.secondsPerDay,
      config.discovery.minimumMarketCapUsd,
      config.discovery.minimumLiquidityUsd,
      excludeMint,
      DISCOVERY_MAX_CANDIDATES,
    )
    .all<CandidateRow>();
  return result.results ?? [];
}

/** Recent price observations, oldest first, used for the robustness check (spec 27). */
export async function priceSamplesFor(
  env: RuntimeEnv,
  mint: string,
  now: number,
  config: DiggoConfig = DIGGO_CONFIG,
): Promise<PriceSample[]> {
  // Owned by worker/oracle.ts now, so the roll path and the oracle read exactly one query.
  return internalPriceSamples(env, mint, now, config);
}

/**
 * Appends one price observation for a mint and prunes old ones. Called from the indexing path
 * (worker/indexing.ts) after every successful chain sync, so the samples robustPrice() reads are
 * real observed prices rather than one cached spot value that a small pool could move.
 */
export async function recordPriceSample(
  env: RuntimeEnv,
  mint: string,
  priceUsd: number,
  volumeUsd: number,
  now = Math.floor(Date.now() / 1_000),
): Promise<void> {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO token_price_samples (id, mint, price_usd, volume_usd, observed_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    ).bind(crypto.randomUUID(), mint, priceUsd, Number.isFinite(volumeUsd) ? volumeUsd : 0, now),
    env.DB.prepare(
      `DELETE FROM token_price_samples
         WHERE mint = ?1 AND id NOT IN (
           SELECT id FROM token_price_samples WHERE mint = ?1 ORDER BY observed_at DESC LIMIT ?2)`,
    ).bind(mint, DISCOVERY_PRICE_SAMPLE_RETENTION),
  ]);
}

function healthFlagsOf(candidate: CandidateRow): TokenEligibilityInput["health"] {
  return {
    mintAuthorityRevoked: candidate.mint_authority_revoked === 1,
    freezeAuthorityRevoked: candidate.freeze_authority_revoked === 1,
    liquidityLocked: candidate.liquidity_locked === 1,
    // The program exposes no trading-halt flag for an active mine, a paused discovery reserve is
    // already excluded above, and a FULLY_MINED mine keeps trading by design (spec 20).
    tradingEnabled: true,
    transferRestricted: false,
  };
}

interface GrantCandidate {
  candidate: CandidateRow;
  /** The combined price with its source list, kept for the grant-time metric. */
  price: OracleQuote;
  eligibility: TokenEligibilityInput;
  score: number;
}

/** Index derived from a keyed uniform draw: the mapping is stable, the draw is unpredictable. */
function pickIndex(drawValue: number, length: number): number {
  if (length <= 1) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(drawValue * length)));
}

async function loadGrantCandidate(
  env: RuntimeEnv,
  row: CandidateRow,
  now: number,
  config: DiggoConfig,
): Promise<GrantCandidate | null> {
  // The median across the token's own history, its recorded trades and any external quote we hold
  // (worker/oracle.ts). A null answer means the sources disagree, are stale or are too thin to
  // value a real payout, and the caller then grants nothing (spec 26, 27).
  const price = await getRobustPrice(env, row.mint, {
    now,
    config,
    graduated: row.status !== "LAUNCHING",
  });
  if (!price || price.confidence < config.discovery.minimumPriceConfidence) return null;
  const eligibility: TokenEligibilityInput = {
    liquidityUsd: row.liquidity_usd,
    volume24hUsd: row.volume_24h_usd,
    tradeCount24h: row.trade_count_24h,
    reserveAvailableUsd: row.discovery_reserve_remaining * price.priceUsd,
    priceConfidence: price.confidence,
    health: healthFlagsOf(row),
  };
  return { candidate: row, price, eligibility, score: tokenEligibilityScore(eligibility, config) };
}

/** Reserve still spendable this epoch on chain, in whole tokens. */
function epochHeadroomTokens(row: CandidateRow, now: number): number {
  if (row.discovery_epoch_ends_at <= now) return row.discovery_reserve_remaining;
  const remaining = row.discovery_epoch_budget - row.discovery_epoch_spent;
  return Math.max(0, Math.min(row.discovery_reserve_remaining, remaining));
}

interface ReserveState {
  /** The program's own per-mine pause (Mine.discovery_paused). */
  paused: boolean;
  /** Indexed Discovery Reserve still available, in whole tokens. */
  remainingTokens: number;
}

/**
 * The mint's indexed reserve state, mirrored from chain. The operational breaker lives in D1 and is
 * checked separately; this is the on-chain authority.
 *
 * A missing token row counts as paused with nothing left: an unverifiable reserve must never be paid
 * from, and failing closed here costs a retry rather than a payout that cannot settle.
 */
async function reserveState(env: RuntimeEnv, mint: string): Promise<ReserveState> {
  const row = await env.DB.prepare(
    "SELECT discovery_paused, discovery_reserve_remaining FROM tokens WHERE mint = ?1",
  )
    .bind(mint)
    .first<{ discovery_paused: number; discovery_reserve_remaining: number }>();
  if (!row) return { paused: true, remainingTokens: 0 };
  return { paused: row.discovery_paused === 1, remainingTokens: row.discovery_reserve_remaining };
}

// --- the roll ------------------------------------------------------------------------------------

export type RollDenialReason =
  | "breaker_open"
  | "discovery_secret_missing"
  | "gate_denied"
  | "not_eligible"
  | "crew_not_active"
  | "already_rolled"
  | DiscoveryCapReason
  | "no_candidate_token"
  | "reserve_exhausted"
  | "price_confidence"
  | "amount_unavailable";

export interface RollAttempt {
  discovery: DiscoveryRecord | null;
  opportunity: OpportunityRow | null;
  denied?: RollDenialReason;
  /** Neutral copy from the action gate, so a refusal is explained without leaking a reason (spec 62). */
  gateMessage?: string;
  /** Set only when the gate refused because of a rate limit, which makes it a 429 rather than a 403. */
  retryAfterSec?: number;
}

interface EligibilitySnapshot {
  eligible: boolean;
  reasons: readonly string[];
}

async function eligibilitySnapshot(
  env: RuntimeEnv,
  row: PlayerRow,
  now: number,
  riskState: RewardState,
  config: DiggoConfig = DIGGO_CONFIG,
): Promise<EligibilitySnapshot> {
  const levels = crewLevelsOf(row);
  const flags = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM risk_events WHERE wallet = ?1 AND kind LIKE 'abuse_flag%'",
  )
    .bind(row.wallet)
    .first<{ total: number }>();
  const accountAgeSeconds = Math.max(0, now - row.created_at);
  const result = discoveryEligibility(
    {
      accountAgeSeconds,
      activeDays: row.active_days,
      // Every legitimate activation increments active_days (see worker/mining.ts), so it is the
      // authoritative count of valid activations available to this gate.
      validActivations: row.active_days,
      crewTier: crewTier(levels, config).tier,
      maturityBps: maturityBps(accountAgeSeconds, config),
      riskState,
      abuseFlags: flags?.total ?? 0,
    },
    config,
  );
  return { eligible: result.eligible, reasons: result.reasons };
}

interface RollOptions {
  /** True for a client-driven roll, which must be told when the window was already spent. */
  rejectReroll: boolean;
  config?: DiggoConfig;
}

/**
 * The whole gate chain, in the order the spec requires: circuit breakers, then the action gate
 * (risk state, challenge requirement, per-wallet rate limit), then eligibility, then caps, then
 * the token's own data quality and reserve, and only then the deterministic grant.
 */
async function attemptRoll(
  env: RuntimeEnv,
  wallet: string,
  request: Request | null,
  activeMint: string | null,
  now: number,
  options: RollOptions,
): Promise<RollAttempt> {
  const config = options.config ?? DIGGO_CONFIG;
  const tunables = discoveryTunables(env);

  if (await isBreakerOpen(env, "discoveries")) {
    await metric(env, "discovery.roll_denied", 1, { reason: "breaker_open" });
    return { discovery: null, opportunity: null, denied: "breaker_open" };
  }
  if (request) {
    const gate = await gateAction(env, { wallet, request, action: "discovery_roll" });
    if (!gate.allowed) {
      // A rate limit and a risk hold are both refusals, but only one of them is worth retrying, so
      // the recorded outcome distinguishes them instead of labelling every refusal "rate_limited".
      await recordActivity(env, {
        wallet,
        request,
        action: "discovery_roll",
        outcome: gate.retryAfterSec !== undefined ? "rate_limited" : "rejected",
      });
      await metric(env, "discovery.roll_denied", 1, { reason: "gate_denied", state: gate.rewardState });
      return {
        discovery: null,
        opportunity: null,
        denied: "gate_denied",
        gateMessage: gate.publicMessage,
        retryAfterSec: gate.retryAfterSec,
      };
    }
  }

  // attemptRoll() accepts a null request (the activation path rolls without one), so the account
  // gate simply has nothing to fingerprint in that case.
  const player = await getOrCreatePlayer(env, wallet, request ?? undefined);
  if (activationStateOf(player, now) !== "ACTIVE") {
    // Discoveries belong to a working Crew only (spec 3, 22).
    await metric(env, "discovery.roll_denied", 1, { reason: "crew_not_active" });
    return { discovery: null, opportunity: null, denied: "crew_not_active" };
  }
  const snapshot = await eligibilitySnapshot(env, player, now, player.risk_state, config);
  if (!snapshot.eligible) {
    await metric(env, "discovery.roll_denied", 1, { reason: "not_eligible" });
    return { discovery: null, opportunity: null, denied: "not_eligible" };
  }

  // Resolved here rather than on entry so a request that fails the gate, the Crew check or the
  // eligibility rules never touches the commitment table: only an account that can actually roll
  // causes the epoch's commitment to be written.
  const rng = await discoveryRngFor(env, now);
  if (!rng) return { discovery: null, opportunity: null, denied: "discovery_secret_missing" };

  const windowIndex = discoveryWindowIndex(now, tunables);
  const opportunity = await ensureOpportunity(env, rng, wallet, windowIndex, tunables);
  if (opportunity.status === "CONSUMED" || opportunity.status === "EXPIRED") {
    await metric(env, "discovery.reroll_attempt", 1, { window: opportunity.window });
    return { discovery: null, opportunity, denied: "already_rolled" };
  }

  // Account-wide and global value is authorized before the window is spent, so a cap refusal cannot
  // silently burn an opportunity the player was entitled to. The token-scoped caps cannot be
  // evaluated yet — the target is not known until after the roll — so they are checked below.
  // Holds that have left their review window no longer reserve budget (budgetUsage reads them as
  // released), so the budget they were holding is already back in the pool for the players who can
  // still use it (spec 45, 64). This only counts them, so an operator can see the backlog waiting
  // for a human decision.
  await countStaleDiscoveryHolds(env, now, config);
  const accountUsage = await budgetUsage(env, wallet, "", now, config);
  if (discoveryBudgetRemaining(accountUsage, config) <= 0) {
    const probe = discoveryBudgetCheck(accountUsage, { requestedUsd: 0, circuitBreakerOpen: false }, config);
    const reason = probe.reason === "circuit_breaker_open" ? "no_budget_left" : probe.reason ?? "no_budget_left";
    await metric(env, "discovery.roll_denied", 1, { reason });
    return { discovery: null, opportunity, denied: reason };
  }

  if (!(await consumeOpportunity(env, opportunity.id, now))) {
    // Lost the race with a parallel roll in this window: exactly one outcome, ever.
    await metric(env, "discovery.reroll_attempt", 1, { window: opportunity.window, race: "lost" });
    return { discovery: null, opportunity, denied: "already_rolled" };
  }
  await metric(env, "discovery.roll", 1, { window: opportunity.window });

  const scoped: DrawContext = {
    source: rng.source,
    secret: rng.secret,
    wallet,
    eventId: opportunity.event_id,
    window: opportunity.window,
  };
  // The opportunity is spent at this point, win or lose. That is what stops roll-farming.
  if ((await draw(scoped, "")) >= tunables.rollChanceBps / 10_000) {
    await metric(env, "discovery.roll_miss", 1, { window: opportunity.window });
    return { discovery: null, opportunity };
  }

  const candidates = await candidateTokens(env, activeMint, now, config);
  if (candidates.length === 0) {
    await metric(env, "discovery.roll_denied", 1, { reason: "no_candidate_token" });
    return { discovery: null, opportunity, denied: "no_candidate_token" };
  }
  const target = candidates[pickIndex(await draw(scoped, "target"), candidates.length)];
  if (await isBreakerOpen(env, "discovery_reserve", target.mint)) {
    await metric(env, "discovery.breach_denied", 1, { reason: "reserve_breaker_open", mint: target.mint });
    return { discovery: null, opportunity, denied: "breaker_open" };
  }
  const grant = await loadGrantCandidate(env, target, now, config);
  if (!grant) {
    // Too few samples, disagreeing samples or low confidence: pay nothing rather than trust a
    // manipulable spot price (spec 27, 55).
    await metric(env, "discovery.roll_denied", 1, { reason: "price_confidence", mint: target.mint });
    return { discovery: null, opportunity, denied: "price_confidence" };
  }
  // Which sources actually backed this valuation, so an operator can see when a grant rested on the
  // internal history alone and when an external oracle corroborated it.
  await metric(env, "discovery.price_sources", 1, {
    mint: target.mint,
    sources: grant.price.sources.join(","),
    solUsdSource: grant.price.solUsdSource,
  });

  // Now that the target is known, the per-token caps are enforceable. This is the check that stops
  // one popular mine's Discovery Reserve being drained by many accounts in one period (spec 45).
  const usage = await budgetUsage(env, wallet, target.mint, now, config);
  const headroomUsd = discoveryBudgetRemaining(usage, config);
  if (headroomUsd <= 0) {
    const probe = discoveryBudgetCheck(usage, { requestedUsd: 0, circuitBreakerOpen: false }, config);
    const reason = probe.reason === "circuit_breaker_open" ? "no_budget_left" : probe.reason ?? "no_budget_left";
    await metric(env, "discovery.roll_denied", 1, { reason, mint: target.mint });
    return { discovery: null, opportunity, denied: reason };
  }

  const resolved = resolveRarity(rollDiscoveryRarity(await draw(scoped, "rarity"), config), grant.eligibility, config);
  const reserveTokens = epochHeadroomTokens(grant.candidate, now);
  // Size the grant against the tightest of: the resolved tier, the headroom every cap leaves, and
  // what the token's own Discovery Reserve can actually cover.
  const maxGrantUsd = Math.min(rarityTier(resolved.rarity, config).valueUsd, headroomUsd, reserveTokens * grant.price.priceUsd);
  const capped = capRarityByBudget(resolved.rarity, maxGrantUsd, config);
  const amount = normalizedDiscoveryAmount(capped, grant.price, config, maxGrantUsd);
  if (!amount) {
    await metric(env, "discovery.roll_denied", 1, { reason: "amount_unavailable", mint: target.mint });
    return { discovery: null, opportunity, denied: "amount_unavailable" };
  }
  const check = discoveryBudgetCheck(usage, { requestedUsd: amount.valueUsd, circuitBreakerOpen: false }, config);
  if (!check.allowed) {
    await metric(env, "discovery.roll_denied", 1, { reason: check.reason ?? "no_budget_left" });
    return { discovery: null, opportunity, denied: check.reason ?? "no_budget_left" };
  }
  if (amount.amount > reserveTokens) {
    // Never grant more than the indexed Discovery Reserve actually holds (spec 23, 70).
    await metric(env, "discovery.roll_denied", 1, { reason: "reserve_exhausted", mint: target.mint });
    return { discovery: null, opportunity, denied: "reserve_exhausted" };
  }

  const discovery: DiscoveryRecord = {
    id: crypto.randomUUID(),
    eventId: opportunity.event_id,
    window: opportunity.window,
    mint: target.mint,
    symbol: target.symbol,
    rarity: amount.rarity,
    visualEvent: discoveryVisualEvent(amount.rarity),
    tokenAmount: amount.amount,
    valueUsd: amount.valueUsd,
    priceUsd: amount.priceUsd,
    eligibilityScore: grant.score,
    status: "PENDING",
    claimable: true,
    claimedAt: null,
    txSignature: null,
    createdAt: now,
  };
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO discoveries
           (id, event_id, wallet, window, window_index, mint, symbol, rarity, visual_event,
            token_amount, value_usd, price_usd, eligibility_score, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, 'PENDING', ?14)`,
      ).bind(
        discovery.id,
        opportunity.event_id,
        wallet,
        opportunity.window,
        opportunity.window_index,
        discovery.mint,
        discovery.symbol,
        discovery.rarity,
        discovery.visualEvent,
        discovery.tokenAmount,
        discovery.valueUsd,
        discovery.priceUsd,
        discovery.eligibilityScore,
        now,
      ),
      env.DB.prepare(
        "UPDATE discovery_opportunities SET discovery_id = ?1, mint = ?2, rarity = ?3 WHERE id = ?4",
      ).bind(discovery.id, discovery.mint, discovery.rarity, opportunity.id),
    ]);
  } catch (error) {
    // The unique index on discoveries(event_id) is the last line of defence against a duplicate
    // grant for one window. Losing that race is a normal, safe outcome.
    console.error(JSON.stringify({ event: "discovery.grant_conflict", wallet, error: String(error) }));
    await metric(env, "discovery.roll_denied", 1, { reason: "already_rolled" });
    return { discovery: null, opportunity, denied: "already_rolled" };
  }

  await metric(env, "discovery.granted", 1, { rarity: discovery.rarity, mint: discovery.mint });
  await metric(env, "discovery.value_usd", discovery.valueUsd, { rarity: discovery.rarity });
  await metric(env, "discovery.reserve_drain_usd", discovery.valueUsd, { mint: discovery.mint });
  await recordReserveDrainVelocity(env, now);
  return { discovery, opportunity };
}

/**
 * Reserve drain velocity (spec 66): value granted in the last hour relative to what the reserves
 * still hold. A velocity that keeps climbing is the cheapest early warning that caps are being
 * probed, and it is the metric an alert rule should watch.
 */
async function recordReserveDrainVelocity(env: RuntimeEnv, now: number): Promise<void> {
  const [drainedRow, remainingRow] = await Promise.all([
    env.DB.prepare(
      `SELECT COALESCE(SUM(value_usd), 0) AS drained FROM discoveries
         WHERE status IN ${COUNTED_STATUSES} AND created_at >= ?1`,
    )
      .bind(now - 3_600)
      .first<{ drained: number }>(),
    env.DB.prepare(
      `SELECT COALESCE(SUM(discovery_reserve_remaining * price_usd), 0) AS remaining
         FROM tokens WHERE status = 'MINING_ACTIVE'`,
    ).first<{ remaining: number }>(),
  ]);
  const drained = drainedRow?.drained ?? 0;
  const left = remainingRow?.remaining ?? 0;
  await metric(env, "discovery.reserve_drain_velocity", left > 0 ? drained / left : 0, {
    drainedUsd: drained.toFixed(4),
    reserveUsd: left.toFixed(2),
  });
}

// --- reads ---------------------------------------------------------------------------------------

interface DiscoveryRow {
  id: string;
  event_id: string;
  window: string;
  mint: string;
  symbol: string;
  rarity: string;
  visual_event: string;
  token_amount: number;
  value_usd: number;
  price_usd: number;
  eligibility_score: number;
  status: DiscoveryRecord["status"];
  claimed_at: number | null;
  tx_signature: string | null;
  created_at: number;
}

export function toDiscoveryRecord(row: DiscoveryRow): DiscoveryRecord {
  return {
    id: row.id,
    eventId: row.event_id,
    window: row.window,
    mint: row.mint,
    symbol: row.symbol,
    rarity: row.rarity,
    visualEvent: discoveryVisualEvent(row.rarity),
    tokenAmount: row.token_amount,
    valueUsd: row.value_usd,
    priceUsd: row.price_usd,
    eligibilityScore: row.eligibility_score,
    status: row.status,
    // PENDING is the only state a client may act on; ELIGIBLE is already committed to the keeper.
    claimable: row.status === "PENDING",
    claimedAt: row.claimed_at,
    txSignature: row.tx_signature,
    createdAt: row.created_at,
  };
}

export async function loadDiscovery(env: RuntimeEnv, id: string): Promise<DiscoveryRecord | null> {
  const row = await env.DB.prepare("SELECT * FROM discoveries WHERE id = ?1").bind(id).first<DiscoveryRow>();
  return row ? toDiscoveryRecord(row) : null;
}

// --- routes --------------------------------------------------------------------------------------

async function authenticatedWallet(request: Request, env: RuntimeEnv): Promise<string | null> {
  const wallet = await sessionWallet(request, env);
  return wallet && isBase58Address(wallet) ? wallet : null;
}

/**
 * POST /api/discovery/opportunity
 *
 * Returns this window's single-use opportunity for the authenticated wallet, authoring it lazily
 * if this is the first request in the window. Idempotent inside a window: same event id, same
 * nonce, nothing created twice. An account that could not roll gets no opportunity authored at
 * all, so repeated rejected requests cannot grow D1 or consume a budget row (spec 70).
 */
export async function discoveryOpportunity(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await authenticatedWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "discovery-opportunity", 30, 3_600))) {
    await metric(env, "discovery.opportunity_denied", 1, { reason: "rate_limited" });
    return apiError("Too many discovery requests, slow down", 429);
  }
  if (await isBreakerOpen(env, "discoveries")) {
    await metric(env, "discovery.opportunity_denied", 1, { reason: "breaker_open" });
    return apiError("Discoveries are paused for now", 503);
  }

  const now = Math.floor(Date.now() / 1_000);
  const tunables = discoveryTunables(env);
  const windowIndex = discoveryWindowIndex(now, tunables);
  const player = await getOrCreatePlayer(env, wallet, request);
  const existing = await loadOpportunity(env, wallet, windowIndex);
  if (existing) {
    await metric(env, "discovery.opportunity", 1, { reused: "true" });
    return json({ opportunity: toOpportunityView(existing) });
  }

  const gate = await gateAction(env, { wallet, request, action: "discovery_roll" });
  const crewActive = activationStateOf(player, now) === "ACTIVE";
  const snapshot = await eligibilitySnapshot(env, player, now, player.risk_state);
  if (!crewActive || !snapshot.eligible || !gate.allowed) {
    const reason = !crewActive ? "crew_not_active" : !snapshot.eligible ? "not_eligible" : "gate_denied";
    await metric(env, "discovery.opportunity_denied", 1, { reason });
    return json({
      opportunity: null,
      crewActive,
      eligible: snapshot.eligible,
      challengeRequired: gate.challengeRequired,
      // Neutral copy only: the internal reason code never leaves the server (spec 62).
      publicMessage: "No discovery opportunity is available for this account yet.",
    });
  }
  const rng = await discoveryRngFor(env, now);
  if (!rng) return apiError("Discoveries are temporarily unavailable", 503);
  const opportunity = await ensureOpportunity(env, rng, wallet, windowIndex, tunables);
  await metric(env, "discovery.opportunity", 1, { reused: "false" });
  return json({
    opportunity: toOpportunityView(opportunity),
    crewActive: true,
    eligible: true,
    challengeRequired: gate.challengeRequired,
  });
}

/**
 * POST /api/discovery/roll
 *
 * Rolls this window's opportunity. The outcome is decided by the server (HMAC over the
 * opportunity, the account and the window) and the opportunity is spent whatever the result, so a
 * second attempt in the same window is refused instead of rerolled.
 */
export async function rollDiscoveryRequest(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await authenticatedWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ mint?: string }>(request).catch(() => ({}) as { mint?: string });
  const player = await getOrCreatePlayer(env, wallet, request);
  const now = Math.floor(Date.now() / 1_000);
  const outcome = await attemptRoll(env, wallet, request, body.mint ?? player.active_mint, now, {
    rejectReroll: true,
  });
  if (outcome.denied === "already_rolled") return apiError("This window has already been rolled", 409);
  if (outcome.denied === "gate_denied") {
    // 429 only when waiting would actually help; a risk hold is a 403 with the gate's neutral copy.
    return outcome.retryAfterSec !== undefined
      ? apiError(outcome.gateMessage ?? "Too many discovery requests, slow down", 429)
      : apiError(outcome.gateMessage ?? "Discoveries are unavailable for this account right now", 403);
  }
  if (outcome.denied === "breaker_open" || outcome.denied === "discovery_secret_missing") {
    return apiError("Discoveries are paused for now", 503);
  }
  // A miss, or a refusal the player has no way to influence. Either way it is a normal 200 with no
  // reward, and the specific reason stays server-side (spec 62).
  return json({
    discovery: outcome.discovery,
    window: outcome.opportunity?.window ?? discoveryWindowLabel(discoveryWindowIndex(now, discoveryTunables(env))),
    rolled: true,
  });
}

/**
 * POST /api/discovery/claim/challenge
 *
 * Issues the short-lived, single-use, wallet- and discovery-bound challenge a real-value claim has
 * to be signed with (spec 46, 47). Without it a captured request body cannot be replayed for a
 * second reward.
 */
export async function claimDiscoveryChallenge(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await authenticatedWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "discovery-claim-challenge", 20, 3_600))) {
    return apiError("Too many claim attempts, slow down", 429);
  }
  const { discoveryId } = await readJson<{ discoveryId?: string }>(request);
  if (typeof discoveryId !== "string" || discoveryId.length === 0) return apiError("Missing discovery id");
  const discovery = await env.DB.prepare("SELECT wallet, status, mint FROM discoveries WHERE id = ?1")
    .bind(discoveryId)
    .first<{ wallet: string; status: string; mint: string }>();
  // "Not yours" and "does not exist" answer identically, so this cannot probe other players' finds.
  if (!discovery || discovery.wallet !== wallet) return apiError("Discovery not found", 404);
  if (discovery.status === "CLAIMED") return apiError("This discovery has already been claimed", 409);
  if (discovery.status === "REJECTED") return apiError("This discovery can no longer be claimed", 409);

  const gate = await gateAction(env, { wallet, request, action: "claim_discovery" });
  if (!gate.allowed) return apiError(gate.publicMessage ?? "Claims are unavailable right now", 403);
  // Checked against this discovery's own mint, so a halt opened for one mine (which is what the
  // reconciliation cron does on a reserve divergence) stops that mine's payouts and no others.
  if (await isBreakerOpen(env, "claims", discovery.mint)) {
    return apiError("Claims are paused for now", 503);
  }

  // Issued through the shared challenge helper so the nonce is bound to the wallet, the action and
  // this exact discovery id as a structured `resource` - never re-derivable from the message text.
  const challenge = await issueChallenge(env, {
    wallet,
    action: CLAIM_DISCOVERY_ACTION,
    resource: discoveryId,
    title: "Claim Diggo discovery",
    ttlSeconds: CLAIM_CHALLENGE_TTL_SECONDS,
  });
  return json({ nonce: challenge.nonce, message: challenge.message, expiresIn: CLAIM_CHALLENGE_TTL_SECONDS });
}

/**
 * POST /api/discovery/claim
 *
 * Verifies the signed single-use challenge, then moves PENDING -> ELIGIBLE with one guarded
 * UPDATE. Exactly one concurrent request can win that transition and only the winner queues the
 * keeper payout. The discovery id travels to the program as discovery_id, which seeds an on-chain
 * receipt, so even a repeated keeper call can never pay the same discovery twice (spec 57, 70).
 */
export async function claimDiscovery(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await authenticatedWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const body = await readJson<{ discoveryId?: string; nonce?: string; signature?: string }>(request);
  if (typeof body.discoveryId !== "string" || !body.nonce || !body.signature) {
    return apiError("Incomplete claim proof");
  }
  const key = challengeKey(CLAIM_DISCOVERY_ACTION, body.nonce);
  const challenge = await loadChallenge(env, key);
  if (!challenge || challenge.wallet !== wallet) {
    // Nothing usable is left in KV, so the nonce table has the final word: a nonce that was already
    // consumed is a replay, not merely a late request (spec 47).
    const status = await consumeChallengeNonce(env, {
      nonce: body.nonce,
      wallet,
      action: CLAIM_DISCOVERY_ACTION,
      resource: body.discoveryId,
    });
    if (status === "replay") return apiError("Challenge already used", 409);
    return apiError("Challenge expired", 401);
  }
  // The challenge names the discovery it was issued for. Comparing the bound resource - not a
  // substring of the signed text - is what stops a signature over one discovery's challenge from
  // being replayed as a claim for another discovery the same wallet owns.
  if ((challenge.resource ?? "") !== body.discoveryId) {
    await recordActivity(env, { wallet, request, action: "claim_discovery", outcome: "failed_challenge" });
    return apiError("Challenge does not match this discovery", 401);
  }
  if (!verifyWalletSignature(wallet, challenge.message, body.signature)) {
    await recordActivity(env, { wallet, request, action: "claim_discovery", outcome: "failed_challenge" });
    return apiError("Invalid wallet signature", 401);
  }
  // Single-use, in the authoritative table: the conditional UPDATE in consumeChallengeNonce is what
  // makes the nonce spent in every colo, where deleting the KV record only clears the local cache.
  // It happens before anything of value does, so a replay finds nothing.
  const consumed = await consumeChallengeNonce(env, {
    nonce: body.nonce,
    wallet,
    action: CLAIM_DISCOVERY_ACTION,
    resource: body.discoveryId,
  });
  if (consumed !== "ok") {
    await recordActivity(env, { wallet, request, action: "claim_discovery", outcome: "replay" });
    return apiError(
      consumed === "replay" ? "Challenge already used" : "Challenge expired",
      consumed === "replay" ? 409 : 401,
    );
  }
  await env.TOKEN_CACHE.delete(key);

  const row = await env.DB.prepare(
    "SELECT id, wallet, mint, status, tx_signature, token_amount FROM discoveries WHERE id = ?1",
  )
    .bind(body.discoveryId)
    .first<{
      id: string;
      wallet: string;
      mint: string;
      status: string;
      tx_signature: string | null;
      token_amount: number;
    }>();
  if (!row || row.wallet !== wallet) return apiError("Discovery not found", 404);
  if (row.status === "CLAIMED") {
    // Idempotent: a retried claim for an already-paid discovery is a success, never a second payout.
    return json({ status: "CLAIMED", txSignature: row.tx_signature, queued: false });
  }
  if (row.status === "REJECTED") return apiError("This discovery can no longer be claimed", 409);
  if (row.status === "HELD") {
    // A hold is resolved by a human or the risk pipeline, never by this request. Turning the row
    // REJECTED here would let a player's own claim attempt - or the mere passage of the review
    // window - destroy a reward that was already granted (spec 45, 53). Leaving the window only
    // stops the grant from reserving budget (budgetUsage), which is not a reason to refuse it.
    await metric(env, "discovery.claim_denied", 1, { reason: "held", mint: row.mint });
    return apiError("This discovery is under review", 403);
  }

  // This discovery's own mint, not just the scope-wide row: a mint-scoped claims halt is exactly
  // what the reconciliation cron opens when that mine's reserve diverged (spec 65, 78).
  if (await isBreakerOpen(env, "claims", row.mint)) {
    await metric(env, "discovery.claim_denied", 1, { reason: "breaker_open" });
    return apiError("Claims are paused for now", 503);
  }
  const reserve = await reserveState(env, row.mint);
  if ((await isBreakerOpen(env, "discovery_reserve", row.mint)) || reserve.paused) {
    await metric(env, "discovery.claim_denied", 1, { reason: "reserve_breaker_open", mint: row.mint });
    return apiError("This mine's discovery payouts are paused", 503);
  }
  const gate = await gateAction(env, { wallet, request, action: "claim_discovery" });
  if (!gate.allowed) {
    await recordActivity(env, {
      wallet,
      request,
      action: "claim_discovery",
      outcome: gate.retryAfterSec !== undefined ? "rate_limited" : "rejected",
    });
    await metric(env, "discovery.claim_denied", 1, { reason: "gate_denied", state: gate.rewardState });
    return gate.retryAfterSec !== undefined
      ? apiError(gate.publicMessage ?? "Too many claim attempts, slow down", 429)
      : apiError(gate.publicMessage ?? "Claims are unavailable right now", 403);
  }

  // The reserve is re-checked here, not only at grant time: many accounts can drain one mine's
  // reserve between the grant and the claim. The refusal deliberately leaves the row PENDING, so a
  // stale index cannot destroy a legitimate reward — it stays claimable once the index catches up —
  // while the keeper is never handed a payout that cannot settle.
  if (reserve.remainingTokens < row.token_amount) {
    await metric(env, "discovery.claim_denied", 1, { reason: "reserve_exhausted", mint: row.mint });
    return apiError("This discovery cannot be paid from the remaining reserve right now", 409);
  }

  // The guarded transition IS the concurrency control: changes === 1 means this request owns the
  // payout, anything else means a parallel claim already took it.
  const transition = await env.DB.prepare(
    "UPDATE discoveries SET status = 'ELIGIBLE' WHERE id = ?1 AND wallet = ?2 AND status = 'PENDING'",
  )
    .bind(row.id, wallet)
    .run();
  if (transition.meta.changes !== 1) {
    const current = await env.DB.prepare("SELECT status, tx_signature FROM discoveries WHERE id = ?1")
      .bind(row.id)
      .first<{ status: string; tx_signature: string | null }>();
    await metric(env, "discovery.claim_conflict", 1, { status: current?.status ?? "unknown" });
    if (current?.status === "CLAIMED") {
      return json({ status: "CLAIMED", txSignature: current.tx_signature, queued: false });
    }
    if (current?.status === "ELIGIBLE") {
      // Already committed and in flight. Requeueing is safe: the on-chain receipt is what makes a
      // repeated keeper call idempotent, so this cannot double-pay.
      await env.INDEXING_QUEUE.send({ type: "claim_discovery", discoveryId: row.id });
      return json({ status: "ELIGIBLE", queued: true });
    }
    return apiError("This discovery can no longer be claimed", 409);
  }

  await recordActivity(env, { wallet, request, action: "claim_discovery", outcome: "ok" });
  await metric(env, "discovery.claim", 1, { mint: row.mint });
  await env.INDEXING_QUEUE.send({ type: "claim_discovery", discoveryId: row.id });
  return json({ status: "ELIGIBLE", queued: true }, { status: 202 });
}

/** GET /api/player/:wallet/discoveries — authenticated self-read, plus the live opportunity. */
export async function listDiscoveries(request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  const authenticated = await sessionWallet(request, env);
  if (!authenticated || authenticated !== wallet) return apiError("Wallet authentication required", 401);
  const now = Math.floor(Date.now() / 1_000);
  const result = await env.DB.prepare(
    "SELECT * FROM discoveries WHERE wallet = ?1 ORDER BY created_at DESC, id DESC LIMIT 50",
  )
    .bind(wallet)
    .all<DiscoveryRow>();
  const opportunity = await loadOpportunity(env, wallet, discoveryWindowIndex(now, discoveryTunables(env)));
  return json({
    discoveries: (result.results ?? []).map(toDiscoveryRecord),
    opportunity: opportunity ? toOpportunityView(opportunity) : null,
  });
}

/**
 * Compatibility entry point for the activation path in worker/mining.ts. It runs the same hardened
 * pipeline and ignores the legacy per-activation probability: the configured per-window chance and
 * the single-use opportunity govern the roll now, so an activation can never roll more often than
 * the window allows.
 */
export async function rollDiscovery(
  env: RuntimeEnv,
  wallet: string,
  activeMint: string | null,
  _discoveryChance?: number,
): Promise<DiscoveryRecord | null> {
  const now = Math.floor(Date.now() / 1_000);
  const outcome = await attemptRoll(env, wallet, null, activeMint, now, { rejectReroll: false });
  return outcome.discovery;
}

/**
 * Safely returns a discovery to ELIGIBLE after a failed keeper call. Guarded so it can never
 * un-claim a discovery that a parallel attempt already paid, and so retrying it is a no-op.
 */
export async function recoverEligibleDiscovery(env: RuntimeEnv, id: string, reason: string): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE discoveries SET status = 'ELIGIBLE', failure_reason = ?1
      WHERE id = ?2 AND status NOT IN ('ELIGIBLE', 'CLAIMED')`,
  )
    .bind(reason, id)
    .run();
  await metric(env, "discovery.recovered", 1, { reason, changed: String(result.meta.changes ?? 0) });
}

// --- public verifiability (spec 55) ---------------------------------------------------------------

/**
 * GET /api/discovery/commitments
 *
 * The RNG commitments a player needs to audit the rolls they were given: the epoch in progress, the
 * commitment already published for the one after it, and the seeds of recently ended epochs. No
 * authentication, because a commitment nobody can read is not a commitment.
 *
 * Reading this also publishes, so the commitment for an epoch exists before that epoch starts even
 * if the cron trigger has not run.
 */
export async function discoveryCommitments(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "discovery-commitments", 240))) {
    return apiError("Too many requests, slow down", 429);
  }
  const now = Math.floor(Date.now() / 1_000);
  const summary = await prepublishRngCommitments(env, now);
  const current = summary.currentEpoch === null ? null : await loadCommitment(env, summary.currentEpoch);
  const next = summary.nextEpoch === null ? null : await loadCommitment(env, summary.nextEpoch);
  const revealed = await env.DB.prepare(
    "SELECT * FROM rng_commitments WHERE seed IS NOT NULL AND ends_at <= ?1 ORDER BY epoch DESC LIMIT 7",
  )
    .bind(now)
    .all<RngCommitmentRow>();
  return json({
    epochSeconds: rngEpochSecondsOf(env),
    currentEpoch: summary.currentEpoch,
    current: current ? commitmentView(toRngCommitmentRecord(current), now) : null,
    next: next ? commitmentView(toRngCommitmentRecord(next), now) : null,
    revealedEpochs: (revealed.results ?? []).map((row) => commitmentView(toRngCommitmentRecord(row), now)),
    verification: rollVerificationRecipe(),
  });
}

/**
 * GET /api/discovery/commitments/:epoch
 *
 * One epoch's commitment, and its seed once the epoch has ended. While the epoch is running the
 * response carries the commitment and nothing else, so the rolls of an open epoch stay
 * unpredictable while still being bound to a promise the server can no longer change.
 */
export async function discoveryCommitmentReveal(
  request: Request,
  env: RuntimeEnv,
  epochRaw: string,
): Promise<Response> {
  if (!(await checkRateLimit(request, env, "discovery-commitments", 240))) {
    return apiError("Too many requests, slow down", 429);
  }
  const epoch = Number(epochRaw);
  if (!Number.isInteger(epoch) || epoch < 0) return apiError("Unknown commitment epoch", 404);
  const now = Math.floor(Date.now() / 1_000);
  await prepublishRngCommitments(env, now);
  const row = await loadCommitment(env, epoch);
  if (!row) return apiError("Unknown commitment epoch", 404);
  const record = toRngCommitmentRecord(row);
  return json({
    commitment: commitmentView(record, now),
    // Reminder for verifiers: reconstruct the event id and window from the opportunity the API
    // returned, take the epoch that contains the discovery's created_at, then re-derive the roll.
    verification: rollVerificationRecipe(),
  });
}
