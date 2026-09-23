/**
 * Notifications (spec 75) and the social cron hook.
 *
 * The seven notification kinds and their thresholds are defined once, purely, in
 * shared/social.ts (computeNotifications); this module only loads the inputs from D1 and persists
 * what comes back. Persistence is 'INSERT OR IGNORE' against a UNIQUE dedupe_key, so an hourly
 * sweep, a page load and a cron run can never produce duplicate notifications.
 *
 * Only accounts in the NORMAL reward state are swept: an account under review or held must not be
 * nudged to chase rewards (spec 53, 63).
 *
 * Generation is server-driven: nothing on the client decides that a notification exists. The
 * scheduled trigger (worker/index.ts) calls runSocialCron, which sweeps every account that has a
 * notification due and not yet stored - whether or not that player has the app open. GET
 * /api/notifications also generates on read, so a player who opens the bell between two cron ticks
 * still sees what is due, but the client never invents a row.
 */
import type { TokenStatus } from "../shared/types";
import {
  NOTIFICATION_THRESHOLDS,
  RARE_RARITIES,
  computeNotifications,
  type GeneratedNotification,
  type NotificationKind,
} from "../shared/social";
import { DIGGO_CONFIG } from "../shared/config";
import { sessionWallet } from "./auth";
import { recomputeSeasonalPoints, syncAchievements, syncCosmeticUnlocks } from "./cosmetics";
import type { RuntimeEnv } from "./env";
import { apiError, json } from "./http";
import type { PlayerRow } from "./player";
import { deliverNotifications, deliveryConfigured } from "./push";

const NOTIFICATION_LIST_LIMIT = 50;
const READ_BATCH_LIMIT = 100;
/**
 * How many accounts one sweep generates for. Every candidate costs a handful of D1 statements, so
 * the sweep stays inside the Worker's subrequest budget the way worker/reconcile.ts bounds its own
 * scan. The candidate query below only returns accounts that still owe a notification, so a backlog
 * larger than this drains over consecutive cron ticks instead of starving anyone.
 */
const SWEEP_WALLET_LIMIT = 200;
/** Most alerts one generation pass hands to a push channel; anything older waits for the next one. */
const MAX_DELIVERY_BATCH = 5;

interface MineRow {
  mint: string;
  symbol: string;
  status: TokenStatus;
  reserve_remaining: number;
  reserve_total: number;
}

interface DiscoveryRow {
  id: string;
  rarity: string;
  created_at: number;
}

interface NotificationRow {
  id: number;
  kind: string;
  payload: string;
  dedupe_key: string;
  created_at: number;
  read_at: number | null;
}

/** The columns delivery needs: what was generated, and which screen it belongs to. */
interface DeliveryRow {
  id: number;
  kind: string;
  payload: string;
}

/** Everything computeNotifications needs about one wallet. */
export async function loadNotificationInput(env: RuntimeEnv, wallet: string, now: number) {
  const player = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!player) return null;
  const [mine, discoveries] = await Promise.all([
    player.active_mint
      ? env.DB.prepare("SELECT mint, symbol, status, reserve_remaining, reserve_total FROM tokens WHERE mint = ?1")
          .bind(player.active_mint)
          .first<MineRow>()
      : Promise.resolve(null),
    env.DB.prepare(
      "SELECT id, rarity, created_at FROM discoveries WHERE wallet = ?1 AND created_at >= ?2 ORDER BY created_at DESC LIMIT 10",
    )
      .bind(wallet, now - NOTIFICATION_THRESHOLDS.rareDiscoveryWindowSeconds)
      .all<DiscoveryRow>(),
  ]);
  return {
    now,
    player: {
      wallet: player.wallet,
      streak: player.streak,
      longestStreak: player.streak,
      lastActivationAt: player.last_activation_at,
      activationExpiresAt: player.activation_expires_at,
    },
    mine: mine
      ? {
          mint: mine.mint,
          symbol: mine.symbol,
          status: mine.status,
          reserveRemaining: mine.reserve_remaining,
          reserveTotal: mine.reserve_total,
        }
      : null,
    discoveries: discoveries.results.map((row) => ({ id: row.id, rarity: row.rarity, createdAt: row.created_at })),
  };
}

