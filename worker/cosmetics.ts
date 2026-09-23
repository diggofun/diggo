/**
 * Cosmetics and achievements (spec 34).
 *
 * Cosmetics are purely visual: the catalog lives in shared/social.ts, is scanned there for any
 * gameplay/economic effect field at import time, and nothing in this module can attach Power,
 * luck, block share or a reward multiplier to a cosmetic. Purchasable cosmetics are metadata only
 * - payment is not implemented, they are reported as 'coming_soon' and refused by the equip
 * endpoint.
 *
 * Achievements are evaluated from gameplay progression (activations, streaks, upgrades, tiers,
 * discoveries, blocks), never from token amounts, and their ORE payout is capped.
 */
import { CREW_COMPONENTS, DIGGO_CONFIG, crewTier, crewTotalLevel, oreCapacity, type CrewLevels } from "../shared/economics";
import {
  ACHIEVEMENT_CATALOG,
  ACHIEVEMENT_ORE_TOTAL_CAP,
  COSMETIC_CATALOG,
  COSMETIC_SLOTS,
  PURCHASABLE_COSMETICS_ENABLED,
  achievementMetrics,
  cappedAchievementOre,
  cosmeticById,
  cosmeticSlot,
  evaluateAchievements,
  SEASONAL_POINT_VALUES,
  seasonStatus,
  seasonalProgressPoints,
  selectSeason,
  unlockedCosmeticIds,
  type AchievementDefinition,
  type CosmeticItem,
  type CosmeticSlot,
  type SeasonDefinition,
  type SeasonalEventKind,
} from "../shared/social";
import { sessionWallet } from "./auth";
import type { RuntimeEnv } from "./env";
import { apiError, checkWalletRateLimit, json, readJson } from "./http";
import { crewLevelsForWallet, crewLevelsOf, getOrCreatePlayer, loadPlayerAccount } from "./player";
import { REALIZED_DISCOVERY_PREDICATE } from "./telemetry";

const CATALOG_MARKER_KEY = "social:catalog:v1";
let catalogSeeded = false;

interface SocialMetricsRow {
  blocks_won: number;
  mine_switches: number;
  fully_mined_witnessed: number;
}

interface SeasonRow {
  id: string;
  name: string;
  starts_at: number;
  ends_at: number;
}

interface EarnedAchievementRow {
  achievement_id: string;
  ore_granted: number;
  awarded_at: number;
}

interface OwnedCosmeticRow {
  cosmetic_id: string;
  acquired_at: number;
}

interface LoadoutRow {
  slot: string;
  cosmetic_id: string;
}

function unlockRefOf(item: CosmeticItem): string | null {
  if (item.unlock === null) return null;
  switch (item.unlock.type) {
    case "streak":
      return String(item.unlock.day);
    case "achievement":
      return item.unlock.achievementId;
    case "tier":
      return String(item.unlock.tier);
    case "season_points":
      return String(item.unlock.points);
    default:
      return null;
  }
}

/**
 * Seeds the achievements and cosmetics catalogs from shared/social.ts. Catalogs are reference data,
 * so rows are only ever inserted; a KV marker keeps the steady state at zero writes.
 */
export async function ensureCatalog(env: RuntimeEnv): Promise<void> {
  if (catalogSeeded) return;
  if (await env.TOKEN_CACHE.get(CATALOG_MARKER_KEY)) {
    catalogSeeded = true;
    return;
  }
  const achievementStatements = ACHIEVEMENT_CATALOG.map((entry) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO achievements (id, name, description, category, metric, threshold, ore, badge_id, title_id)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
    ).bind(
      entry.id,
      entry.name,
      entry.description,
      entry.category,
      entry.metric,
      entry.threshold,
      entry.ore,
      entry.badge,
      entry.title,
    ),
  );
  const cosmeticStatements = COSMETIC_CATALOG.map((item) =>
    env.DB.prepare(
      "INSERT OR IGNORE INTO cosmetics (id, kind, name, description, source, status, unlock_kind, unlock_ref)" +
        " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    ).bind(
      item.id,
      item.kind,
      item.name,
      item.description,
      item.source,
      item.status,
      item.unlock?.type ?? null,
      unlockRefOf(item),
    ),
  );
  await env.DB.batch([...achievementStatements, ...cosmeticStatements]);
  await env.TOKEN_CACHE.put(CATALOG_MARKER_KEY, "1", { expirationTtl: 86_400 });
  catalogSeeded = true;
}

