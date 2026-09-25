/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "../shared/config";
import { REFERRAL_SKIN_ID } from "../shared/referral";
import {
  captureAttribution,
  captureReferralForSession,
  changeReferralCode,
  referralAvailability,
  referralPanel,
  sweepMeteoraReferralOre,
} from "./referrals";
import type { RuntimeEnv } from "./env";

type SqlValue = string | number | bigint | null;
function bindable(values: readonly unknown[]): SqlValue[] {
  return values.map((value) => value === undefined ? null : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : value as SqlValue);
}
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: readonly SqlValue[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, bindable(values)); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) as T | undefined) ?? null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[], success: true, meta: { changes: 0 } }; }
  async run() { const result = this.db.prepare(this.sql).run(...this.values); return { success: true, meta: { changes: Number(result.changes) } }; }
}
class D1 {
  constructor(readonly db: DatabaseSync) {}
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(statements: readonly Statement[]) { return Promise.all(statements.map((statement) => statement.run())); }
}
class KV {
  private values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
  async put(key: string, value: string) { this.values.set(key, value); }
  async delete(key: string) { this.values.delete(key); }
}
function harness() {
  const db = new DatabaseSync(":memory:");
  const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(directory, file), "utf8"));
  const env = { DB: new D1(db), TOKEN_CACHE: new KV() } as unknown as RuntimeEnv;
  return { db, env };
}
/** The native router reads `trades`; Meteora mode (the deployed default) reads `meteora_swaps`. */
function harnessWithMode(mode: "native" | "meteora") {
  const built = harness();
  (built.env as { CHAIN_MODE?: string }).CHAIN_MODE = mode;
  return built;
}
function session(wallet: string) { return { authorization: `Bearer session-${wallet}` }; }
function request(url: string, init: RequestInit = {}) { return new Request(`https://diggo.fun${url}`, init); }
const REFERRER = "So11111111111111111111111111111111111111111";
const REFERRED = "So11111111111111111111111111111111111111112";
const OTHER = "So11111111111111111111111111111111111111113";
async function createProfile(env: RuntimeEnv, wallet: string, code: string) {
  await env.DB.prepare("INSERT INTO players (wallet, created_at, risk_state, risk_score) VALUES (?1, 1, 'NORMAL', 0)").bind(wallet).run();
  await env.DB.prepare("INSERT INTO referral_profiles (wallet, current_code, last_changed_at, created_at) VALUES (?1, ?2, 0, 1)").bind(wallet, code).run();
  await env.DB.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES (?1, ?2, 1)").bind(code, wallet).run();
}
async function addTrade(db: DatabaseSync, signature: string, trader: string, side: "BUY" | "SELL", amount: string, participants: string[]) {
  db.prepare("INSERT INTO trades (signature, instruction_index, mint, coin, side, amount_in, amount_out, trader_wallet, block_time) VALUES (?, 0, 'mint', 'coin', ?, ?, ?, ?, 1)").run(signature, side, amount, amount, trader);
  for (const wallet of participants) db.prepare("INSERT OR IGNORE INTO trade_participants (signature, wallet) VALUES (?, ?)").run(signature, wallet);
}
let swapSeq = 0;
function addSwap(db: DatabaseSync, trader: string, lamports: string, signature = `sig-${++swapSeq}`, eventIndex = 0) {
  db.prepare(
    "INSERT OR IGNORE INTO meteora_swaps (id, signature, event_index, pool, config, mint, trader_wallet, side, amount_in, amount_out, sol_amount_lamports, quote_reserve, migration_threshold, slot, block_time, created_at)" +
      " VALUES (?, ?, ?, 'pool', 'config', 'mint', ?, 'buy', '1', '1', ?, '1', '1', '1', 1, 1)",
  ).run(`${signature}:${eventIndex}`, signature, eventIndex, trader, lamports);
}

