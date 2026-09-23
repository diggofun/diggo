/**
 * The keeper: the only backend authority the Solana program trusts, and only for two things —
 * pushing a player's off-chain, ORE-funded Crew Power on-chain (sync_crew_power) and paying out
 * a server-approved random Discovery from a token's own Discovery Reserve (claim_discovery). It
 * can never move the launch market, the treasury, or a player's claimable mining rewards — see
 * docs/CUSTODY.md.
 *
 * It also has one permissionless job: once a bonding curve has reached its graduation target it
 * calls graduate_market, which moves the curve's entire liquidity into the program-owned
 * constant-product pool (spec 36). The keeper pays only the pool's rent — it signs for nothing in
 * the pool afterwards, and no instruction, keeper included, can withdraw that liquidity.
 *
 * Two on-chain hardening rules shape how it calls the program: Crew Power is bounded by
 * ProtocolConfig.max_crew_power and by a per-call increase bound, so a large Crew upgrade is
 * pushed as the largest step the program accepts; and every discovery payout must carry a unique
 * discovery_id, which seeds an on-chain receipt so a retry can never pay the same discovery twice.
 *
 * Runs inside the same Cloudflare Worker as everything else, triggered by INDEXING_QUEUE jobs
 * (see processQueueEvent in worker/indexing.ts) — no separate always-on process required. The
 * keeper's secret key lives only in the DIGGO_KEEPER_SECRET_KEY Cloudflare secret; it is never
 * read by, or reachable from, the browser.
 */
import {
  address,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  pipe,
  type KeyPairSigner,
  type Rpc,
  type SolanaRpcApi,
} from "@solana/kit";
import {
  deriveProtocolPda,
  deriveMineAddresses,
  derivePoolAddresses,
  derivePlayerPda,
  derivePositionPda,
  deriveAssociatedTokenAddress,
  deriveDiscoveryReceiptPda,
  buildSyncCrewPowerInstruction,
  buildAdvanceMineInstruction,
  buildClaimDiscoveryInstruction,
  buildGraduateMarketInstruction,
  decodeMine,
  decodePlayer,
  decodeProtocolConfig,
  decodeLaunchMarket,
 decodeLiquidityPool,
  type DecodedLaunchMarket,
  type DecodedMine,
  type DecodedLiquidityPool,
  deriveMarketPdaSync,
  SYNC_BEHIND_ERROR_CODE,
} from "../shared/program";
import { getChainRpc } from "./chain";

export interface KeeperEnv {
  DIGGO_KEEPER_SECRET_KEY?: string;
  DIGGO_PROGRAM_ID: string;
  DIGGO_RPC_URL?: string;
}

async function getKeeperSigner(env: KeeperEnv): Promise<KeyPairSigner> {
  if (!env.DIGGO_KEEPER_SECRET_KEY) {
    throw new Error("DIGGO_KEEPER_SECRET_KEY is not configured — the keeper cannot sign anything");
  }
  const bytes = new Uint8Array(JSON.parse(env.DIGGO_KEEPER_SECRET_KEY));
  return createKeyPairSignerFromBytes(bytes);
}