export async function currentSeason(env: RuntimeEnv, now: number): Promise<SeasonDefinition> {
  const rows = (await env.DB.prepare("SELECT id, name, starts_at, ends_at FROM seasons ORDER BY starts_at").all<SeasonRow>())
    .results;
  const selected = selectSeason(
    rows.map((row) => ({ id: row.id, name: row.name, startsAt: row.starts_at, endsAt: row.ends_at })),
    now,
  );
  if (selected) return selected;
  return { id: "s1-genesis", name: "Season 1 - Genesis Dig", startsAt: now, endsAt: now + 90 * 86_400 };
}

async function loadSocialMetrics(env: RuntimeEnv, wallet: string): Promise<SocialMetricsRow> {
  await env.DB.prepare("INSERT OR IGNORE INTO player_social_metrics (wallet) VALUES (?1)").bind(wallet).run();
  const row = await env.DB.prepare(
    "SELECT blocks_won, mine_switches, fully_mined_witnessed FROM player_social_metrics WHERE wallet = ?1",
  )
    .bind(wallet)
    .first<SocialMetricsRow>();
  return row ?? { blocks_won: 0, mine_switches: 0, fully_mined_witnessed: 0 };
}

/**
 * How many discoveries this wallet has actually found.
 *
 * v2 indexes the roll, not the discovery: every `create_discovery_roll` writes a PENDING row and
 * only `settle_discovery` turns one into a discovery. The indexed `rarity` is the program's
 * 0-based tier index, so tier 0 is a real tier (the cheapest one) and never means "nothing" - a
 * roll the seed gives no outcome to settles at tier 0 with no units. The payout is what separates a
 * discovery from an empty roll, which is also all a v4 `discoveries` row ever recorded.
 */
async function countDiscoveries(env: RuntimeEnv, wallet: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS found FROM discovery_events WHERE wallet = ?1 AND" + REALIZED_DISCOVERY_PREDICATE,
  )
    .bind(wallet)
    .first<{ found: number }>();
  return row?.found ?? 0;
}

async function earnedAchievements(env: RuntimeEnv, wallet: string): Promise<EarnedAchievementRow[]> {
  const rows = await env.DB.prepare(
    "SELECT achievement_id, ore_granted, awarded_at FROM player_achievements WHERE wallet = ?1 ORDER BY awarded_at",
  )
    .bind(wallet)
    .all<EarnedAchievementRow>();
  return rows.results;
}

export interface AchievementSyncResult {
  readonly awarded: readonly AchievementDefinition[];
  readonly oreGranted: number;
}

/**
 * The crew levels the wallet's indexed PlayerAccount mirror reports, or null when there is no
 * usable mirror to read.
 *
 * `crewLevelsForWallet` answers all zeros for a wallet the indexer has not reached yet, which is the
 * right answer for a profile and the wrong one for ORE: zero sits below the crew floor, so
 * `oreCapacity` rejects it. Null means "unknown" here, so a payout that has to be measured against
 * capacity is deferred rather than priced from levels nobody reported. A mirror row whose levels
 * fall outside the configured range is treated the same way, because a row that cannot state a real
 * crew cannot state a real capacity either.
 */
async function indexedCrewLevels(env: RuntimeEnv, wallet: string): Promise<CrewLevels | null> {
  const account = await loadPlayerAccount(env, wallet);
  if (!account) return null;
  const levels = crewLevelsOf(account);
  for (const component of CREW_COMPONENTS) {
    const level = levels[component];
    if (!Number.isInteger(level) || level < DIGGO_CONFIG.crew.minLevel || level > DIGGO_CONFIG.crew.maxLevel) {
      return null;
    }
  }
  return levels;
}

/**
 * Awards every achievement whose gameplay threshold the player has reached, once. The ORE payout is
 * capped across all achievements by ACHIEVEMENT_ORE_TOTAL_CAP and clamped to ORE storage capacity.
 *
 * An award is written in two halves that are not one write - the row records the ORE it granted,
 * then that ORE is credited against the crew's storage capacity - so a wallet whose crew mirror is
 * not indexed yet is skipped whole and retried on a later sweep. Awarding it early would either
 * throw between the two halves, leaving the ORE recorded but never paid, or pay an amount no crew
 * was shown to be able to hold. Skipping writes nothing, so the next sweep still owes the award.
 */