export interface NotificationInsertResult {
  readonly kinds: readonly NotificationKind[];
  readonly inserted: number;
}

/**
 * The dedupe key as it is stored: namespaced by wallet.
 *
 * shared/social.ts keys a notification by the event it describes - `MINE_EXPIRES_3H:<expiresAt>`,
 * `TOKEN_ALMOST_FULLY_MINED:<mint>`, `STREAK_AT_RISK:<deadline>`. None of those values is unique
 * across players: two wallets can be in the same mine, and two wallets can activate in the same
 * second. notifications.dedupe_key is UNIQUE across the whole table, so storing the bare key would
 * let whichever account the sweep reached first claim the row and silently deny the very same
 * notification to every other player it was due for. Prefixing the wallet keeps the UNIQUE index as
 * the dedupe mechanism while making each event per-player, which is what 'every relevant player
 * gets their notification' actually requires.
 */
export function storedDedupeKey(wallet: string, dedupeKey: string): string {
  return wallet + ":" + dedupeKey;
}

/** Generates and stores the notifications due for one wallet. Safe to call on every request. */
export async function generateNotifications(
  env: RuntimeEnv,
  wallet: string,
  now: number,
): Promise<NotificationInsertResult> {
  const input = await loadNotificationInput(env, wallet, now);
  if (!input) return { kinds: [], inserted: 0 };
  const generated = computeNotifications(input);
  if (generated.length === 0) return { kinds: [], inserted: 0 };
  const results = await env.DB.batch(
    generated.map((entry) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO notifications (wallet, kind, payload, dedupe_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      ).bind(
        wallet,
        entry.kind,
        JSON.stringify(entry.payload),
        storedDedupeKey(wallet, entry.dedupeKey),
        entry.createdAt,
      ),
    ),
  );
  const inserted = results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0);
  await deliverGenerated(env, wallet, generated, now);
  return { kinds: generated.map((entry) => entry.kind), inserted };
}

/**
 * Hands the just-generated notifications to the push and Telegram channels (worker/push.ts).
 *
 * Generation stays exactly as it was: this runs after the INSERT OR IGNORE batch and only ever
 * selects rows that have no delivery record yet, so a wallet with no alerts switched on costs one
 * boolean check, and a wallet that re-opens the app does not re-push what it already received.
 * Delivery failure is logged and swallowed - a push service having a bad day must never fail the
 * request or the cron tick that asked for the notification.
 */
async function deliverGenerated(
  env: RuntimeEnv,
  wallet: string,
  generated: readonly GeneratedNotification[],
  now: number,
): Promise<void> {
  if (!deliveryConfigured(env)) return;
  const placeholders = generated.map((_entry, index) => "?" + (index + 2)).join(", ");
  const rows = await env.DB.prepare(
    "SELECT n.id, n.kind, n.payload FROM notifications n WHERE n.wallet = ?1" +
      " AND n.dedupe_key IN (" + placeholders + ")" +
      " AND NOT EXISTS (SELECT 1 FROM push_deliveries d WHERE d.notification_id = n.id)" +
      " ORDER BY n.id DESC LIMIT ?" + (generated.length + 2),
  )
    .bind(wallet, ...generated.map((entry) => storedDedupeKey(wallet, entry.dedupeKey)), MAX_DELIVERY_BATCH)
    .all<DeliveryRow>();
  if (rows.results.length === 0) return;
  try {
    const summary = await deliverNotifications(
      env,
      wallet,
      rows.results.map((row) => ({ id: row.id, kind: row.kind, payload: parsePayload(row.payload) })),
      now,
    );
    if (summary.attempted > 0) {
      console.log(JSON.stringify({ event: "push.delivered", wallet, ...summary }));
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "push.delivery_failed", wallet, error: String(error) }));
  }
}

