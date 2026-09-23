/**
 * The watchlist, as the frontend sees it.
 *
 * A watchlist is the one list a player keeps for themselves, and it has to work before they have
 * signed anything: a star that only functions after a wallet signature would be useless on the
 * coin list a visitor is browsing. So the list lives in localStorage first, and the Worker takes
 * over once there is a session.
 *
 * The two copies are merged in one direction only. On sign-in the browser list is pushed to the
 * server, never the other way round, because a server list is already the authority for the wallet
 * it belongs to and a local list can only add to it. Once signed in, the server answer is what is
 * published, so two devices converge instead of overwriting each other.
 *
 * Nothing here decides anything about a coin: prices, market caps and mining status come from the
 * index (see worker/watchlist.ts), and a change of null is rendered as unknown rather than as a
 * flat zero.
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { TokenSummary } from "../shared/types";
import { getWalletSession } from "./api";
import { DEVICE_HEADER, deviceId } from "./device";
import { useDiggoWallet } from "./wallet";

export const WATCHLIST_STORAGE_KEY = "diggo:watchlist:v1";
/** The same cap the Worker enforces, restated so the client refuses locally before it is refused. */
export const WATCHLIST_MAX = 200;

/** One watched coin, as the panel renders it. */
export interface WatchlistCoin {
  mint: string;
  coin: string;
  slug: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  status: string;
  venue: string;
  graduated: boolean;
  priceSol: number;
  priceUsd: number;
  marketCapUsd: number;
  /** Measured from the coin own indexed trades. Null is unknown, never zero. */
  change24h: number | null;
  volume24hUsd: number;
  trades24h: number;
  mining: {
    open: boolean;
    cap: number;
    mined: number;
    remaining: number;
    progress: number;
    rewardPerBlock: number;
    unpaid: number;
  };
  addedAt: number;
}

export interface WatchlistView {
  wallet: string;
  mints: string[];
  coins: WatchlistCoin[];
  limit: number;
  syncedAt: number;
}

// --- the list itself -----------------------------------------------------------------------

/** A base58 mint, as the Worker would accept it. Anything else is dropped rather than sent. */
export function isWatchlistMint(value: unknown): value is string {
  return typeof value === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

/** Valid mints only, deduplicated, in the order they were given, capped. */
export function normalizeWatchlist(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!isWatchlistMint(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= WATCHLIST_MAX) break;
  }
  return out;
}

/**
 * The merge that happens on sign-in: the server list first, then whatever the browser watched on
 * its own. Ordering the server first means a wallet that already had a list keeps it, and the
 * cap drops the local tail rather than anything the server already knew about.
 */
export function mergeWatchlists(local: readonly string[], server: readonly string[]): string[] {
  return normalizeWatchlist([...server, ...local]);
}

/** The list with one mint added, capped. Adding something already there changes nothing. */
export function addWatchlistMint(mints: readonly string[], mint: string): string[] {
  if (!isWatchlistMint(mint)) return [...mints];
  return normalizeWatchlist([mint, ...mints]);
}

/** The list with one mint removed. */
export function removeWatchlistMint(mints: readonly string[], mint: string): string[] {
  return mints.filter((value) => value !== mint);
}

/** Add when absent, remove when present. */
export function toggleWatchlistMint(mints: readonly string[], mint: string): string[] {
  return mints.includes(mint) ? removeWatchlistMint(mints, mint) : addWatchlistMint(mints, mint);
}

/** localStorage, or null in a privacy mode that refuses it. */
function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** The browser own list. A malformed value is treated as no list rather than as an error. */
export function readLocalWatchlist(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const raw = store.getItem(WATCHLIST_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeWatchlist(parsed) : [];
  } catch {
    return [];
  }
}

export function writeLocalWatchlist(mints: readonly string[]): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(normalizeWatchlist(mints)));
  } catch {
    // A full or refused store is not worth failing a toggle over: the in-memory list is still
    // correct for this page, and the server copy is the durable one once signed in.
  }
}

// --- the Worker ---------------------------------------------------------------------------

function headers(): Headers {
  const out = new Headers();
  out.set(DEVICE_HEADER, deviceId());
  return out;
}

async function view(response: Response): Promise<WatchlistView> {
  const data = (await response.json().catch(() => null)) as (WatchlistView & { error?: string }) | null;
  if (!response.ok || !data) {
    throw new Error(data?.error ?? "The watchlist is unavailable right now.");
  }
  return data;
}