export async function syncAchievements(
  env: RuntimeEnv,
  wallet: string,
  now: number,
  /** The request that triggered this sync, when there was one; the cron sweeps without it. */
  _request?: Request,
): Promise<AchievementSyncResult> {
  const player = await getOrCreatePlayer(env, wallet);
  const crewLevels = await indexedCrewLevels(env, wallet);
  if (crewLevels === null) return { awarded: [], oreGranted: 0 };
  const [metricsRow, discoveries, earned] = await Promise.all([
    loadSocialMetrics(env, wallet),
    countDiscoveries(env, wallet),
    earnedAchievements(env, wallet),
  ]);
  const metrics = achievementMetrics({
    crewLevels,
    activeDays: player.active_days ?? 0,
    streak: player.streak ?? 0,
    discoveries,
    blocks: metricsRow.blocks_won,
    mineSwitches: metricsRow.mine_switches,
    fullyMined: metricsRow.fully_mined_witnessed > 0,
  });
  const newlyEarned = evaluateAchievements(metrics, earned.map((row) => row.achievement_id));
  if (newlyEarned.length === 0) return { awarded: [], oreGranted: 0 };

  let awardedOre = earned.reduce((total, row) => total + row.ore_granted, 0);
  const grants: { entry: AchievementDefinition; ore: number }[] = [];
  for (const entry of newlyEarned) {
    const ore = cappedAchievementOre(awardedOre, entry.ore, ACHIEVEMENT_ORE_TOTAL_CAP);
    awardedOre += ore;
    grants.push({ entry, ore });
  }
  const inserted = await env.DB.batch(
    grants.map((grant) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO player_achievements (wallet, achievement_id, ore_granted, awarded_at)" +
          " VALUES (?1, ?2, ?3, ?4)",
      ).bind(wallet, grant.entry.id, grant.ore, now),
    ),
  );
  const confirmed = grants.filter((_grant, index) => (inserted[index]?.meta?.changes ?? 0) > 0);
  const oreGranted = confirmed.reduce((total, grant) => total + grant.ore, 0);
  if (oreGranted > 0) {
    const capacity = oreCapacity(crewLevels);
    // COALESCE because the profile's ORE mirror is nullable ("not indexed yet"), and adding to
    // NULL would drop a grant this function has already recorded against the player.
    await env.DB.prepare("UPDATE players SET ore_balance = MIN(COALESCE(ore_balance, 0) + ?1, ?2) WHERE wallet = ?3")
      .bind(oreGranted, capacity, wallet)
      .run();
  }
  return { awarded: confirmed.map((grant) => grant.entry), oreGranted };
}

async function ownedCosmeticIds(env: RuntimeEnv, wallet: string): Promise<string[]> {
  const rows = await env.DB.prepare("SELECT cosmetic_id, acquired_at FROM player_cosmetics WHERE wallet = ?1")
    .bind(wallet)
    .all<OwnedCosmeticRow>();
  return rows.results.map((row) => row.cosmetic_id);
}

async function equippedBySlot(env: RuntimeEnv, wallet: string): Promise<Record<string, string>> {
  const rows = (await env.DB.prepare("SELECT slot, cosmetic_id FROM player_loadout WHERE wallet = ?1").bind(wallet).all<LoadoutRow>())
    .results;
  const equipped: Record<string, string> = {};
  for (const row of rows) equipped[row.slot] = row.cosmetic_id;
  return equipped;
}

/** Grants every cosmetic the player's progression has earned. Idempotent: only inserts. */
export async function syncCosmeticUnlocks(
  env: RuntimeEnv,
  wallet: string,
  now: number,
  _request?: Request,
): Promise<string[]> {
  const player = await getOrCreatePlayer(env, wallet);
  const [earned, owned, seasonPoints] = await Promise.all([
    earnedAchievements(env, wallet),
    ownedCosmeticIds(env, wallet),
    storedSeasonalPoints(env, wallet, now),
  ]);
  const unlocked = unlockedCosmeticIds({
    streak: player.streak ?? 0,
    crewTier: crewTier(await crewLevelsForWallet(env, wallet)).tier,
    achievementIds: earned.map((row) => row.achievement_id),
    seasonPoints,
  });
  const missing = unlocked.filter((id) => !owned.includes(id));
  if (missing.length === 0) return [];
  await env.DB.batch(
    missing.map((id) =>
      env.DB.prepare("INSERT OR IGNORE INTO player_cosmetics (wallet, cosmetic_id, acquired_at) VALUES (?1, ?2, ?3)").bind(
        wallet,
        id,
        now,
      ),
    ),
  );
  return missing;
}

