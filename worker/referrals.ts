import { DIGGO_CONFIG } from "../shared/config";
import {
  REFERRAL_SKIN_ID,
  referralCooldownRemaining,
  referralRejectionMessage,
  referralVolumeQualified,
  referralWeekIndex,
  validateReferralCode,
} from "../shared/referral";
import { getOrCreatePlayer } from "./player";
import { usernameFor } from "./profile";
import { sessionWallet } from "./auth";
import { apiError, checkRateLimit, checkWalletRateLimit, json, readJson } from "./http";
import type { RuntimeEnv } from "./env";
import { getProgramAddress, sendAndConfirmWithFeePayer } from "./chainV2";
import { crankSigner } from "./crank";
import { buildCreditReferralOreInstruction } from "../shared/program";
import { address } from "@solana/kit";

export type ReferralStatus = "PENDING" | "QUALIFIED" | "REWARDED" | "REJECTED";

export interface ReferralPanelRow {
  id: string;
  referredWallet: string;
  username: string | null;
  joinedAt: number | null;
  volumeLamports: string;
  status: ReferralStatus;
  oreEntitled: number;
  oreCredited: number;
}

interface AttributionRow {
  id: string;
  referred_wallet: string;
  referrer_wallet: string;
  code: string;
  status: ReferralStatus;
  qualified_at: number | null;
  reward_ore: string;
  created_at: number;
  username: string | null;
  joined_at: number | null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function defaultCode(wallet: string): string {
  return wallet.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6).padEnd(6, "0");
}

async function codeIsFree(env: RuntimeEnv, code: string, wallet: string): Promise<boolean> {
  const row = await env.DB.prepare("SELECT wallet FROM referral_codes WHERE code = ?1 COLLATE NOCASE")
    .bind(code)
    .first<{ wallet: string }>();
  return !row || row.wallet === wallet;
}

async function chooseDefaultCode(env: RuntimeEnv, wallet: string): Promise<string> {
  const username = await usernameFor(env, wallet);
  const usernameCode = username
    ?.toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 20) ?? "";
  const usernameValidation = validateReferralCode(usernameCode);
  if (usernameValidation.ok && await codeIsFree(env, usernameValidation.code, wallet)) {
    return usernameValidation.code;
  }

  const walletPrefix = wallet.toLowerCase().replace(/[^a-z0-9]/g, "");
  for (let length = 6; length <= Math.min(20, walletPrefix.length); length += 1) {
    const candidate = walletPrefix.slice(0, length);
    const validation = validateReferralCode(candidate);
    if (validation.ok && await codeIsFree(env, validation.code, wallet)) return validation.code;
  }
  return defaultCode(wallet);
}

function uniqueViolation(error: unknown): boolean {
  return /unique constraint|sqlite_constraint/i.test(error instanceof Error ? error.message : String(error));
}

async function ensureReferralProfile(env: RuntimeEnv, wallet: string, now: number): Promise<void> {
  await getOrCreatePlayer(env, wallet);
  const existing = await env.DB.prepare("SELECT current_code FROM referral_profiles WHERE wallet = ?1")
    .bind(wallet)
    .first<{ current_code: string }>();
  if (existing) return;
  const code = await chooseDefaultCode(env, wallet);
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO referral_profiles (wallet, current_code, last_changed_at, created_at) VALUES (?1, ?2, 0, ?3)")
      .bind(wallet, code, now),
    env.DB.prepare("INSERT OR IGNORE INTO referral_codes (code, wallet, created_at) VALUES (?1, ?2, ?3)")
      .bind(code, wallet, now),
  ]);
}

/** Records the first signed-in referral for a wallet. Later links never change it. */
export async function captureAttribution(
  env: RuntimeEnv,
  referredWallet: string,
  rawCode: string | null,
  now = nowSeconds(),
): Promise<AttributionRow | null> {
  if (!rawCode) return null;
  const validation = validateReferralCode(rawCode);
  if (!validation.ok) return null;
  const code = await env.DB.prepare("SELECT wallet FROM referral_codes WHERE code = ?1 COLLATE NOCASE")
    .bind(validation.code)
    .first<{ wallet: string }>();
  if (!code || code.wallet === referredWallet) return null;
  await getOrCreatePlayer(env, referredWallet);
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO referral_attributions (id, referred_wallet, referrer_wallet, code, status, created_at, updated_at)" +
        " VALUES (?1, ?2, ?3, ?4, 'PENDING', ?5, ?5)",
    ).bind(crypto.randomUUID(), referredWallet, code.wallet, validation.code, now).run();
  } catch (error) {
    if (!uniqueViolation(error)) throw error;
  }
  return env.DB.prepare(
    "SELECT a.id, a.referred_wallet, a.referrer_wallet, a.code, a.status, a.qualified_at, a.reward_ore, a.created_at," +
      " u.username, p.created_at AS joined_at FROM referral_attributions a" +
      " LEFT JOIN usernames u ON u.wallet = a.referred_wallet LEFT JOIN players p ON p.wallet = a.referred_wallet" +
      " WHERE a.referred_wallet = ?1",
  ).bind(referredWallet).first<AttributionRow>();
}