export async function getWatchlist(): Promise<WatchlistView> {
  return view(await fetch("/api/watchlist", { headers: headers(), credentials: "same-origin" }));
}

/** Adds one mint, or several at once for the sign-in merge. */
export async function postWatchlist(mints: readonly string[]): Promise<WatchlistView> {
  const body = mints.length === 1 ? { mint: mints[0] } : { mints: [...mints] };
  return view(
    await fetch("/api/watchlist", {
      method: "POST",
      headers: (() => {
        const out = headers();
        out.set("content-type", "application/json");
        return out;
      })(),
      body: JSON.stringify(body),
      credentials: "same-origin",
    }),
  );
}

export async function deleteWatchlist(mint: string): Promise<WatchlistView> {
  return view(
    await fetch("/api/watchlist/" + encodeURIComponent(mint), {
      method: "DELETE",
      headers: headers(),
      credentials: "same-origin",
    }),
  );
}

// --- the shared store ----------------------------------------------------------------------

/**
 * The one copy every star and the panel read. A per-component fetch would put the same request on
 * the coin list once per row, and two stars could disagree about whether a coin is watched.
 */
export interface WatchlistSnapshot {
  mints: string[];
  coins: WatchlistCoin[];
  /** True once the Worker answer is the published one rather than the browser own list. */
  signedIn: boolean;
  loading: boolean;
  error: string;
  limit: number;
}

const NO_COINS: WatchlistCoin[] = [];

let snapshot: WatchlistSnapshot = {
  mints: [],
  coins: NO_COINS,
  signedIn: false,
  loading: false,
  error: "",
  limit: WATCHLIST_MAX,
};
const listeners = new Set<() => void>();