export async function getCosmetics(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const now = Math.floor(Date.now() / 1_000);
  await ensureCatalog(env);
  await syncCosmeticUnlocks(env, wallet, now, request);
  const [catalog, owned, equipped] = await Promise.all([
    env.DB.prepare("SELECT id, kind, name, description, source, status, unlock_kind, unlock_ref FROM cosmetics ORDER BY kind, id").all<{
      id: string;
      kind: string;
      name: string;
      description: string;
      source: "earned" | "purchasable";
      status: "available" | "coming_soon";
      unlock_kind: string | null;
      unlock_ref: string | null;
    }>(),
    ownedCosmeticIds(env, wallet),
    equippedBySlot(env, wallet),
  ]);
  return json({
    catalog: catalog.results.map((row) => ({
      id: row.id,
      kind: row.kind,
      slot: slotOf(row.kind),
      name: row.name,
      description: row.description,
      source: row.source,
      status: row.status,
      unlockKind: row.unlock_kind,
      unlockRef: row.unlock_ref,
      unlocked: owned.includes(row.id),
      equipped: Object.values(equipped).includes(row.id),
    })),
    equipped,
    slots: COSMETIC_SLOTS,
    purchasesEnabled: PURCHASABLE_COSMETICS_ENABLED,
  });
}

function slotOf(kind: string): CosmeticSlot | null {
  const item = COSMETIC_CATALOG.find((entry) => entry.kind === kind);
  return item ? cosmeticSlot(item.kind) : null;
}

/**
 * Equips an owned, earned cosmetic into its slot. Purchasable cosmetics are refused: payment is not
 * implemented and cosmetics can never be tied to Power or rewards (spec 34).
 */
export async function equipCosmetic(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "cosmetic-equip", 30, 60))) {
    return apiError("Too many equip requests, slow down", 429);
  }
  const { cosmeticId } = await readJson<{ cosmeticId?: string }>(request);
  const item = typeof cosmeticId === "string" ? cosmeticById(cosmeticId) : null;
  if (!item) return apiError("Unknown cosmetic", 404);
  if (item.source === "purchasable") return apiError("Cosmetic purchases are coming soon", 409);
  const now = Math.floor(Date.now() / 1_000);
  await ensureCatalog(env);
  await syncCosmeticUnlocks(env, wallet, now, request);
  const owned = await ownedCosmeticIds(env, wallet);
  if (!owned.includes(item.id)) return apiError("Cosmetic not unlocked", 403);
  const slot = cosmeticSlot(item.kind);
  await env.DB.prepare(
    "INSERT INTO player_loadout (wallet, slot, cosmetic_id, equipped_at) VALUES (?1, ?2, ?3, ?4)" +
      " ON CONFLICT (wallet, slot) DO UPDATE SET cosmetic_id = excluded.cosmetic_id, equipped_at = excluded.equipped_at",
  )
    .bind(wallet, slot, item.id, now)
    .run();
  return json({ equipped: { ...(await equippedBySlot(env, wallet)) }, slot, cosmeticId: item.id });
}

export async function unequipCosmetic(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const { slot } = await readJson<{ slot?: string }>(request);
  if (!slot || !(COSMETIC_SLOTS as readonly string[]).includes(slot)) return apiError("Unknown cosmetic slot");
  await env.DB.prepare("DELETE FROM player_loadout WHERE wallet = ?1 AND slot = ?2").bind(wallet, slot).run();
  return json({ equipped: { ...(await equippedBySlot(env, wallet)) }, slot });
}

/** Achievement catalog joined with the caller's earned state and current progress. */
export async function playerAchievements(request: Request, env: RuntimeEnv, wallet: string): Promise<Response> {
  const authenticated = await sessionWallet(request, env);
  if (!authenticated || authenticated !== wallet) return apiError("Wallet authentication required", 401);
  const now = Math.floor(Date.now() / 1_000);
  await ensureCatalog(env);
  const sync = await syncAchievements(env, wallet, now, request);
  await syncCosmeticUnlocks(env, wallet, now, request);
  const player = await getOrCreatePlayer(env, wallet);
  const [catalog, earned, metricsRow, discoveries] = await Promise.all([
    env.DB.prepare("SELECT id, name, description, category, metric, threshold, ore, badge_id, title_id FROM achievements").all<{
      id: string;
      name: string;
      description: string;
      category: string;
      metric: string;
      threshold: number;
      ore: number;
      badge_id: string | null;
      title_id: string | null;
    }>(),
    earnedAchievements(env, wallet),
    loadSocialMetrics(env, wallet),
    countDiscoveries(env, wallet),
  ]);
  const metrics = achievementMetrics({
    crewLevels: await crewLevelsForWallet(env, wallet),
    activeDays: player.active_days ?? 0,
    streak: player.streak ?? 0,
    discoveries,
    blocks: metricsRow.blocks_won,
    mineSwitches: metricsRow.mine_switches,
    fullyMined: metricsRow.fully_mined_witnessed > 0,
  });
  const earnedById = new Map(earned.map((row) => [row.achievement_id, row]));
  return json({
    achievements: catalog.results.map((row) => {
      const record = earnedById.get(row.id);
      return {
        id: row.id,
        name: row.name,
        description: row.description,
        category: row.category,
        metric: row.metric,
        threshold: row.threshold,
        ore: row.ore,
        badge: row.badge_id,
        title: row.title_id,
        earnedAt: record?.awarded_at ?? null,
        oreGranted: record?.ore_granted ?? 0,
        progress: Number(metrics[row.metric as keyof typeof metrics] ?? 0),
      };
    }),
    earnedCount: earned.length,
    oreGranted: sync.oreGranted,
    newlyAwarded: sync.awarded.map((entry) => entry.id),
  });
}