describe("referral attribution", () => {
  it("uses an available normalized username as the initial code", async () => {
    const { db, env } = harness();
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    await env.DB.prepare("INSERT INTO players (wallet, created_at, risk_state, risk_score) VALUES (?1, 1, 'NORMAL', 0)").bind(REFERRER).run();
    await env.DB.prepare("INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at) VALUES (?1, 'My_Name', 'my_name', 1, 1)").bind(REFERRER).run();
    await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    expect(db.prepare("SELECT current_code FROM referral_profiles WHERE wallet = ?").get(REFERRER)).toMatchObject({ current_code: "my_name" });
  });

  it("keeps an existing code after a username change", async () => {
    const { db, env } = harness();
    await createProfile(env, REFERRER, "legacy_code");
    await env.DB.prepare("INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at) VALUES (?1, 'NewName', 'newname', 1, 1)").bind(REFERRER).run();
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    expect(db.prepare("SELECT current_code FROM referral_profiles WHERE wallet = ?").get(REFERRER)).toMatchObject({ current_code: "legacy_code" });
  });

  it("falls back to a readable wallet code when the username is reserved", async () => {
    const { db, env } = harness();
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    await env.DB.prepare("INSERT INTO players (wallet, created_at, risk_state, risk_score) VALUES (?1, 1, 'NORMAL', 0)").bind(REFERRER).run();
    await env.DB.prepare("INSERT INTO usernames (wallet, username, username_normalized, created_at, updated_at) VALUES (?1, 'admin', 'admin', 1, 1)").bind(REFERRER).run();
    await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    const code = (db.prepare("SELECT current_code FROM referral_profiles WHERE wallet = ?").get(REFERRER) as { current_code: string }).current_code;
    expect(code).toBe(REFERRER.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6));
  });

  it("keeps the fallback unique when the short wallet prefix is taken", async () => {
    const { db, env } = harness();
    const prefix = REFERRER.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
    await createProfile(env, OTHER, prefix);
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    const code = (db.prepare("SELECT current_code FROM referral_profiles WHERE wallet = ?").get(REFERRER) as { current_code: string }).current_code;
    expect(code).toBe(REFERRER.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 7));
  });

  it("still produces a code that exists when every wallet prefix is taken", async () => {
    const { db, env } = harness();
    const prefix = REFERRER.toLowerCase().replace(/[^a-z0-9]/g, "");
    // Occupy every length the prefix loop tries, so it cannot stop on a longer prefix either.
    for (let length = 6; length <= 20; length += 1) await createProfile(env, `${OTHER}${length}`, prefix.slice(0, length));
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    const code = (db.prepare("SELECT current_code FROM referral_profiles WHERE wallet = ?").get(REFERRER) as { current_code: string }).current_code;
    // A profile pointing at a code nobody owns breaks every link the player ever shares.
    expect(db.prepare("SELECT 1 FROM referral_codes WHERE code = ?").get(code)).toBeTruthy();
    expect(db.prepare("SELECT wallet FROM referral_codes WHERE code = ?").get(code)).toMatchObject({ wallet: REFERRER });
    expect(code.startsWith(prefix.slice(0, 6))).toBe(true);
  });

  it("stores the first referrer, rejects self-referral, and keeps a case-insensitive code", async () => {
    const { db, env } = harness();
    await createProfile(env, REFERRER, "jurek");
    await createProfile(env, OTHER, "other");
    await captureAttribution(env, REFERRED, "JUREK", 10);
    await captureAttribution(env, REFERRED, "other", 11);
    expect(db.prepare("SELECT referrer_wallet, code FROM referral_attributions WHERE referred_wallet = ?").get(REFERRED)).toMatchObject({ referrer_wallet: REFERRER, code: "jurek" });
    expect(await captureAttribution(env, REFERRER, "jurek", 12)).toBeNull();
    expect((await referralAvailability("JUREK", env)).status).toBe(200);
    expect(await (await referralAvailability("JUREK", env)).json()).toMatchObject({ available: false });
  });

  it("retains an old code after a rename and enforces the cooldown", async () => {
    const { db, env } = harness();
    await createProfile(env, REFERRER, "jurek");
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    const changed = await changeReferralCode(request("/api/referrals/code", { method: "POST", headers: { ...session(REFERRER), "content-type": "application/json" }, body: JSON.stringify({ code: "new-code" }) }), env);
    expect(changed.status).toBe(200);
    expect(db.prepare("SELECT wallet FROM referral_codes WHERE code = 'jurek'").get()).toMatchObject({ wallet: REFERRER });
    const blocked = await changeReferralCode(request("/api/referrals/code", { method: "POST", headers: { ...session(REFERRER), "content-type": "application/json" }, body: JSON.stringify({ code: "other-code" }) }), env);
    expect(blocked.status).toBe(429);
  });

  it("rejects a case-insensitive collision with another player's code", async () => {
    const { env } = harness();
    await createProfile(env, REFERRER, "jurek");
    await createProfile(env, OTHER, "other");
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    const response = await changeReferralCode(request("/api/referrals/code", {
      method: "POST",
      headers: { ...session(REFERRER), "content-type": "application/json" },
      body: JSON.stringify({ code: "OTHER" }),
    }), env);
    expect(response.status).toBe(409);
  });
});

