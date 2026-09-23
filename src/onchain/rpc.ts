/**
 * On-chain reads through the Worker's RPC proxy.
 *
 * The indexer API is the fast path for anything the UI lists; these readers are the fallback
 * and the authority. Every action that signs a transaction reads its accounts from here
 * immediately before it builds the instruction, so a form's seconds-old state can never decide
 * what goes on chain.
 *
 * Decoders and PDA derivations come from shared/program.ts and shared/pdas.ts (WS-D), which are
 * the single client transcription of the frozen contract. Nothing in src/ re-implements them.
 */
import type { Address } from "@solana/kit";
import {
  decodeCoin,
  decodeDiscoveryOpportunity,
  decodeGlobalBudget,
  decodeLiquidityPool,
  decodeMiningPosition,
  decodePlayerAccount,
  decodeProtocolConfig,
  decodeSponsorEvent,
  decodeSponsorGrant,
  decodeSponsorVault,
  type DecodedCoin,
  type DecodedDiscoveryOpportunity,
  type DecodedGlobalBudget,
  type DecodedLiquidityPool,
  type DecodedMiningPosition,
  type DecodedPlayerAccount,
  type DecodedProtocolConfig,
  type DecodedSponsorEvent,
  type DecodedSponsorGrant,
  type DecodedSponsorVault,
} from "../../shared/program";
import {
  deriveAssociatedTokenAddress,
  deriveCoinPda,
  deriveGlobalBudgetPda,
  deriveOpportunityPda,
  derivePlayerPda,
  derivePoolPda,
  derivePositionPda,
  deriveProtocolPda,
  deriveSponsorEventPda,
  deriveSponsorGrantPda,
  deriveSponsorVaultPda,
} from "../../shared/pdas";
import { rpc } from "./tx";

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Reads one account and decodes it. A missing account is null, and so is one whose
 * discriminator does not match — a decoder that accepted the wrong account would hand the UI a
 * plausible number read out of unrelated bytes.
 */
export async function fetchAndDecode<T>(
  pda: Address,
  decode: (data: Uint8Array) => T,
): Promise<T | null> {
  const info = await rpc.getAccountInfo(pda, { commitment: "confirmed", encoding: "base64" }).send();
  if (!info.value) return null;
  try {
    return decode(base64ToBytes(info.value.data[0]));
  } catch {
    return null;
  }
}

export async function accountExists(pda: Address): Promise<boolean> {
  const info = await rpc.getAccountInfo(pda, { commitment: "confirmed" }).send();
  return info.value !== null;
}

/** The current slot, for maturity, seed arming and crank readiness. */
export async function fetchCurrentSlot(): Promise<bigint> {
  return rpc.getSlot({ commitment: "confirmed" }).send();
}

/**
 * A recent blockhash, which a transaction message needs before it can be handed to a multisig
 * for signatures. It is not a signature and cannot move anything on its own.
 */
export async function fetchLatestBlockhash(): Promise<string> {
  const { value } = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
  return value.blockhash;
}

export async function fetchProtocolConfig(programAddress: Address): Promise<DecodedProtocolConfig | null> {
  return fetchAndDecode(await deriveProtocolPda(programAddress), decodeProtocolConfig);
}

export async function fetchCoin(programAddress: Address, mint: Address): Promise<DecodedCoin | null> {
  return fetchAndDecode(await deriveCoinPda(programAddress, mint), decodeCoin);
}

export async function fetchPlayer(programAddress: Address, owner: Address): Promise<DecodedPlayerAccount | null> {
  return fetchAndDecode(await derivePlayerPda(programAddress, owner), decodePlayerAccount);
}

export async function fetchPosition(
  programAddress: Address,
  coin: Address,
  owner: Address,
): Promise<DecodedMiningPosition | null> {
  return fetchAndDecode(await derivePositionPda(programAddress, coin, owner), decodeMiningPosition);
}

export async function fetchPool(programAddress: Address, mint: Address): Promise<DecodedLiquidityPool | null> {
  return fetchAndDecode(await derivePoolPda(programAddress, mint), decodeLiquidityPool);
}

export async function fetchGlobalBudget(
  programAddress: Address,
  dayIndex: number,
): Promise<DecodedGlobalBudget | null> {
  return fetchAndDecode(await deriveGlobalBudgetPda(programAddress, dayIndex), decodeGlobalBudget);
}

export async function fetchSponsorVault(
  programAddress: Address,
  sponsorOwner: Address,
): Promise<(DecodedSponsorVault & { address: Address }) | null> {
  const address = await deriveSponsorVaultPda(programAddress, sponsorOwner);
  const vault = await fetchAndDecode(address, decodeSponsorVault);
  return vault ? { ...vault, address } : null;
}

export async function fetchSponsorEvent(
  programAddress: Address,
  sponsorVault: Address,
  eventId: number,
): Promise<DecodedSponsorEvent | null> {
  return fetchAndDecode(await deriveSponsorEventPda(programAddress, sponsorVault, eventId), decodeSponsorEvent);
}