async function volumeFor(env: RuntimeEnv, row: AttributionRow): Promise<bigint> {
  const result = await env.DB.prepare(
    "SELECT COALESCE(SUM(CASE WHEN t.side = 'BUY' THEN CAST(t.amount_in AS INTEGER) ELSE CAST(t.amount_out AS INTEGER) END), 0) AS volume" +
      " FROM trades t WHERE t.trader_wallet = ?1 AND NOT EXISTS (" +
      " SELECT 1 FROM trade_participants a JOIN trade_participants b ON a.signature = b.signature" +
      " WHERE a.signature = t.signature AND a.wallet = ?2 AND b.wallet = ?3)",
  ).bind(row.referred_wallet, row.referrer_wallet, row.referred_wallet).first<{ volume: number | string }>();
  try {
    return BigInt(result?.volume ?? 0);
  } catch {
    return 0n;
  }
}

async function reserveReward(env: RuntimeEnv, row: AttributionRow, now: number): Promise<boolean> {
  if (row.status === "REWARDED") return true;
  const week = referralWeekIndex(now);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO referral_weekly_caps (referrer_wallet, week_index, rewarded_count) VALUES (?1, ?2, 0)",
  ).bind(row.referrer_wallet, week).run();
  const cap = await env.DB.prepare(
    "UPDATE referral_weekly_caps SET rewarded_count = rewarded_count + 1" +
      " WHERE referrer_wallet = ?1 AND week_index = ?2 AND rewarded_count < ?3",
  ).bind(row.referrer_wallet, week, DIGGO_CONFIG.referral.weeklyRewardCap).run();
  if (cap.meta.changes !== 1) return false;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO referral_reward_events (id, attribution_id, referrer_wallet, ore_amount, cosmetic_id, status, created_at)" +
          " VALUES (?1, ?2, ?3, ?4, ?5, 'PENDING_ONCHAIN', ?6)",
      ).bind(crypto.randomUUID(), row.id, row.referrer_wallet, String(DIGGO_CONFIG.referral.rewardOre), REFERRAL_SKIN_ID, now),
      env.DB.prepare("UPDATE referral_attributions SET status = 'REWARDED', reward_ore = ?1, rewarded_at = ?2, updated_at = ?2 WHERE id = ?3")
        .bind(String(DIGGO_CONFIG.referral.rewardOre), now, row.id),
      env.DB.prepare("INSERT OR IGNORE INTO player_cosmetics (wallet, cosmetic_id, acquired_at) VALUES (?1, ?2, ?3)")
        .bind(row.referrer_wallet, REFERRAL_SKIN_ID, now),
    ]);
    return true;
  } catch (error) {
    await env.DB.prepare("UPDATE referral_weekly_caps SET rewarded_count = MAX(0, rewarded_count - 1) WHERE referrer_wallet = ?1 AND week_index = ?2")
      .bind(row.referrer_wallet, week).run();
    if (!uniqueViolation(error)) throw error;
    return false;
  }
}

async function refreshAttribution(env: RuntimeEnv, row: AttributionRow, now: number): Promise<ReferralPanelRow> {
  const volumeLamports = await volumeFor(env, row);
  if (row.status === "PENDING" && referralVolumeQualified(volumeLamports)) {
    await env.DB.prepare("UPDATE referral_attributions SET status = 'QUALIFIED', qualified_at = ?1, updated_at = ?1 WHERE id = ?2 AND status = 'PENDING'")
      .bind(now, row.id).run();
    row.status = "QUALIFIED";
  }
  if (row.status === "QUALIFIED") await reserveReward(env, row, now);
  const event = await env.DB.prepare("SELECT status, ore_amount FROM referral_reward_events WHERE attribution_id = ?1")
    .bind(row.id).first<{ status: string; ore_amount: string }>();
  const rewarded = event?.status === "CONFIRMED";
  const oreEntitled = event ? Number(event.ore_amount) : 0;
  const oreCredited = rewarded ? oreEntitled : 0;
  return {
    id: row.id,
    referredWallet: row.referred_wallet,
    username: row.username,
    joinedAt: row.joined_at,
    volumeLamports: volumeLamports.toString(),
    status: rewarded ? "REWARDED" : row.status,
    oreEntitled,
    oreCredited,
  };
}