function parsePayload(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

export async function listNotifications(
  env: RuntimeEnv,
  wallet: string,
): Promise<{ notifications: unknown[]; unread: number; total: number }> {
  const rows = await env.DB.prepare(
    "SELECT id, kind, payload, dedupe_key, created_at, read_at FROM notifications WHERE wallet = ?1" +
      " ORDER BY created_at DESC, id DESC LIMIT ?2",
  )
    .bind(wallet, NOTIFICATION_LIST_LIMIT)
    .all<NotificationRow>();
  const notifications = rows.results.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: parsePayload(row.payload),
    createdAt: row.created_at,
    readAt: row.read_at,
  }));
  const unreadRow = await env.DB.prepare(
    "SELECT COUNT(*) AS unread FROM notifications WHERE wallet = ?1 AND read_at IS NULL",
  )
    .bind(wallet)
    .first<{ unread: number }>();
  return { notifications, unread: unreadRow?.unread ?? 0, total: notifications.length };
}

export async function getNotifications(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const now = Math.floor(Date.now() / 1_000);
  await generateNotifications(env, wallet, now);
  const listed = await listNotifications(env, wallet);
  return json(listed);
}

/** Marks the given notification ids read, or every unread notification when ids are omitted. */
export async function markNotificationsRead(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const raw = await request.text();
  let ids: number[] | null = null;
  if (raw.trim().length > 0) {
    let parsed: { ids?: unknown };
    try {
      parsed = JSON.parse(raw) as { ids?: unknown };
    } catch {
      return apiError("Invalid JSON body");
    }
    if (parsed.ids !== undefined && !Array.isArray(parsed.ids)) return apiError("ids must be an array");
    if (Array.isArray(parsed.ids)) {
      if (parsed.ids.some((id) => !Number.isInteger(id))) return apiError("ids must be integers");
      ids = (parsed.ids as number[]).slice(0, READ_BATCH_LIMIT);
    }
  }
  const now = Math.floor(Date.now() / 1_000);
  if (ids === null) {
    const result = await env.DB.prepare("UPDATE notifications SET read_at = ?1 WHERE wallet = ?2 AND read_at IS NULL")
      .bind(now, wallet)
      .run();
    return json({ updated: result.meta.changes ?? 0, unread: 0 });
  }
  if (ids.length === 0) {
    const listed = await listNotifications(env, wallet);
    return json({ updated: 0, unread: listed.unread });
  }
  const results = await env.DB.batch(
    ids.map((id) =>
      env.DB.prepare("UPDATE notifications SET read_at = ?1 WHERE wallet = ?2 AND id = ?3 AND read_at IS NULL")
        .bind(now, wallet, id),
    ),
  );
  const listed = await listNotifications(env, wallet);
  return json({ updated: results.reduce((total, result) => total + (result.meta?.changes ?? 0), 0), unread: listed.unread });
}

/**
 * The accounts a sweep still owes a notification to, most urgent first.
 *
 * One OR-branch per notification kind, each asking both halves of the question shared/social.ts asks
 * before it emits: is the condition true, and is that row not stored yet? The second half is what
 * makes this a work queue rather than a filter. Selecting on recency alone re-selects the same
 * already-notified accounts on every tick, so the LIMIT starves everyone behind them; selecting on
 * "due and not yet stored" makes the candidate set exactly the outstanding work, and it drains as
 * those rows are written. A backlog larger than the limit is therefore picked up by the following
 * ticks rather than dropped.
 *
 * The predicates mirror computeNotifications and are deliberately a small superset of it: the
 * reserve bands are widened by one basis point because computeNotifications rounds where SQL
 * truncates, and the streak window's lower bound is exact. The pure function remains the only
 * authority on what is emitted, so a candidate that turns out not to be due simply generates
 * nothing.
 *
 * Restricted states are never swept (spec 53, 63).
 */