describe("referral qualification and rewards", () => {
  it("requires the configured volume, excludes wash trades, pays the referrer only, and is idempotent", async () => {
    const { db, env } = harnessWithMode("native");
    await createProfile(env, REFERRER, "jurek");
    await captureAttribution(env, REFERRED, "jurek", 10);
    await addTrade(db, "clean-buy", REFERRED, "BUY", "300000000", [REFERRED]);
    await addTrade(db, "clean-sell", REFERRED, "SELL", "200000000", [REFERRED]);
    await addTrade(db, "wash", REFERRED, "BUY", "900000000", [REFERRED, REFERRER]);
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    const response = await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    const panel = await response.json() as {
      totals: { qualified: number; oreEarned: number; oreCredited: number; skinUnlocked: boolean };
    };
    expect(panel.totals.qualified).toBe(1);
    expect(panel.totals.oreEarned).toBe(DIGGO_CONFIG.referral.rewardOre);
    expect(panel.totals.oreCredited).toBe(0);
    expect(panel.totals.skinUnlocked).toBe(true);
    expect(db.prepare("SELECT ore_balance FROM players WHERE wallet = ?").get(REFERRED)).toMatchObject({ ore_balance: null });
    expect(db.prepare("SELECT COUNT(*) AS count FROM referral_reward_events").get()).toMatchObject({ count: 1 });
    await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM referral_reward_events").get()).toMatchObject({ count: 1 });
  });

  it("leaves below-threshold referrals pending", async () => {
    const { db, env } = harnessWithMode("native");
    await createProfile(env, REFERRER, "jurek");
    await captureAttribution(env, REFERRED, "jurek", 10);
    await addTrade(db, "small", REFERRED, "BUY", "499999999", [REFERRED]);
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    const panel = await (await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1)).json() as {
      totals: { pending: number; qualified: number };
    };
    expect(panel.totals.pending).toBe(1);
    expect(panel.totals.qualified).toBe(0);
  });
});