interface ReferralRewardRow {
  id: string;
  attribution_id: string;
  referrer_wallet: string;
  ore_amount: string;
  status: string;
  attempt_count: number;
  next_retry_at: number;
  created_at: number;
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(3_600, 60 * 2 ** Math.min(6, Math.max(0, attempts)));
}

function alreadyCredited(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /referral credit marker already exists|already credited|account.*already in use/i.test(message);
}

/**
 * Settles qualified referral entitlements. Each row is attempted at most once per cron pass;
 * failures stay pending and are retried with exponential backoff. The chain marker is the
 * idempotency boundary, so a row whose marker was created by an earlier attempt is reconciled as
 * confirmed even if that attempt was interrupted before D1 was updated.
 */
export async function sweepReferralOre(
  env: RuntimeEnv,
  options: { now?: number; max?: number } = {},
): Promise<{ enabled: boolean; confirmed: number; retried: number; skipped: number }> {
  const now = options.now ?? nowSeconds();
  const max = Math.min(25, Math.max(1, options.max ?? 25));
  const signer = await crankSigner(env);
  if (!signer) return { enabled: false, confirmed: 0, retried: 0, skipped: 0 };
  const rows = await env.DB.prepare(
    "SELECT id, attribution_id, referrer_wallet, ore_amount, status, attempt_count, next_retry_at, created_at FROM referral_reward_events" +
      " WHERE status = 'PENDING_ONCHAIN' ORDER BY created_at ASC LIMIT ?1",
  ).bind(max).all<ReferralRewardRow>();
  const program = getProgramAddress(env);
  const outcomes = { confirmed: 0, retried: 0, skipped: 0 };
  for (const row of rows.results) {
    if (row.next_retry_at > now) {
      outcomes.skipped += 1;
      continue;
    }
    const attribution = await env.DB.prepare("SELECT referred_wallet FROM referral_attributions WHERE id = ?1")
      .bind(row.attribution_id).first<{ referred_wallet: string }>();
    if (!attribution) {
      outcomes.skipped += 1;
      continue;
    }
    try {
      const signature = await sendAndConfirmWithFeePayer(env, signer, [
        buildCreditReferralOreInstruction({
          programAddress: program,
          keeper: signer.address,
          referrer: address(row.referrer_wallet),
          referee: address(attribution.referred_wallet),
          amount: BigInt(row.ore_amount),
        }),
      ]);
      await env.DB.prepare(
        "UPDATE referral_reward_events SET status = 'CONFIRMED', signature = ?1 WHERE id = ?2 AND status = 'PENDING_ONCHAIN'",
      ).bind(signature, row.id).run();
      outcomes.confirmed += 1;
    } catch (error) {
      if (alreadyCredited(error)) {
        await env.DB.prepare(
          "UPDATE referral_reward_events SET status = 'CONFIRMED' WHERE id = ?1 AND status = 'PENDING_ONCHAIN'",
        ).bind(row.id).run();
        outcomes.confirmed += 1;
      } else {
        outcomes.retried += 1;
        const attempt = attemptsForRow(row) + 1;
        await env.DB.prepare(
          "UPDATE referral_reward_events SET attempt_count = ?1, next_retry_at = ?2 WHERE id = ?3",
        ).bind(attempt, now + retryDelaySeconds(attempt), row.id).run();
      }
    }
  }
  return { enabled: true, ...outcomes };
}

function attemptsForRow(row: ReferralRewardRow): number {
  return Math.max(0, (row as ReferralRewardRow & { attempt_count?: number }).attempt_count ?? 0);
}