export function dueCandidatesQuery(now: number, limit: number): { sql: string; params: (number | string)[] } {
  const params: (number | string)[] = [];
  const bind = (value: number | string): string => {
    params.push(value);
    return "?" + params.length;
  };
  const streakWindow = DIGGO_CONFIG.streak.activationSeconds + DIGGO_CONFIG.streak.graceSeconds;
  const almostBps = NOTIFICATION_THRESHOLDS.tokenAlmostFullyMinedBps + 1;
  const leadBps = NOTIFICATION_THRESHOLDS.rewardReductionLeadBps;
  // Written as an ordered list of fragments so that the bind() calls happen in exactly the order the
  // placeholders appear in the finished statement.
  const parts: string[] = [];

  parts.push("SELECT p.wallet FROM players p WHERE p.risk_state = 'NORMAL' AND (");

  // MINE_EXPIRES_3H / MINE_EXPIRED: the activation window closes within three hours, or closed
  // inside the last week and has not been reported yet.
  parts.push(
    " (p.activation_expires_at IS NOT NULL" +
      " AND p.activation_expires_at BETWEEN " + bind(now - NOTIFICATION_THRESHOLDS.expiredFreshnessSeconds) +
      " AND " + bind(now + NOTIFICATION_THRESHOLDS.mineExpiringSeconds) +
      " AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wallet = p.wallet AND n.dedupe_key IN (" +
      "p.wallet || ':MINE_EXPIRES_3H:' || p.activation_expires_at," +
      " p.wallet || ':MINE_EXPIRED:' || p.activation_expires_at)))",
  );

  // STREAK_AT_RISK: the streak deadline falls inside the warning window. deadline is
  // last_activation_at + activationSeconds + graceSeconds (shared/streak.ts).
  parts.push(
    " OR (p.streak >= " + bind(NOTIFICATION_THRESHOLDS.minStreakForRisk) +
      " AND p.last_activation_at IS NOT NULL" +
      " AND p.last_activation_at > " + bind(now - streakWindow) +
      " AND p.last_activation_at <= " + bind(now - streakWindow + NOTIFICATION_THRESHOLDS.streakAtRiskSeconds) +
      " AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wallet = p.wallet" +
      " AND n.dedupe_key = p.wallet || ':STREAK_AT_RISK:' || (p.last_activation_at + " + bind(streakWindow) + ")))",
  );

  // STREAK_7_DAY: the milestone is reached and has not been announced.
  parts.push(
    " OR (p.streak = " + bind(NOTIFICATION_THRESHOLDS.sevenDayStreak) +
      " AND p.last_activation_at IS NOT NULL" +
      " AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wallet = p.wallet" +
      " AND n.dedupe_key = p.wallet || ':STREAK_7_DAY:' || p.last_activation_at))",
  );

  // RARE_DISCOVERY_FOUND: one of the newest rare discoveries inside the freshness window is still
  // unannounced. The inner select repeats the same newest-first cap computeNotifications applies, so
  // a player with more rare finds than the cap stops being a candidate once the newest ones are
  // stored rather than being re-selected forever.
  parts.push(
    " OR EXISTS (SELECT 1 FROM discoveries d WHERE d.wallet = p.wallet AND d.id IN (" +
      "SELECT d2.id FROM discoveries d2 WHERE d2.wallet = p.wallet" +
      " AND d2.created_at >= " + bind(now - NOTIFICATION_THRESHOLDS.rareDiscoveryWindowSeconds) +
      " AND d2.created_at <= " + bind(now) +
      " AND d2.rarity IN (" + RARE_RARITIES.map((rarity) => bind(rarity)).join(", ") + ")" +
      " ORDER BY d2.created_at DESC, d2.id ASC LIMIT " + bind(NOTIFICATION_THRESHOLDS.maxRareDiscoveryNotifications) +
      ") AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wallet = p.wallet" +
      " AND n.dedupe_key = p.wallet || ':RARE_DISCOVERY_FOUND:' || d.id))",
  );

  // TOKEN_ALMOST_FULLY_MINED and REWARD_REDUCTION_APPROACHING: the active mine is inside one of the
  // reward bands. Each band is the boundary plus the lead distance, so at most one can match, and
  // the boundary is carried in the dedupe key exactly as computeNotifications writes it.
  const bands = [
    " (t.reserve_remaining * 10000 / t.reserve_total <= " + bind(almostBps) +
      " AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wallet = p.wallet" +
      " AND n.dedupe_key = p.wallet || ':TOKEN_ALMOST_FULLY_MINED:' || p.active_mint))",
    ...NOTIFICATION_THRESHOLDS.rewardReductionBoundariesBps
      .filter((boundary) => boundary > 0)
      .map((boundary) =>
        " (t.reserve_remaining * 10000 / t.reserve_total >= " + bind(boundary) +
        " AND t.reserve_remaining * 10000 / t.reserve_total <= " + bind(boundary + leadBps + 1) +
        " AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.wallet = p.wallet" +
        " AND n.dedupe_key = p.wallet || ':REWARD_REDUCTION_APPROACHING:' || p.active_mint || ':' || " +
        bind(boundary) + "))",
      ),
  ];
  parts.push(
    " OR (p.active_mint IS NOT NULL AND EXISTS (SELECT 1 FROM tokens t" +
      " WHERE t.mint = p.active_mint AND t.reserve_total > 0 AND (" + bands.join(" OR ") + ")))",
  );

  // Closes the risk_state group opened above.
  parts.push(")");

  // Soonest closing window first: an expiry or streak deadline cannot be regenerated once it has
  // passed, while a milestone, discovery or reserve band stays available on later ticks.
  parts.push(
    " ORDER BY MIN(COALESCE(p.activation_expires_at, 9223372036854775807)," +
      " COALESCE(p.last_activation_at + " + bind(streakWindow) + ", 9223372036854775807)) ASC," +
      " COALESCE(p.last_activation_at, p.created_at) DESC" +
      " LIMIT " + bind(limit),
  );

  return { sql: parts.join(""), params };
}