async function signSendConfirm(
  rpc: Rpc<SolanaRpcApi>,
  feePayer: KeyPairSigner,
  instructions: Parameters<typeof appendTransactionMessageInstructions>[0],
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signedTx = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signedTx);
  const wireTransaction = getBase64EncodedWireTransaction(signedTx);
  await rpc.sendTransaction(wireTransaction, { encoding: "base64", preflightCommitment: "confirmed" }).send();

  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    const status = value[0];
    if (status?.err) throw new Error(`Keeper transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return signature;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Keeper transaction confirmation timed out");
}

/**
 * Pushes `newPower` on-chain for `owner`'s position on `mint`'s mine. Returns null (a no-op,
 * not an error) if the player hasn't called assign_power for this mine yet — sync_crew_power
 * requires an already-initialized MiningPosition account, and the game's off-chain ORE/Crew
 * loop must keep working even for players who never touch the chain directly.
 *
 * The program caps Crew Power at ProtocolConfig.max_crew_power and limits how far one call may
 * raise it, so a big Crew upgrade is pushed as the largest step the program will accept and the
 * remainder converges on the next sync, instead of failing on every retry.
 */
export async function keeperSyncCrewPower(
  env: KeeperEnv,
  owner: string,
  mint: string,
  newPower: bigint,
): Promise<string | null> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const ownerAddress = address(owner);
  const mintAddress = address(mint);
  const protocolPda = await deriveProtocolPda(programAddress);
  const { mine } = await deriveMineAddresses(programAddress, mintAddress);
  const positionPda = await derivePositionPda(programAddress, mine, ownerAddress);
  const playerPda = await derivePlayerPda(programAddress, ownerAddress);

  const [positionInfo, playerInfo, protocolInfo] = await Promise.all([
    rpc.getAccountInfo(positionPda, { commitment: "confirmed" }).send(),
    rpc.getAccountInfo(playerPda, { commitment: "confirmed" }).send(),
    rpc.getAccountInfo(protocolPda, { commitment: "confirmed" }).send(),
  ]);
  if (!positionInfo.value || !playerInfo.value || !protocolInfo.value) return null;

  const protocol = decodeProtocolConfig(base64ToBytes(protocolInfo.value.data[0]));
  const currentPower = decodePlayer(base64ToBytes(playerInfo.value.data[0])).power;
  const nextPower = nextPowerStep(currentPower, newPower, protocol);
  if (nextPower === currentPower) return null;

  const keeper = await getKeeperSigner(env);
  const instruction = buildSyncCrewPowerInstruction({
    programAddress,
    keeper: keeper.address,
    protocol: protocolPda,
    owner: ownerAddress,
    player: playerPda,
    mine,
    mint: mintAddress,
    position: positionPda,
    newPower: nextPower,
  });
  const signature = await signSendConfirm(rpc, keeper, [instruction]);
  if (nextPower !== newPower) {
    console.log(
      JSON.stringify({
        event: "keeper.power_step_clamped",
        wallet: owner,
        mint,
        requested: newPower.toString(),
        pushed: nextPower.toString(),
        signature,
      }),
    );
  }
  return signature;
}

/**
 * Pays `amountRaw` (base units) of `mint` from its Discovery Reserve to `recipient`'s own ATA.
 *
 * `discoveryId` is the unique id of the off-chain discovery record — the D1 discoveries row id
 * is exactly the right thing to pass. It seeds an on-chain receipt PDA, so replaying an id fails
 * instead of paying the same discovery twice, which is why it is a required argument: an omitted
 * id would seed a fresh receipt on every retry and could pay twice.
 */
export async function keeperClaimDiscovery(
  env: KeeperEnv,
  recipient: string,
  mint: string,
  amountRaw: bigint,
  discoveryId: bigint | string,
): Promise<string> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mintAddress = address(mint);
  const recipientAddress = address(recipient);
  const protocolPda = await deriveProtocolPda(programAddress);
  const { mine, discoveryVault } = await deriveMineAddresses(programAddress, mintAddress);
  const recipientTokens = await deriveAssociatedTokenAddress(recipientAddress, mintAddress);
  const id = resolveDiscoveryId(discoveryId);
  const receipt = await deriveDiscoveryReceiptPda(programAddress, mine, id);

  const keeper = await getKeeperSigner(env);
  const instruction = buildClaimDiscoveryInstruction({
    programAddress,
    keeper: keeper.address,
    protocol: protocolPda,
    mine,
    mint: mintAddress,
    discoveryVault,
    recipient: recipientAddress,
    recipientTokens,
    discoveryId: id,
    receipt,
    amount: amountRaw,
  });
  return signSendConfirm(rpc, keeper, [instruction]);
}

/**
 * True when a keeper call was refused by the program with `SyncBehind` - the retryable answer that
 * says a mine's ledger is still behind, rather than a failure.
 *
 * The program is the authority on whether a mine is caught up, so the keeper asks and reacts
 * instead of predicting. A disagreement between the program's rule and this worker's model of it
 * must be able to cost a wasted transaction; it must never be able to stall a market that would
 * otherwise graduate. Both shapes the refusal arrives in are matched - the anchor error name that
 * the program logs, and the numeric code - because a preflight failure surfaces as a transaction
 * error whose logs carry the name and whose message may carry either.
 */
export function isSyncBehindError(error: unknown): boolean {
  const text = errorText(error);
  return (
    text.includes("SyncBehind") ||
    text.includes(`Error Number: ${SYNC_BEHIND_ERROR_CODE}`) ||
    text.includes(`custom program error: 0x${SYNC_BEHIND_ERROR_CODE.toString(16)}`)
  );
}

/** An error's own text: its message, its logs, and the same for everything that caused it. */
function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const record = current as { message?: unknown; logs?: unknown; cause?: unknown };
    if (typeof record.message === "string") parts.push(record.message);
    if (Array.isArray(record.logs)) parts.push(record.logs.join("\n"));
    try {
      parts.push(String(current));
    } catch {
      // A throwing getter is not worth losing the fields above for.
    }
    current = record.cause;
  }
  return parts.join("\n");
}

/**
 * Graduates a market whose bonding curve has reached its target, moving the curve's whole
 * SOL and token liquidity into the program-owned constant-product pool (spec 36).
 *
 * The instruction is permissionless and the keeper only pays the pool's rent. This is a
 * deliberate no-op — returning null, not throwing — in every case where there is nothing
 * to do: no market account, an already graduated market, a market that has not reached its
 * target, or a pool that already exists. That way the caller can run it on every indexing
 * pass without turning a normal state into an error.
 *
 * One refusal it cannot pre-empt is a mine whose ledger is behind: the program walks the mine to
 * the present under the curve phase before it ends that phase - every block that landed before
 * graduation is paid out of the curve's own inventory - and answers SyncBehind while the mine is
 * further behind than one bounded walk can cover. That is a retryable throw rather than a no-op,
 * and the indexing loop reacts to it (isSyncBehindError) rather than trying to predict it: the
 * program's own verdict is the only authority on whether a ledger is caught up, and a caller that
 * pre-empts it from its own model can defer a graduation that would have succeeded.
 *
 * The program never flips the graduated flag on a buy: the flag and the pool are created
 * together here, so a market can never end up graduated with its liquidity stranded in
 * neither venue.
 */
export async function keeperGraduateMarket(env: KeeperEnv, mint: string): Promise<string | null> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mintAddress = address(mint);
  const { mine, market, marketVault } = await deriveMineAddresses(programAddress, mintAddress);
  const poolAddresses = await derivePoolAddresses(programAddress, mintAddress);

  const [marketInfo, poolInfo] = await Promise.all([
    rpc.getAccountInfo(market, { commitment: "confirmed", encoding: "base64" }).send(),
    rpc.getAccountInfo(poolAddresses.pool, { commitment: "confirmed" }).send(),
  ]);
  if (!marketInfo.value || poolInfo.value) return null;

  const decoded = decodeLaunchMarket(base64ToBytes(marketInfo.value.data[0]));
  if (decoded.graduated || decoded.solReserve < decoded.graduationTarget) return null;

  const keeper = await getKeeperSigner(env);
  const instruction = buildGraduateMarketInstruction({
    programAddress,
    payer: keeper.address,
    mint: mintAddress,
    mine,
    market,
    marketVault,
    pool: poolAddresses.pool,
    poolTokenVault: poolAddresses.poolTokenVault,
    poolSolVault: poolAddresses.poolSolVault,
  });
  const signature = await signSendConfirm(rpc, keeper, [instruction]);
  console.log(
    JSON.stringify({
      event: "keeper.market_graduated",
      mint,
      pool: poolAddresses.pool,
      solReserve: decoded.solReserve.toString(),
      tokenReserve: decoded.tokenReserve.toString(),
      signature,
    }),
  );
  return signature;
}

/** Where a mine's market is currently trading, and the reserves of that venue. */
export interface MarketVenue {
  graduated: boolean;
  /** The bonding curve's reserves; both zero once the market has graduated. */
  market: ReturnType<typeof decodeLaunchMarket>;
  /** The locked pool, or null while the market is still on the curve. */
  pool: DecodedLiquidityPool | null;
}

/**
 * Reads the venue a market is trading on, so the off-chain price and index paths read the
 * reserves that actually back the price. Returns null only when the market account itself
 * is missing.
 *
 * After graduation market.tokenReserve and market.solReserve are both zero by design — the
 * liquidity lives in the pool — so a caller that reads the market alone would price every
 * graduated token at zero. Use this to pick the right reserves.
 */
export async function keeperReadVenue(env: KeeperEnv, mint: string): Promise<MarketVenue | null> {
  const rpc = getChainRpc(env);
  const programAddress = address(env.DIGGO_PROGRAM_ID);
  const mintAddress = address(mint);
  const { market } = await deriveMineAddresses(programAddress, mintAddress);
  const { pool } = await derivePoolAddresses(programAddress, mintAddress);

  const [marketInfo, poolInfo] = await Promise.all([
    rpc.getAccountInfo(market, { commitment: "confirmed", encoding: "base64" }).send(),
    rpc.getAccountInfo(pool, { commitment: "confirmed", encoding: "base64" }).send(),
  ]);
  if (!marketInfo.value) return null;

  const decodedMarket = decodeLaunchMarket(base64ToBytes(marketInfo.value.data[0]));
  return {
    graduated: decodedMarket.graduated,
    market: decodedMarket,
    pool: poolInfo.value ? decodeLiquidityPool(base64ToBytes(poolInfo.value.data[0])) : null,
  };
}

// --- bounded keeper power (mirrors validate_power_update in the program) ---------------

/**
 * True when this discovery already has an on-chain receipt, which is proof that it was paid.
 *
 * This is the authority the retry path consults instead of trusting an error string: after a
 * keeper call fails, the only safe question is "did the program really record a payout for this
 * discovery?". Guessing wrong in the "it was paid" direction would strand a player's reward, so an
 * unreadable answer counts as "not paid" and the caller reverts to ELIGIBLE and retries.
 */
export async function keeperDiscoveryReceiptExists(
  env: KeeperEnv,
  mint: string,
  discoveryId: bigint | string,
): Promise<boolean> {
  try {
    const rpc = getChainRpc(env);
    const programAddress = address(env.DIGGO_PROGRAM_ID);
    const { mine } = await deriveMineAddresses(programAddress, address(mint));
    const receipt = await deriveDiscoveryReceiptPda(programAddress, mine, resolveDiscoveryId(discoveryId));
    const info = await rpc.getAccountInfo(receipt, { commitment: "confirmed" }).send();
    return info.value !== null;
  } catch (error) {
    console.error(
      JSON.stringify({ event: "keeper.receipt_check_failed", mint, error: String(error) }),
    );
    return false;
  }
}

/** Fallbacks mirror DEFAULT_MAX_CREW_POWER / DEFAULT_MAX_POWER_INCREASE_BPS / MIN_POWER_STEP. */
const FALLBACK_MAX_CREW_POWER = 50_000n;
const FALLBACK_MAX_POWER_INCREASE_BPS = 10_000;
const MIN_POWER_STEP = 1_000n;

/**
 * The largest Crew Power the program will accept for this call: clamped to the configured
 * ceiling and to the configured per-call increase bound (plus the always-allowed step).
 * Decreases pass through untouched, matching the on-chain rule.
 */
export function nextPowerStep(
  current: bigint,
  target: bigint,
  bounds: { maxCrewPower: bigint; maxPowerIncreaseBps: number } | null,
): bigint {
  const ceiling = bounds?.maxCrewPower ?? FALLBACK_MAX_CREW_POWER;
  const increaseBps = bounds?.maxPowerIncreaseBps ?? FALLBACK_MAX_POWER_INCREASE_BPS;
  const clamped = target > ceiling ? ceiling : target;
  if (clamped <= current) return clamped;
  const allowed = current + (current * BigInt(increaseBps)) / 10_000n + MIN_POWER_STEP;
  return clamped < allowed ? clamped : allowed;
}

// --- discovery ids --------------------------------------------------------------------

/**
 * Maps a discovery record id to the u64 that seeds its on-chain receipt. Strings (D1 row ids)
 * are hashed deterministically, so retrying a claim reuses the same receipt and cannot double-pay.
 *
 * A missing id is a hard error rather than a random fallback: a random id would seed a fresh
 * receipt on every retry, which is exactly the double-pay this receipt exists to prevent.
 */
export function resolveDiscoveryId(discoveryId: bigint | string): bigint {
  if (typeof discoveryId === "bigint") return discoveryId & 0xffffffffffffffffn;
  if (typeof discoveryId === "string" && discoveryId.length > 0) return fnv1a64(discoveryId);
  throw new Error("keeperClaimDiscovery requires the discovery record id that seeds its receipt");
}

function fnv1a64(value: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(value)) {
    hash = ((hash ^ BigInt(byte)) * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash;
}

function base64ToBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

// --- permissionless ledger catch-up (spec 57, 78) ---------------------------------------

/** Segments one advance_mine call walks on chain. Mirrors MAX_SYNC_SEGMENTS in the program. */
export const MINE_ADVANCE_SEGMENTS_PER_CALL = 64;

/**
 * How many advance_mine calls one indexing tick may spend on a single mine.
 *
 * A catch-up is charged per call rather than per mine, so a mine that has been idle for days costs a
 * few transactions on this tick and the rest on the next one instead of an unbounded burst. Each
 * call commits its own progress on chain, so stopping between them is always safe.
 */
export const MINE_ADVANCE_CALLS_PER_TICK = 4;

/** Where a mine's on-chain mining ledger currently is. */
export interface MineAdvanceCursor {
  /** Mine.next_block_at: the timestamp of the block the ledger owes next. */
  nextBlockAt: number;
  /** Mine.block_interval, the seconds between blocks. */
  blockInterval: number;
  /**
   * False when the program will not move this ledger whatever the keeper pays: a graduated mine
   * with an empty Mining Reserve, or one the program has already marked FullyMined. A mine whose
   * curve budget is spent is still emittable - those blocks pay nothing, but the cursor has to
   * move past them, and that is what keeps the idle stretch from being paid out of the Mining
   * Reserve once the market graduates. Optional and true by default, so a cursor built without
   * it keeps the old behaviour.
   */
  emittable?: boolean;
}

/**
 * The two chain operations the catch-up loop needs, as an interface: a read of the ledger's cursor
 * and one permissionless advance_mine transaction. Injected so the loop can be driven by a crafted
 * chain, and so the loop's own arithmetic is testable without an RPC.
 */
export interface MineAdvancer {
  readCursor(mint: string): Promise<MineAdvanceCursor | null>;
  advance(mint: string): Promise<string>;
}

/**
 * How many segments (one block interval each) a mine's ledger is behind `now`.
 *
 * Zero when the mine is at or ahead of the present, and zero when the cursor cannot describe a
 * schedule at all: a mine the program will not advance is not one the keeper should keep paying to
 * advance.
 */
export function mineSegmentsBehind(cursor: MineAdvanceCursor, now: number): number {
  // A mine the program cannot source a block for is not behind: its cursor stays where it is
  // however many times it is walked, so paying to advance it would be a loop that never ends.
  if (cursor.emittable === false) return 0;
  if (!(cursor.blockInterval > 0) || !(cursor.nextBlockAt > 0)) return 0;
  if (now <= cursor.nextBlockAt) return 0;
  return Math.ceil((now - cursor.nextBlockAt) / cursor.blockInterval);
}

/**
 * True while this mine still owes the stretch of ledger that ends at its graduation cursor: it
 * has graduated, a cursor was recorded, and the walk has not consumed the stretch yet.
 *
 * Those blocks are curve-phase for good, so they may never be paid out of the Mining Reserve - and
 * they are also why a graduated mine with an empty reserve can still have work to do. Mirrors the
 * program's curve_phase_pending exactly.
 */
function curvePhasePending(mine: DecodedMine): boolean {
  return mine.graduated && mine.curvePhaseEndsAt > 0n && mine.nextBlockAt < mine.curvePhaseEndsAt;
}

/**
 * Whether `advance_mine` can move this mine's ledger at all.
 *
 * This is a mirror of the program's own opening short-circuit (sync_is_complete), because the
 * program is what decides whether a cursor moves, and a keeper that disagrees with it does not
 * merely waste a call - it loops. The two halves that matter:
 *
 * - A mine with **no power** owes nothing at all: no block reward can be divided by zero power, so
 *   advance_mine answers CaughtUp and deliberately leaves the cursor where it is. Reading that as
 *   "behind" is a gap no number of calls can close, which is exactly how a zero-power market used
 *   to look permanently behind and never graduate.
 * - A **graduated** mine can only move while its Mining Reserve has something left, or while it
 *   still owes the stretch ending at its graduation cursor. Before graduation the cursor always
 *   can, and that is deliberate even when the curve's budget is spent: those blocks accrue
 *   nothing, but the walk has to consume them, or the whole idle stretch would be paid out of the
 *   Mining Reserve in one go the moment the market graduated.
 *
 * A mine the program has already finished is not advanced, and neither is one whose market could
 * not be read: unknown is left as "ask again", so the next call fails loudly rather than stalling a
 * mine that is genuinely behind.
 */
export function mineLedgerCanMove(mine: DecodedMine, market: DecodedLaunchMarket | null): boolean {
  if (mine.totalPower === 0n) return false;
  if (mine.status === "FullyMined") return false;
  if (!market || !market.graduated) return true;
  return mine.remainingReserve > 0n || curvePhasePending(mine);
}


/** The production advancer: the mine account itself, and the permissionless advance_mine call. */
export function createChainMineAdvancer(env: KeeperEnv): MineAdvancer {
  return {
    async readCursor(mint: string): Promise<MineAdvanceCursor | null> {
      const rpc = getChainRpc(env);
      const programAddress = address(env.DIGGO_PROGRAM_ID);
      const { mine } = await deriveMineAddresses(programAddress, address(mint));
      const marketPda = deriveMarketPdaSync(programAddress, address(mint));
      const [info, marketInfo] = await Promise.all([
        rpc.getAccountInfo(mine, { commitment: "confirmed", encoding: "base64" }).send(),
        rpc.getAccountInfo(marketPda, { commitment: "confirmed", encoding: "base64" }).send(),
      ]);
      if (!info.value) return null;
      const decoded = decodeMine(base64ToBytes(info.value.data[0]));
      // See mineLedgerCanMove: which is a property of the market, and deliberately not "is there a
      // block to pay" - an idle curve-phase mine still has a cursor to move.
      const emittable = marketInfo.value
        ? mineLedgerCanMove(decoded, decodeLaunchMarket(base64ToBytes(marketInfo.value.data[0])))
        : true;
      return {
        nextBlockAt: Number(decoded.nextBlockAt),
        blockInterval: Number(decoded.blockInterval),
        emittable,
      };
    },
    async advance(mint: string): Promise<string> {
      const rpc = getChainRpc(env);
      const programAddress = address(env.DIGGO_PROGRAM_ID);
      const { mine } = await deriveMineAddresses(programAddress, address(mint));
      const keeper = await getKeeperSigner(env);
      // The market is what the walk reads to decide which side pays the blocks it credits, so
      // advance_mine requires it; the mint is what its PDA is derived from.
      return signSendConfirm(rpc, keeper, [
        buildAdvanceMineInstruction({ programAddress, mine, mint: address(mint) }),
      ]);
    },
  };
}

export interface AdvanceMineReport {
  mint: string;
  /** Segments the ledger was behind when this tick started. Zero means nothing to do. */
  behindSegments: number;
  /** The advance_mine transactions this tick sent, in order. */
  signatures: string[];
  /** True when the ledger had reached the present by the end of this tick. */
  caughtUp: boolean;
}

/**
 * Catches one mine's on-chain ledger up to the present, at most `maxCalls` advance_mine calls per
 * tick (spec 78).
 *
 * A mine that fell more than MAX_SYNC_SEGMENTS segments behind refuses claim_rewards and
 * assign_power with SyncBehind until somebody advances it; the instruction is permissionless, so
 * this loop is what stops a player's claim being blocked by a mine nobody was watching. A mine that
 * is already caught up costs one account read and sends nothing.
 */
export async function keeperAdvanceMine(
  env: KeeperEnv,
  mint: string,
  options: { maxCalls?: number; now?: number; advancer?: MineAdvancer } = {},
): Promise<AdvanceMineReport> {
  const maxCalls = Math.max(0, options.maxCalls ?? MINE_ADVANCE_CALLS_PER_TICK);
  const now = options.now ?? Math.floor(Date.now() / 1_000);
  const advancer = options.advancer ?? createChainMineAdvancer(env);
  const cursor = await advancer.readCursor(mint);
  // No mine account on chain means there is no ledger to advance - not a failure to report.
  if (!cursor) return { mint, behindSegments: 0, signatures: [], caughtUp: true };

  const behindSegments = mineSegmentsBehind(cursor, now);
  const signatures: string[] = [];
  let latest = cursor;
  while (signatures.length < maxCalls && mineSegmentsBehind(latest, now) > 0) {
    signatures.push(await advancer.advance(mint));
    // Re-read rather than assuming one call closed the whole gap: the program is the authority on
    // where the ledger landed, and the next read is also what ends the loop early.
    latest = (await advancer.readCursor(mint)) ?? latest;
  }
  return { mint, behindSegments, signatures, caughtUp: mineSegmentsBehind(latest, now) === 0 };
}
