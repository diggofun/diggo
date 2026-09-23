/**
 * Crew upgrades: ORE is spent on Crew components and the resulting Power is pushed on-chain.
 *
 * Upgrading changes Mining Power, so the wallet's mining position is settled *before* the level
 * moves (spec 30): no block is ever credited at a power the crew did not have at the time.
 */
import { DIGGO_CONFIG } from "../shared/config";
import type { CrewComponent } from "../shared/config";
import { CREW_COMPONENTS, crewPower, upgradeOreCost } from "../shared/crew";
import type { IndexingEvent } from "../shared/types";
import { sessionWallet } from "./auth";
import type { RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit, json, readJson } from "./http";
import {
  advanceMineTo,
  armPosition,
  releaseArmedPositions,
  type PositionSettlement,
} from "./mining";
import { activationStateOf, crewLevelsOf, getOrCreatePlayer, rowToProfile, type PlayerRow } from "./player";
import { gateAction, recordActivity } from "./risk";
import { metric } from "./telemetry";

export async function crewUpgrade(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "crew-upgrade"))) return apiError("Too many requests", 429);
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkWalletRateLimit(env, wallet, "crew-upgrade", 20, 60))) {
    await recordActivity(env, { wallet, request, action: "crew_upgrade", outcome: "rate_limited" });
    return apiError("Too many upgrade requests, slow down", 429);
  }

  const gate = await gateAction(env, { wallet, request, action: "crew_upgrade" });
  if (gate.challengeRequired) {
    await recordActivity(env, { wallet, request, action: "crew_upgrade", outcome: "failed_challenge" });
    return json(
      { code: "VERIFICATION_REQUIRED", message: DIGGO_CONFIG.risk.publicStatus.UNDER_REVIEW },
      { status: 403 },
    );
  }
  if (!gate.allowed) {
    const message = gate.publicMessage ?? DIGGO_CONFIG.risk.publicStatus[gate.rewardState];
    await recordActivity(env, {
      wallet,
      request,
      action: "crew_upgrade",
      outcome: gate.retryAfterSec === undefined ? "rejected" : "rate_limited",
    });
    return gate.retryAfterSec === undefined
      ? json({ code: gate.rewardState, message }, { status: 403 })
      : json({ code: "RATE_LIMITED", message }, { status: 429, headers: { "retry-after": String(gate.retryAfterSec) } });
  }

  const { component } = await readJson<{ component?: string }>(request);
  if (!CREW_COMPONENTS.includes(component as CrewComponent)) return apiError("Invalid crew component");

  const row = await getOrCreatePlayer(env, wallet, request);
  const now = Math.floor(Date.now() / 1_000);
  const column = `${component}_level`;
  const currentLevel = row[`${component}_level` as keyof PlayerRow] as number;
  if (currentLevel >= DIGGO_CONFIG.crew.maxLevel) {
    return apiError("This crew component is already at its maximum level");
  }
  const cost = upgradeOreCost(component as CrewComponent, currentLevel, row.foreman_level);

  // Settle first: the position must not earn at the new power for blocks that predate the upgrade.
  const settlements: PositionSettlement[] = await releaseArmedPositions(env, wallet, now);

  const result = await env.DB.prepare(
    `UPDATE players SET ore_balance = ore_balance - ?1, ${column} = ${column} + 1
     WHERE wallet = ?2 AND ore_balance >= ?1 AND ${column} = ?3`,
  )
    .bind(cost, wallet, currentLevel)
    .run();
  if (!result.meta.changes) {
    await recordActivity(env, { wallet, request, action: "crew_upgrade", outcome: "rejected" });
    return apiError("Not enough ORE for this upgrade, or crew state changed — try again", 409);
  }

  const updated = await env.DB.prepare("SELECT * FROM players WHERE wallet = ?1").bind(wallet).first<PlayerRow>();
  if (!updated) return apiError("Upgrade failed", 500);

  // Re-arm with the new power if the crew is still inside an active window.
  if (activationStateOf(updated, now) === "ACTIVE" && updated.active_mint) {
    await advanceMineTo(env, updated.active_mint, now, { exclusive: true });
    await armPosition(
      env,
      wallet,
      updated.active_mint,
      BigInt(crewPower(crewLevelsOf(updated))),
      updated.activated_at ?? updated.last_activation_at ?? now,
      updated.activation_expires_at ?? now,
      now,
    );
  }

  if (updated.active_mint) {
    await env.INDEXING_QUEUE.send({ type: "sync_power", wallet, mint: updated.active_mint } satisfies IndexingEvent);
  }
  await metric(env, "mining.crew_upgrade", 1, { component: String(component) });
  await recordActivity(env, { wallet, request, action: "crew_upgrade", outcome: "ok" });
  return json({
    player: rowToProfile(updated, now),
    spent: cost,
    power: crewPower(crewLevelsOf(updated)),
    settlements,
  });
}