/** The NORMAL accounts a sweep still owes a notification to. */
async function sweepCandidates(env: RuntimeEnv, now: number, limit: number): Promise<string[]> {
  const { sql, params } = dueCandidatesQuery(now, limit);
  const rows = await env.DB.prepare(sql).bind(...params).all<{ wallet: string }>();
  return rows.results.map((row) => row.wallet);
}

/** Generates the due notifications for every recently active wallet. Returns rows inserted. */
export async function sweepNotifications(
  env: RuntimeEnv,
  now: number,
  limit = SWEEP_WALLET_LIMIT,
): Promise<number> {
  const wallets = await sweepCandidates(env, now, limit);
  let inserted = 0;
  for (const wallet of wallets) {
    try {
      inserted += (await generateNotifications(env, wallet, now)).inserted;
    } catch (error) {
      console.error(JSON.stringify({ event: "notifications.wallet_failed", wallet, error: String(error) }));
    }
  }
  return inserted;
}

export interface SocialSweepResult {
  readonly wallets: number;
  readonly achievementsAwarded: number;
  readonly cosmeticsUnlocked: number;
  readonly notificationsInserted: number;
}

/**
 * The social half of the cron trigger: award achievements, unlock cosmetics, refresh seasonal point
 * high-water marks and generate due notifications for recently active accounts.
 *
 * Every wallet is isolated: one failure is logged and the sweep continues, so the cron never fails
 * as a whole because of a single account.
 */
export async function runSocialCron(env: RuntimeEnv, now = Math.floor(Date.now() / 1_000)): Promise<SocialSweepResult> {
  const wallets = await sweepCandidates(env, now, SWEEP_WALLET_LIMIT);
  let achievementsAwarded = 0;
  let cosmeticsUnlocked = 0;
  let notificationsInserted = 0;
  for (const wallet of wallets) {
    try {
      const achievements = await syncAchievements(env, wallet, now);
      achievementsAwarded += achievements.awarded.length;
      cosmeticsUnlocked += (await syncCosmeticUnlocks(env, wallet, now)).length;
      await recomputeSeasonalPoints(env, wallet, now);
      notificationsInserted += (await generateNotifications(env, wallet, now)).inserted;
    } catch (error) {
      console.error(JSON.stringify({ event: "social.cron_wallet_failed", wallet, error: String(error) }));
    }
  }
  return { wallets: wallets.length, achievementsAwarded, cosmeticsUnlocked, notificationsInserted };
}