export async function referralPanel(request: Request, env: RuntimeEnv, page: number): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "referral-panel", 30, 60))) return apiError("Too many requests", 429);
  const now = nowSeconds();
  await ensureReferralProfile(env, wallet, now);
  const profile = await env.DB.prepare("SELECT current_code, last_changed_at FROM referral_profiles WHERE wallet = ?1")
    .bind(wallet).first<{ current_code: string; last_changed_at: number }>();
  const rows = await env.DB.prepare(
    "SELECT a.id, a.referred_wallet, a.referrer_wallet, a.code, a.status, a.qualified_at, a.reward_ore, a.created_at," +
      " u.username, p.created_at AS joined_at FROM referral_attributions a" +
      " LEFT JOIN usernames u ON u.wallet = a.referred_wallet LEFT JOIN players p ON p.wallet = a.referred_wallet" +
      " WHERE a.referrer_wallet = ?1 ORDER BY a.created_at DESC",
  ).bind(wallet).all<AttributionRow>();
  const all: ReferralPanelRow[] = [];
  for (const row of rows.results) all.push(await refreshAttribution(env, row, now));
  const size = DIGGO_CONFIG.referral.pageSize;
  const pages = Math.max(1, Math.ceil(all.length / size));
  const current = Math.min(Math.max(1, page), pages);
  const visible = all.slice((current - 1) * size, current * size);
  const skin = await env.DB.prepare("SELECT 1 FROM player_cosmetics WHERE wallet = ?1 AND cosmetic_id = ?2")
    .bind(wallet, REFERRAL_SKIN_ID).first();
  return json({
    wallet,
    code: profile?.current_code ?? defaultCode(wallet),
    link: `https://diggo.fun/?ref=${encodeURIComponent(profile?.current_code ?? defaultCode(wallet))}`,
    cooldownSeconds: referralCooldownRemaining(profile?.last_changed_at ?? 0, now),
    totals: {
      invited: all.length,
      pending: all.filter((row) => row.status === "PENDING").length,
      qualified: all.filter((row) => row.status === "QUALIFIED" || row.status === "REWARDED").length,
      oreEarned: all.reduce((sum, row) => sum + row.oreEntitled, 0),
      oreCredited: all.reduce((sum, row) => sum + row.oreCredited, 0),
      skinUnlocked: Boolean(skin),
    },
    thresholdLamports: DIGGO_CONFIG.referral.minimumVolumeLamports.toString(),
    weeklyCap: DIGGO_CONFIG.referral.weeklyRewardCap,
    referrals: visible,
    page: current,
    pages,
  });
}

export async function changeReferralCode(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "referral-code", 8, 60)) || !(await checkRateLimit(request, env, "referral-code", 8))) return apiError("Too many requests", 429);
  const body = await readJson<{ code?: unknown }>(request);
  const validation = validateReferralCode(body.code);
  if (!validation.ok) return json({ code: validation.reason.toUpperCase(), message: referralRejectionMessage(validation.reason) }, { status: 400 });
  const now = nowSeconds();
  await ensureReferralProfile(env, wallet, now);
  const existing = await env.DB.prepare("SELECT current_code, last_changed_at FROM referral_profiles WHERE wallet = ?1")
    .bind(wallet).first<{ current_code: string; last_changed_at: number }>();
  if (existing?.current_code === validation.code) return json({ code: validation.code, changed: false });
  const wait = referralCooldownRemaining(existing?.last_changed_at ?? 0, now);
  if (wait > 0) return json({ code: "COOLDOWN", message: "You can change your referral code later.", retryAfterSec: Math.ceil(wait) }, { status: 429, headers: { "retry-after": String(Math.ceil(wait)) } });
  try {
    await env.DB.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES (?1, ?2, ?3)")
      .bind(validation.code, wallet, now).run();
  } catch (error) {
    if (uniqueViolation(error)) return json({ code: "TAKEN", message: "That referral code is already taken." }, { status: 409 });
    throw error;
  }
  const result = await env.DB.prepare("UPDATE referral_profiles SET current_code = ?1, last_changed_at = ?2 WHERE wallet = ?3 AND last_changed_at <= ?4")
    .bind(validation.code, now, wallet, now - DIGGO_CONFIG.referral.renameCooldownSeconds).run();
  if (result.meta.changes !== 1) {
    return json({ code: "COOLDOWN", message: "You can change your referral code later." }, { status: 429 });
  }
  return json({ code: validation.code, changed: true });
}

export async function referralAvailability(code: string, env: RuntimeEnv): Promise<Response> {
  const validation = validateReferralCode(code);
  if (!validation.ok) return json({ available: false, reason: validation.reason, message: referralRejectionMessage(validation.reason) });
  const row = await env.DB.prepare("SELECT wallet FROM referral_codes WHERE code = ?1 COLLATE NOCASE").bind(validation.code).first<{ wallet: string }>();
  return json({ available: !row, code: validation.code });
}
