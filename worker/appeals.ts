/**
 * Player appeals (spec 53, 62, 65).
 *
 * A hold, a review or a block is a machine decision, and a real player deserves a way to ask a
 * person to look again. That is the whole of what this module does: it takes a written appeal
 * from a signed-in wallet whose account is actually under something, and it gives an operator a
 * queue to decide those appeals from. Submitting one cannot lift a restriction, change a reward
 * state, release a reward or move value; accepting one can only *lift* restrictions, and a
 * restriction has never been able to do anything but stop work (spec 65).
 *
 * Copy discipline: a player is told that an appeal was received, or that there is nothing under
 * review for their account. Never a score, a weight, a signal name or a reason code (spec 62).
 */
import {
  type AppealConfig,
  type AppealResolution,
  type AppealStatus,
  APPEAL_RESOLUTIONS,
  APPEAL_STATUSES,
  RISK_OPS,
  type RiskOpsConfig,
  appealEligible,
  appealStatusFor,
} from "../shared/riskOps";
import {
  type AdminStepUpProof,
  adminActor,
  requireAdminStepUp,
  stepUpPayload,
  writeAudit,
} from "./admin";
import { sessionWallet } from "./auth";
import type { RuntimeEnv } from "./env";
import {
  type RateLimitCheck,
  apiError,
  checkKeyedRateLimits,
  isBase58Address,
  json,
  readJson,
} from "./http";
import { walletRiskStates } from "./risk";
import {
  RESTRICTION_KINDS,
  type RequestFingerprint,
  type RestrictionKind,
  clearRestriction,
  fingerprintRequest,
} from "./signals";

const QUEUE_LIMIT_MAX = 100;
const QUEUE_LIMIT_DEFAULT = 25;

interface AppealRow {
  id: string;
  wallet: string;
  message: string;
  status: AppealStatus;
  state_at_submission: string;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
  resolution_note: string | null;
}

/** Admin-facing shape. Player-facing copy comes from the config, never from the risk internals. */
function appealView(row: AppealRow) {
  return {
    id: row.id,
    wallet: row.wallet,
    message: row.message,
    status: row.status,
    stateAtSubmission: row.state_at_submission,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolutionNote: row.resolution_note,
    publicMessage: RISK_OPS.appeals.statusMessages[row.status],
  };
}

function isAppealResolution(value: unknown): value is AppealResolution {
  return typeof value === "string" && (APPEAL_RESOLUTIONS as readonly string[]).includes(value);
}

function appealRateChecks(
  wallet: string,
  fingerprint: RequestFingerprint,
  config: AppealConfig,
): RateLimitCheck[] {
  // The same five dimensions as every other gated action, never IP alone (spec 48, 51): a player
  // appealing from a shared address keeps their budget, while one wallet cannot file in a loop.
  return [
    { dimension: "appeal:wallet", key: wallet, limit: config.wallet, windowSeconds: config.windowSeconds },
    { dimension: "appeal:session", key: fingerprint.sessionId, limit: config.session, windowSeconds: config.windowSeconds },
    { dimension: "appeal:ip", key: fingerprint.ipHash, limit: config.ip, windowSeconds: config.windowSeconds },
    { dimension: "appeal:device", key: fingerprint.deviceHash, limit: config.device, windowSeconds: config.windowSeconds },
    { dimension: "appeal:network", key: fingerprint.networkHash, limit: config.network, windowSeconds: config.windowSeconds },
  ];
}

async function openAppealCount(env: RuntimeEnv, wallet: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM appeals WHERE wallet = ?1 AND status = 'OPEN'",
  )
    .bind(wallet)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * POST /api/appeals { message }
 *
 * Signed-in wallets only, rate limited on five dimensions, length bounded, and only for accounts
 * that are actually under something. Anything else gets the same neutral sentence, so the endpoint
 * cannot be used to probe what the risk layer thinks of an account.
 */