describe("Meteora-mode referrals", () => {
  it("reads qualification volume from meteora_swaps rather than the empty native trades index", async () => {
    const { db, env } = harnessWithMode("meteora");
    await createProfile(env, REFERRER, "jurek");
    await captureAttribution(env, REFERRED, "jurek", 10);
    addSwap(db, REFERRED, "300000000");
    addSwap(db, REFERRED, "200000000");
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    const panel = await (await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1)).json() as {
      referrals: { volumeLamports: string; status: string; oreEntitled: number }[];
      totals: { qualified: number };
    };
    expect(panel.referrals[0]?.volumeLamports).toBe("500000000");
    expect(panel.referrals[0]?.status).toBe("QUALIFIED");
    // The entitlement is visible as soon as the row qualifies; the sweep is what moves the ORE.
    expect(panel.referrals[0]?.oreEntitled).toBe(DIGGO_CONFIG.referral.rewardOre);
    expect(panel.totals.qualified).toBe(1);
    // Meteora pays off-chain, so no on-chain reward event is ever reserved.
    expect(db.prepare("SELECT COUNT(*) AS count FROM referral_reward_events").get()).toMatchObject({ count: 0 });
  });

  it("excludes swaps the referrer took part in, so a referrer cannot qualify their own referee", async () => {
    const { db, env } = harnessWithMode("meteora");
    await createProfile(env, REFERRER, "jurek");
    await captureAttribution(env, REFERRED, "jurek", 10);
    addSwap(db, REFERRED, "900000000", "wash-sig");
    addSwap(db, REFERRER, "900000000", "wash-sig", 1);
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRER}`, REFERRER);
    const panel = await (await referralPanel(request("/api/referrals", { headers: session(REFERRER) }), env, 1)).json() as {
      referrals: { volumeLamports: string; status: string }[];
      totals: { pending: number; qualified: number };
    };
    expect(panel.referrals[0]?.volumeLamports).toBe("0");
    expect(panel.referrals[0]?.status).toBe("PENDING");
    expect(panel.totals.pending).toBe(1);
  });

  it("credits the referrer's ORE off-chain, unlocks the skin, and never double-pays", async () => {
    const { db, env } = harnessWithMode("meteora");
    await createProfile(env, REFERRER, "jurek");
    await captureAttribution(env, REFERRED, "jurek", 10);
    addSwap(db, REFERRED, "500000000");
    const first = await sweepMeteoraReferralOre(env, { now: 1_000 });
    expect(first).toMatchObject({ checked: 1, qualified: 1, credited: 1 });
    expect(db.prepare("SELECT status FROM referral_attributions WHERE referred_wallet = ?").get(REFERRED)).toMatchObject({ status: "REWARDED" });
    expect(db.prepare("SELECT cosmetic_id FROM player_cosmetics WHERE wallet = ?").get(REFERRER)).toMatchObject({ cosmetic_id: REFERRAL_SKIN_ID });
    const balance = Number((db.prepare("SELECT ore_balance FROM game_players WHERE wallet = ?").get(REFERRER) as { ore_balance: string }).ore_balance);
    expect(balance).toBe(DIGGO_CONFIG.referral.rewardOre);

    // REWARDED rows are no longer swept, and the game store dedupes on (referrer, referee).
    const second = await sweepMeteoraReferralOre(env, { now: 2_000 });
    expect(second.credited).toBe(0);
    const after = Number((db.prepare("SELECT ore_balance FROM game_players WHERE wallet = ?").get(REFERRER) as { ore_balance: string }).ore_balance);
    expect(after).toBe(balance);
  });

  it("settles qualified rows before pending ones so earned rewards are never starved", async () => {
    const { db, env } = harnessWithMode("meteora");
    await createProfile(env, REFERRER, "jurek");
    await captureAttribution(env, REFERRED, "jurek", 10);
    const idle = "So11111111111111111111111111111111111111119";
    await env.DB.prepare("INSERT INTO players (wallet, created_at, risk_state, risk_score) VALUES (?1, 1, 'NORMAL', 0)").bind(idle).run();
    await captureAttribution(env, idle, "jurek", 11);
    addSwap(db, REFERRED, "500000000");
    db.prepare("UPDATE referral_attributions SET status = 'QUALIFIED', qualified_at = 5 WHERE referred_wallet = ?").run(REFERRED);
    const result = await sweepMeteoraReferralOre(env, { now: 1_000, max: 1 });
    expect(result.credited).toBe(1);
    expect(db.prepare("SELECT status FROM referral_attributions WHERE referred_wallet = ?").get(REFERRED)).toMatchObject({ status: "REWARDED" });
  });

  it("attributes an already-signed-in wallet through the capture endpoint", async () => {
    const { db, env } = harnessWithMode("meteora");
    await createProfile(env, REFERRER, "jurek");
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRED}`, REFERRED);
    const response = await captureReferralForSession(request("/api/referrals/capture", {
      method: "POST",
      headers: { ...session(REFERRED), "content-type": "application/json" },
      body: JSON.stringify({ code: "JUREK" }),
    }), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ code: "jurek", captured: true });
    expect(db.prepare("SELECT referrer_wallet FROM referral_attributions WHERE referred_wallet = ?").get(REFERRED)).toMatchObject({ referrer_wallet: REFERRER });

    // A second code never displaces the first referrer.
    await createProfile(env, OTHER, "other");
    const again = await captureReferralForSession(request("/api/referrals/capture", {
      method: "POST",
      headers: { ...session(REFERRED), "content-type": "application/json" },
      body: JSON.stringify({ code: "other" }),
    }), env);
    expect(await again.json()).toMatchObject({ captured: false, reason: "already_attributed" });
    expect(db.prepare("SELECT referrer_wallet FROM referral_attributions WHERE referred_wallet = ?").get(REFERRED)).toMatchObject({ referrer_wallet: REFERRER });
  });

  it("rejects an unauthenticated or malformed capture without writing an attribution", async () => {
    const { db, env } = harnessWithMode("meteora");
    await createProfile(env, REFERRER, "jurek");
    const anonymous = await captureReferralForSession(request("/api/referrals/capture", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "jurek" }),
    }), env);
    expect(anonymous.status).toBe(401);
    await env.TOKEN_CACHE.put(`auth:session:session-${REFERRED}`, REFERRED);
    const malformed = await captureReferralForSession(request("/api/referrals/capture", {
      method: "POST",
      headers: { ...session(REFERRED), "content-type": "application/json" },
      body: JSON.stringify({ code: "no" }),
    }), env);
    expect(await malformed.json()).toMatchObject({ captured: false, code: "too_short" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM referral_attributions").get()).toMatchObject({ count: 0 });
  });
});
