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
 */
import type { TokenStatus } from "../shared/types";
import {
  NOTIFICATION_THRESHOLDS,
  computeNotifications,
  type GeneratedNotification,
  type NotificationKind,
} from "../shared/social";
import { sessionWallet } from "./auth";
import { recomputeSeasonalPoints, syncAchievements, syncCosmeticUnlocks } from "./cosmetics";
import type { RuntimeEnv } from "./env";
import { apiError, json } from "./http";
import type { PlayerRow } from "./player";
import { deliverNotifications, deliveryConfigured } from "./push";

const NOTIFICATION_LIST_LIMIT = 50;
const READ_BATCH_LIMIT = 100;
const SWEEP_WALLET_LIMIT = 200;
const SWEEP_ACTIVE_WINDOW_SECONDS = 30 * 86_400;
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
      ).bind(wallet, entry.kind, JSON.stringify(entry.payload), entry.dedupeKey, entry.createdAt),
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
    .bind(wallet, ...generated.map((entry) => entry.dedupeKey), MAX_DELIVERY_BATCH)
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

/** Recently active NORMAL accounts. Restricted states are never swept (spec 53, 63). */
async function sweepCandidates(env: RuntimeEnv, now: number, limit: number): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT wallet FROM players WHERE risk_state = 'NORMAL' AND COALESCE(last_activation_at, created_at) >= ?1" +
      " ORDER BY COALESCE(last_activation_at, created_at) DESC LIMIT ?2",
  )
    .bind(now - SWEEP_ACTIVE_WINDOW_SECONDS, limit)
    .all<{ wallet: string }>();
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