/* Seasonal points (spec 68): gameplay progression only, stored as a monotone high-water mark. */

async function storedSeasonalPoints(env: RuntimeEnv, wallet: string, now: number): Promise<number> {
  const season = await currentSeason(env, now);
  const row = await env.DB.prepare("SELECT points FROM seasonal_points WHERE wallet = ?1 AND season_id = ?2")
    .bind(wallet, season.id)
    .first<{ points: number }>();
  return row?.points ?? 0;
}

export interface SeasonalPointsResult {
  readonly season: SeasonDefinition;
  readonly status: "UPCOMING" | "ACTIVE" | "ENDED";
  readonly points: number;
  readonly derivedPoints: number;
  readonly eventPoints: number;
}

/**
 * Recomputes a wallet's seasonal points from gameplay progression plus explicit gameplay point
 * events, and stores the maximum ever seen so repeated sweeps cannot double count.
 */
export async function recomputeSeasonalPoints(
  env: RuntimeEnv,
  wallet: string,
  now: number,
  _request?: Request,
): Promise<SeasonalPointsResult> {
  const season = await currentSeason(env, now);
  const player = await getOrCreatePlayer(env, wallet);
  const [earned, discoveries, eventRow, stored] = await Promise.all([
    earnedAchievements(env, wallet),
    countDiscoveries(env, wallet),
    env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS total FROM seasonal_point_events WHERE wallet = ?1 AND season_id = ?2")
      .bind(wallet, season.id)
      .first<{ total: number }>(),
    storedSeasonalPoints(env, wallet, now),
  ]);
  const derivedPoints = seasonalProgressPoints({
    activeDays: player.active_days ?? 0,
    crewUpgrades: crewTotalLevel(await crewLevelsForWallet(env, wallet)) - crewTotalLevel(DIGGO_CONFIG.crew.starterLevels),
    streak: player.streak ?? 0,
    achievementCount: earned.length,
    discoveryCount: discoveries,
  });
  const eventPoints = eventRow?.total ?? 0;
  const points = Math.max(stored, derivedPoints, eventPoints);
  await env.DB.prepare(
    "INSERT INTO seasonal_points (wallet, season_id, points, updated_at) VALUES (?1, ?2, ?3, ?4)" +
      " ON CONFLICT (wallet, season_id) DO UPDATE SET points = MAX(seasonal_points.points, excluded.points), updated_at = excluded.updated_at",
  )
    .bind(wallet, season.id, points, now)
    .run();
  return { season, status: seasonStatus(season, now), points, derivedPoints, eventPoints };
}

/**
 * Records one gameplay point event (activation, crew upgrade, streak milestone, achievement or
 * discovery) and refreshes the season total. The unique (wallet, season, kind, ref) index makes a
 * repeat of the same event a no-op.
 */
export async function awardSeasonalEvent(
  env: RuntimeEnv,
  wallet: string,
  kind: SeasonalEventKind,
  ref: string,
  now: number,
  _request?: Request,
): Promise<{ inserted: boolean; points: number }> {
  const season = await currentSeason(env, now);
  await getOrCreatePlayer(env, wallet);
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO seasonal_point_events (id, wallet, season_id, kind, ref, points, created_at)" +
      " VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
  )
    .bind(crypto.randomUUID(), wallet, season.id, kind, ref, SEASONAL_POINT_VALUES[kind], now)
    .run();
  const totals = await recomputeSeasonalPoints(env, wallet, now);
  return { inserted: (result.meta.changes ?? 0) > 0, points: totals.points };
}

export async function syncSeasonalPoints(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const now = Math.floor(Date.now() / 1_000);
  const result = await recomputeSeasonalPoints(env, wallet, now, request);
  return json({
    season: { id: result.season.id, name: result.season.name, endsAt: result.season.endsAt, status: result.status },
    points: result.points,
  });
}