function publish(next: WatchlistSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

/** Snapshot for useSyncExternalStore: the same object until the list genuinely changes. */
export function watchlistSnapshot(): WatchlistSnapshot {
  return snapshot;
}

export function subscribeWatchlist(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

let activeWallet: string | null | undefined;
let activeLoad: Promise<void> | null = null;

/**
 * Starts (or restarts) the store for one wallet, and is idempotent for the wallet it is already
 * on, so every component that calls the hook does not start a second load.
 */
export function ensureWatchlist(wallet: string | null): Promise<void> {
  if (activeWallet === wallet && activeLoad) return activeLoad;
  activeWallet = wallet;
  // The browser list is published first so a star is correct before any request settles, which is
  // the whole reason it is mirrored locally at all.
  publish({
    mints: readLocalWatchlist(),
    coins: NO_COINS,
    signedIn: false,
    loading: wallet !== null,
    error: "",
    limit: WATCHLIST_MAX,
  });
  activeLoad = wallet === null ? Promise.resolve() : connectWatchlist(wallet);
  return activeLoad;
}

/**
 * Sign in, merge, publish. The merge is the only write the browser ever makes on the player
 * behalf without being asked: it is the list they built while signed out.
 */
async function connectWatchlist(wallet: string): Promise<void> {
  const session = await getWalletSession().catch(() => null);
  if (session?.wallet !== wallet) {
    // Connected but not signed in: the local list is the whole story, and it is already published.
    publish({ ...snapshot, signedIn: false, loading: false });
    return;
  }
  const local = readLocalWatchlist();
  try {
    let server = await getWatchlist();
    const merged = mergeWatchlists(local, server.mints);
    const missing = merged.filter((mint) => !server.mints.includes(mint));
    if (missing.length > 0) server = await postWatchlist(missing);
    writeLocalWatchlist(merged);
    publish({
      mints: server.mints,
      coins: server.coins,
      signedIn: true,
      loading: false,
      error: "",
      limit: server.limit,
    });
  } catch (error) {
    // A failed load keeps the local list rather than emptying the panel: the player can still see
    // what they watched, and the error says why the prices are missing.
    publish({
      ...snapshot,
      signedIn: false,
      loading: false,
      error: error instanceof Error ? error.message : "The watchlist is unavailable right now.",
    });
  }
}

/** Re-reads the list. Signed out this is a no-op, because there is nothing to re-read. */
export async function refreshWatchlist(): Promise<void> {
  if (activeWallet) await connectWatchlist(activeWallet);
}

/**
 * Toggles one coin. Signed in the Worker is told and its answer is published; signed out only
 * localStorage changes. Either way the star moves immediately, because a toggle that waits for a
 * round trip feels broken.
 */
export async function toggleWatchlist(mint: string): Promise<void> {
  if (!isWatchlistMint(mint)) return;
  const before = snapshot;
  const watched = before.mints.includes(mint);
  const next = toggleWatchlistMint(before.mints, mint);
  if (!before.signedIn) {
    writeLocalWatchlist(next);
    publish({ ...before, mints: next, error: "" });
    return;
  }
  publish({
    ...before,
    mints: next,
    coins: watched ? before.coins.filter((coin) => coin.mint !== mint) : before.coins,
    error: "",
  });
  try {
    const server = watched ? await deleteWatchlist(mint) : await postWatchlist([mint]);
    writeLocalWatchlist(server.mints);
    publish({
      mints: server.mints,
      coins: server.coins,
      signedIn: true,
      loading: false,
      error: "",
      limit: server.limit,
    });
  } catch (error) {
    // The star goes back to where it was: an optimistic toggle that silently fails is worse than
    // one that visibly refuses.
    writeLocalWatchlist(before.mints);
    publish({
      ...before,
      error: error instanceof Error ? error.message : "The watchlist could not be saved.",
    });
  }
}

// --- the hook ------------------------------------------------------------------------------

export interface WatchlistController extends WatchlistSnapshot {
  has(mint: string): boolean;
  toggle(mint: string): void;
  refresh(): void;
}

/**
 * The watchlist for the connected wallet, or for the browser when there is none. Every caller
 * shares one store, so a star and the panel can never disagree.
 */
export function useWatchlist(): WatchlistController {
  const connected = useDiggoWallet();
  const address = connected?.address ?? null;
  const current = useSyncExternalStore(subscribeWatchlist, watchlistSnapshot, watchlistSnapshot);
  useEffect(() => {
    void ensureWatchlist(address);
  }, [address]);
  return useMemo(
    () => ({
      ...current,
      has: (mint: string) => current.mints.includes(mint),
      toggle: (mint: string) => void toggleWatchlist(mint),
      refresh: () => void refreshWatchlist(),
    }),
    [current],
  );
}

// --- rows ----------------------------------------------------------------------------------

/**
 * The coins the app already bootstrapped with, in the shape the panel renders.
 *
 * This is the signed-out path: without a session there is no `/api/watchlist` answer, but the
 * coin list the page loaded is enough to show a price, a change and a mining status for anything
 * in it. A coin that is not in either list renders as unknown rather than as a row of zeros.
 */
export function tokenToWatchlistCoin(token: TokenSummary, addedAt: number): WatchlistCoin {
  return {
    mint: token.mint,
    coin: token.mint,
    slug: token.slug,
    name: token.name,
    symbol: token.symbol,
    imageUrl: token.imageUrl,
    status: token.status,
    venue: token.curveMining.onCurve ? "curve" : "pool",
    graduated: !token.curveMining.onCurve,
    priceSol: token.priceSol,
    priceUsd: token.priceUsd,
    marketCapUsd: token.marketCapUsd,
    change24h: token.change24h,
    volume24hUsd: token.volume24hUsd,
    trades24h: token.trades24h,
    mining: {
      open: token.curveMining.open,
      cap: token.curveMining.cap,
      mined: token.curveMining.mined,
      remaining: token.curveMining.remaining,
      progress: token.curveMining.progress,
      rewardPerBlock: token.curveMining.blockReward,
      unpaid: token.curveMining.unpaid,
    },
    addedAt,
  };
}

export interface WatchlistRow {
  mint: string;
  /** Null when neither the index nor the bootstrapped coin list knows this mint. */
  coin: WatchlistCoin | null;
}

/**
 * The rows the panel draws, in the list own order. The index answer wins where there is one,
 * because it is the newer copy, and the bootstrapped list fills in the rest.
 */
export function watchlistRows(
  mints: readonly string[],
  coins: readonly WatchlistCoin[],
  tokens: readonly TokenSummary[] = [],
): WatchlistRow[] {
  const byMint = new Map(coins.map((coin) => [coin.mint, coin]));
  const fallback = new Map(tokens.map((token) => [token.mint, token]));
  return mints.map((mint) => {
    const indexed = byMint.get(mint);
    if (indexed) return { mint, coin: indexed };
    const token = fallback.get(mint);
    return { mint, coin: token ? tokenToWatchlistCoin(token, 0) : null };
  });
}