export async function submitAppeal(
  request: Request,
  env: RuntimeEnv,
  options: { config?: RiskOpsConfig } = {},
): Promise<Response> {
  const config = options.config?.appeals ?? RISK_OPS.appeals;
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);

  // Rate limit before parsing, so a flood is refused without paying for a body read.
  const fingerprint = await fingerprintRequest(env, request);
  const verdict = await checkKeyedRateLimits(env, appealRateChecks(wallet, fingerprint, config));
  if (!verdict.allowed) {
    return json(
      { received: false, code: "APPEAL_RATE_LIMITED", message: config.tooManyMessage },
      { status: 429, headers: { "retry-after": String(verdict.retryAfterSec) } },
    );
  }

  let body: { message?: unknown };
  try {
    body = await readJson<{ message?: unknown }>(request, config.maxBodyBytes);
  } catch {
    return apiError(config.invalidMessage);
  }
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length < config.minMessageLength || message.length > config.maxMessageLength) {
    return apiError(config.invalidMessage);
  }

  // Eligibility follows what the player is actually living through, and the score's own verdict as
  // well: a staged rollout can enforce one action while the stored state stays NORMAL, and a player
  // refused by that override still deserves a way to ask for a human look.
  const states = await walletRiskStates(env, wallet);
  const state = appealEligible(states.enforced) ? states.enforced : states.computed;
  if (!appealEligible(states.enforced) && !appealEligible(states.computed)) {
    return json(
      { received: false, message: config.notEligibleMessage },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  if ((await openAppealCount(env, wallet)) >= config.maxOpenPerAccount) {
    return json(
      { received: false, message: config.tooManyMessage },
      { status: 429, headers: { "retry-after": String(config.windowSeconds) } },
    );
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1_000);
  await env.DB.prepare(
    "INSERT INTO appeals (id, wallet, message, status, state_at_submission, created_at) " +
      "VALUES (?1, ?2, ?3, 'OPEN', ?4, ?5)",
  )
    .bind(id, wallet, message, state, now)
    .run();
  return json(
    { id, received: true, status: "OPEN", message: config.publicMessage },
    { status: 201, headers: { "cache-control": "no-store" } },
  );
}

/**
 * GET /api/admin/appeals?status=&wallet=&limit=
 *
 * The operator queue. An appeal carries the state the player was in when they wrote it and the
 * admin who decided it; never a fingerprint, an IP or a device hash (spec 67).
 */
export async function adminAppeals(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status");
  const status =
    statusParam !== null && (APPEAL_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as AppealStatus)
      : null;
  const walletParam = url.searchParams.get("wallet");
  const requested = Number(url.searchParams.get("limit") ?? QUEUE_LIMIT_DEFAULT);
  const limit = Number.isFinite(requested)
    ? Math.min(QUEUE_LIMIT_MAX, Math.max(1, Math.floor(requested)))
    : QUEUE_LIMIT_DEFAULT;

  const bindings: unknown[] = [];
  let where = "";
  if (status !== null) {
    bindings.push(status);
    where += " WHERE status = ?" + bindings.length;
  }
  if (walletParam !== null && isBase58Address(walletParam)) {
    bindings.push(walletParam);
    where += (where.length > 0 ? " AND" : " WHERE") + " wallet = ?" + bindings.length;
  }
  bindings.push(limit);
  const rows = (
    await env.DB.prepare(
      "SELECT id, wallet, message, status, state_at_submission, created_at, resolved_at, resolved_by, " +
        "resolution_note FROM appeals" +
        where +
        " ORDER BY created_at DESC LIMIT ?" +
        String(bindings.length),
    )
      .bind(...bindings)
      .all<AppealRow>()
  ).results;
  const appeals = rows.map(appealView);
  return json(
    {
      actor,
      appeals,
      count: appeals.length,
      open: appeals.filter((appeal) => appeal.status === "OPEN").length,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

interface ResolveBody {
  id?: unknown;
  resolution?: unknown;
  note?: unknown;
  liftKinds?: unknown;
  stepUp?: AdminStepUpProof;
}

/**
 * POST /api/admin/appeals { id, resolution, note?, liftKinds? }
 *
 * Decides one open appeal, and nothing else. The only state this can change is the appeal row and
 * - when an operator names them explicitly on an accepted appeal - the lifted restrictions: those
 * can stop work, and stop doing so. Neither direction can move value. Requires a signed step-up
 * bound to this exact decision, and an appeal can only ever be decided once.
 */
export async function adminResolveAppeal(request: Request, env: RuntimeEnv): Promise<Response> {
  const actor = await adminActor(env, request);
  if (!actor) return apiError("Admin session required", 401);
  let body: ResolveBody;
  try {
    body = await readJson<ResolveBody>(request, 8_192);
  } catch {
    return apiError("Invalid appeal decision");
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (id.length === 0) return apiError("An appeal id is required");
  if (!isAppealResolution(body.resolution)) return apiError("Unknown appeal resolution");
  const status = appealStatusFor(body.resolution);
  const named = Array.isArray(body.liftKinds) ? body.liftKinds : [];
  const liftKinds = RESTRICTION_KINDS.filter((kind) => named.includes(kind));

  const appeal = await env.DB.prepare(
    "SELECT id, wallet, message, status, state_at_submission, created_at, resolved_at, resolved_by, " +
      "resolution_note FROM appeals WHERE id = ?1",
  )
    .bind(id)
    .first<AppealRow>();
  if (!appeal) return apiError("Unknown appeal", 404);
  if (appeal.status !== "OPEN") return apiError("That appeal was already decided", 409);

  const proof = await requireAdminStepUp(env, {
    actor,
    action: "appeal.resolve",
    payload: stepUpPayload(body),
    proof: body.stepUp,
  });
  if (!proof.ok) return proof.response;

  const now = Math.floor(Date.now() / 1_000);
  const note =
    typeof body.note === "string" ? body.note.trim().slice(0, RISK_OPS.appeals.maxNoteLength) : null;
  // The conditional WHERE is the arbiter: two operators deciding the same appeal at once cannot
  // both win, however their requests interleave.
  const decided = await env.DB.prepare(
    "UPDATE appeals SET status = ?1, resolved_at = ?2, resolved_by = ?3, resolution_note = ?4 " +
      "WHERE id = ?5 AND status = 'OPEN'",
  )
    .bind(status, now, actor, note, id)
    .run();
  if (decided.meta.changes <= 0) return apiError("That appeal was already decided", 409);

  const lifted: RestrictionKind[] = [];
  if (status === "ACCEPTED") {
    for (const kind of liftKinds) {
      if (await clearRestriction(env, appeal.wallet, kind)) lifted.push(kind);
    }
  }
  await writeAudit(env, actor, "appeal.resolve", id, {
    wallet: appeal.wallet,
    resolution: status,
    note,
    lifted,
    stepUp: proof.nonce,
  });
  return json(
    {
      appeal: appealView({
        ...appeal,
        status,
        resolved_at: now,
        resolved_by: actor,
        resolution_note: note,
      }),
      lifted,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
