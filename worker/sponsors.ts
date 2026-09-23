/**
 * Sponsor reads: the one enumeration the frontend cannot make for itself.
 *
 * A SponsorEvent is a PDA keyed on (vault, event_id) and there is deliberately no on-chain registry
 * that lists them, so a creator cannot discover that an active LaunchRentSubsidy event covers their
 * launch, and the "Sponsored" badge would have no source. The indexer is what closes that gap: it
 * sweeps every SponsorEvent by discriminator (worker/chainV2.ts#listSponsorEvents), mirrors them in
 * D1, and serves the two lists here.
 *
 * Two things are true of everything in this module, and they are the reason it can be trusted as a
 * hint but never as an authority:
 *
 * 1. It reads D1 and derives nothing about money. The row is a copy of what the chain said, and the
 *    client re-reads each event on chain before it believes it (src/solanaProgram.ts#findLaunchSubsidy
 *    is the decision, this is the address list).
 * 2. It never reports a subsidy it cannot address. An event id is a PDA seed and not a stored field,
 *    so it is recovered by deriving the ids the owning vault says exist; an event whose vault is not
 *    mirrored yet is left out rather than given a guessed id, because the client re-reads at the id
 *    it is handed and a wrong id would silently drop a real subsidy.
 *
 * The endpoints are public: a sponsor event is a public on-chain fact, the payload holds no wallet's
 * private state, and scoping by owner only narrows the list.
 */
import { address } from "@solana/kit";
import { deriveSponsorEventPdaSync } from "../shared/pdas";
import type { RuntimeEnv } from "./env";
import { apiError, isBase58Address, json } from "./http";

/** The payload src/api.ts consumes, field for field. */
export interface SponsorEventSummary {
  /** The vault's own event_count at creation, which is the event PDA's second seed. */
  eventId: number;
  /** The SponsorEvent PDA. */
  event: string;
  /** The SponsorVault PDA the event spends from. */
  vault: string;
  /** 0 launch rent, 1 platform fee waiver, 2 player account, 3 player bond. */
  kind: number;
  startAt: number;
  endAt: number;
  budgetLamports: string;
  spentLamports: string;
  perCoinLimitLamports: string;
  perWalletLimitLamports: string;
  paused: boolean;
}

interface SponsorEventRow {
  event: string;
  vault: string;
  kind: number;
  start_at: number;
  end_at: number;
  budget_lamports: string;
  spent_lamports: string;
  per_coin_limit_lamports: string;
  per_wallet_limit_lamports: string;
  paused: number;
  event_count: number;
  sponsor_owner: string;
}

const SPONSOR_EVENT_SELECT = `SELECT e.event, e.vault, e.kind, e.start_at, e.end_at,
    e.budget_lamports, e.spent_lamports, e.per_coin_limit_lamports, e.per_wallet_limit_lamports,
    e.paused, v.event_count AS event_count, v.sponsor_owner AS sponsor_owner
  FROM sponsor_events e
  JOIN sponsor_vaults v ON v.vault = e.vault`;

/**
 * The event id of one SponsorEvent PDA, recovered from the ids its vault says exist.
 *
 * A SponsorVault counts its events in event_count, and create_sponsor_event uses that count as the
 * id, so the ids 0..event_count-1 are exactly the PDAs that vault has made. Matching the address is
 * what makes the answer exact rather than positional.
 */
function eventIdOf(programAddress: string, vault: string, eventAddress: string, count: number): number {
  for (let eventId = 0; eventId < count; eventId++) {
    if (deriveSponsorEventPdaSync(address(programAddress), address(vault), eventId) === eventAddress) {
      return eventId;
    }
  }
  return -1;
}

function toSummary(row: SponsorEventRow, programAddress: string): SponsorEventSummary | null {
  const eventId = eventIdOf(programAddress, row.vault, row.event, row.event_count);
  if (eventId < 0) return null;
  return {
    eventId,
    event: row.event,
    vault: row.vault,
    kind: row.kind,
    startAt: row.start_at,
    endAt: row.end_at,
    budgetLamports: row.budget_lamports,
    spentLamports: row.spent_lamports,
    perCoinLimitLamports: row.per_coin_limit_lamports,
    perWalletLimitLamports: row.per_wallet_limit_lamports,
    paused: row.paused !== 0,
  };
}

async function summaries(env: RuntimeEnv, owner: string | null): Promise<SponsorEventSummary[]> {
  const programAddress = env.DIGGO_PROGRAM_ID;
  if (!programAddress) return [];
  const statement = owner
    ? env.DB.prepare(SPONSOR_EVENT_SELECT + " WHERE v.sponsor_owner = ?1 ORDER BY e.start_at DESC")
    : env.DB.prepare(SPONSOR_EVENT_SELECT + " ORDER BY e.start_at DESC");
  const bound = owner ? statement.bind(owner) : statement;
  const rows = await bound.all<SponsorEventRow>();
  const events: SponsorEventSummary[] = [];
  for (const row of rows.results ?? []) {
    const summary = toSummary(row, programAddress);
    if (summary) events.push(summary);
  }
  return events;
}

/**
 * Every sponsor event the indexer knows about. A cluster whose indexer has not swept yet answers
 * with an empty list, which the launch form reads as "the creator pays" - the honest default
 * rather than a promise the chain would not keep.
 */
export async function sponsorEvents(_request: Request, env: RuntimeEnv): Promise<Response> {
  return json({ events: await summaries(env, null) });
}

/** The same list for one sponsor vault, which is what the admin screen manages. */
export async function sponsorEventsForOwner(
  _request: Request,
  env: RuntimeEnv,
  owner: string,
): Promise<Response> {
  if (!isBase58Address(owner)) return apiError("A base58 wallet address is required.");
  return json({ events: await summaries(env, owner) });
}
