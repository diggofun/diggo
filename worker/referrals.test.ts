/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DIGGO_CONFIG } from "../shared/config";
import { captureAttribution, changeReferralCode, referralAvailability, referralPanel } from "./referrals";
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
    const { db, env } = harness();
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
    const { db, env } = harness();
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