export async function fetchSponsorGrant(
  programAddress: Address,
  sponsorEvent: Address,
  subject: Address,
): Promise<DecodedSponsorGrant | null> {
  return fetchAndDecode(await deriveSponsorGrantPda(programAddress, sponsorEvent, subject), decodeSponsorGrant);
}

/**
 * Every event a sponsor vault has created, by the ids the vault itself counts. There is
 * deliberately no on-chain registry that enumerates events, so a client either knows a vault
 * address (its own) or learns the addresses from the indexer.
 */
export async function fetchSponsorEvents(
  programAddress: Address,
  sponsorVault: Address,
  eventCount: number,
): Promise<{ eventId: number; address: Address; event: DecodedSponsorEvent }[]> {
  const ids = Array.from({ length: eventCount }, (_, index) => index);
  const events = await Promise.all(
    ids.map(async (eventId) => {
      const address = await deriveSponsorEventPda(programAddress, sponsorVault, eventId);
      return { eventId, address, event: await fetchAndDecode(address, decodeSponsorEvent) };
    }),
  );
  return events.filter(
    (entry): entry is { eventId: number; address: Address; event: DecodedSponsorEvent } =>
      entry.event !== null,
  );
}

/** A trade venue: the bonding curve before graduation, the locked pool after it. */
export type SwapVenue = "curve" | "pool";

export interface CoinVenueState {
  coin: DecodedCoin;
  pool: DecodedLiquidityPool | null;
  venue: SwapVenue;
  /**
   * The crank-pool share of a trade's fee, which is a ProtocolConfig field rather than a Coin
   * field and is 0 by default. A caller that has read ProtocolConfig passes it; a caller that
   * has not leaves it at 0, which is the value the program ships with.
   */
  crankPoolFeeBps: number;
}

/**
 * The venue is decided by the coin's own `graduated` flag and nothing else. The program
 * rejects the wrong instruction with MarketGraduated / MarketNotGraduated, so guessing from an
 * unreadable pool account would route a trade into a guaranteed failure.
 */
export function resolveSwapVenue(coin: { graduated: boolean }): SwapVenue {
  return coin.graduated ? "pool" : "curve";
}

/** Reads a coin and its pool in one pass. */
export async function fetchCoinVenue(
  programAddress: Address,
  mint: Address,
  options: { crankPoolFeeBps?: number } = {},
): Promise<CoinVenueState | null> {
  const coinAddress = await deriveCoinPda(programAddress, mint);
  const poolAddress = await derivePoolPda(programAddress, mint);
  const [coin, pool] = await Promise.all([
    fetchAndDecode(coinAddress, decodeCoin),
    fetchAndDecode(poolAddress, decodeLiquidityPool),
  ]);
  if (!coin) return null;
  return { coin, pool, venue: resolveSwapVenue(coin), crankPoolFeeBps: options.crankPoolFeeBps ?? 0 };
}

/** A pending discovery opportunity and the address it lives at. */
export interface OpportunityHandle {
  address: Address;
  opportunity: DecodedDiscoveryOpportunity;
}

/**
 * Finds the player's opportunity for a window.
 *
 * The PDA is keyed on `window_index`, which `create_discovery_roll` reads out of
 * `player.roll_window`. Whether that field holds the window the roll is being made in or the
 * last one it was made in changes the derived address by one, so both candidates are probed
 * here rather than one being assumed: this is a read, and finding the account that exists is
 * strictly better than trusting a convention that the program has not yet pinned.
 */
/**
 * The wallet's pending opportunity, or null when it has none.
 *
 * The window index is pinned by CCR-F1 and there is exactly one candidate, so nothing here probes.
 * create_discovery_roll derives the opportunity PDA from player.roll_window **as it stands before
 * the handler runs** (the accounts struct's seeds) and increments roll_window only afterwards, so
 * the opportunity a wallet holds is always the window one below its current roll_window, and
 * roll_window 0 means the wallet has never rolled at all.
 */
export async function findOpportunity(
  programAddress: Address,
  coin: Address,
  owner: Address,
  player: Pick<DecodedPlayerAccount, "rollWindow">,
): Promise<OpportunityHandle | null> {
  if (player.rollWindow <= 0) return null;
  const windowIndex = (player.rollWindow - 1) & 0xffff;
  const address = await deriveOpportunityPda(programAddress, coin, owner, windowIndex);
  const opportunity = await fetchAndDecode(address, decodeDiscoveryOpportunity);
  return opportunity ? { address, opportunity } : null;
}

export async function fetchSolBalance(owner: Address): Promise<bigint> {
  const { value } = await rpc.getBalance(owner, { commitment: "confirmed" }).send();
  return value;
}

export async function fetchTokenBalance(owner: Address, mint: Address): Promise<bigint> {
  const ata = await deriveAssociatedTokenAddress(owner, mint);
  const { value } = await rpc.getTokenAccountBalance(ata, { commitment: "confirmed" }).send();
  return BigInt(value.amount);
}

/** The player's token account for a coin, derived rather than read. */
export function playerTokenAccount(owner: Address, mint: Address): Promise<Address> {
  return deriveAssociatedTokenAddress(owner, mint);
}
