/**
 * Public usernames in the browser: one small store, one hook, and the fallback rule.
 *
 * The server owns the name (worker/profile.ts); this module only remembers what it last answered so
 * the header, the leaderboard and the mining report can all show the same thing without three
 * requests. A name saved anywhere lands in the store through rememberUsername, and every mounted
 * reader re-renders from it, so the three never disagree about who the player is.
 *
 * The store is read through useSyncExternalStore rather than copied into component state: an answer
 * that arrives while a screen is open has to reach every reader at once, and "a request is in
 * flight" is a property of the store, not of one component. A lookup that fails is not an error
 * state - the shortened wallet is always showable, which is what the UI showed before usernames
 * existed, and the next mount asks again.
 */
import { useEffect, useSyncExternalStore } from "react";
import { getProfile, getWalletSession } from "./api";
import type { ProfileBot } from "../shared/profileBot";
import { shortAddress } from "./format";

/** A minimal external store: a value, its readers, and a change notification. */
function createStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    set: (next: T): void => {
      value = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const usernames = createStore<ReadonlyMap<string, string | null>>(new Map());
/** Profile bots ride on the same profile answer: null means "the default bot for this wallet". */
const profileBots = createStore<ReadonlyMap<string, ProfileBot | null>>(new Map());
const pendingWallets = createStore<ReadonlySet<string>>(new Set());
const session = createStore<{ resolved: boolean; wallet: string | null }>({ resolved: false, wallet: null });

/** Writes an answer into the store and re-renders every mounted reader. */
export function rememberUsername(wallet: string, username: string | null): void {
  const next = new Map(usernames.get());
  next.set(wallet, username);
  usernames.set(next);
}

/** Writes a saved (or forgotten) profile bot into the store. */
export function rememberProfileBot(wallet: string, bot: ProfileBot | null): void {
  const next = new Map(profileBots.get());
  next.set(wallet, bot);
  profileBots.set(next);
}

async function load(wallet: string): Promise<void> {
  if ((usernames.get().has(wallet) && profileBots.get().has(wallet)) || pendingWallets.get().has(wallet)) return;
  pendingWallets.set(new Set(pendingWallets.get()).add(wallet));
  try {
    const profile = await getProfile(wallet);
    rememberUsername(wallet, profile.username);
    rememberProfileBot(wallet, profile.bot ?? null);
  } catch {
    // Left unanswered on purpose: the reader shows the shortened wallet and may ask again.
  } finally {
    const pending = new Set(pendingWallets.get());
    pending.delete(wallet);
    pendingWallets.set(pending);
  }
}

/** Resolves the signed-in wallet once per page from the session cookie (GET /api/auth/session). */
async function resolveSession(): Promise<void> {
  if (session.get().resolved) return;
  session.set({ resolved: true, wallet: null });
  try {
    const current = await getWalletSession();
    session.set({ resolved: true, wallet: current?.wallet ?? null });
  } catch {
    session.set({ resolved: true, wallet: null });
  }
}

/** What to show for a wallet: the chosen name, or the shortened address when there is none. */
export function displayName(wallet: string, username?: string | null): string {
  const name = username?.trim();
  return name !== undefined && name.length > 0 ? name : shortAddress(wallet);
}

export interface UsernameState {
  /** The wallet the answer belongs to, or null when nobody is signed in. */
  readonly wallet: string | null;
  readonly username: string | null;
  /** True while the first answer for this wallet is still in flight. */
  readonly loading: boolean;
}

export function useUsername(wallet: string | null): UsernameState {
  const byWallet = useSyncExternalStore(usernames.subscribe, usernames.get, usernames.get);
  const pending = useSyncExternalStore(pendingWallets.subscribe, pendingWallets.get, pendingWallets.get);
  useEffect(() => {
    if (wallet !== null) void load(wallet);
  }, [wallet]);
  return {
    wallet,
    username: wallet === null ? null : byWallet.get(wallet) ?? null,
    loading: wallet !== null && pending.has(wallet),
  };
}

/** The signed-in player's own username, for the screens that are not handed a wallet. */
export function useViewerUsername(): UsernameState {
  const current = useSyncExternalStore(session.subscribe, session.get, session.get);
  useEffect(() => {
    void resolveSession();
  }, []);
  return useUsername(current.wallet);
}

export interface ProfileBotState {
  /** The saved bot, or null while unknown or when the player kept the default. */
  readonly bot: ProfileBot | null;
  /** True once the server has answered for this wallet. */
  readonly known: boolean;
}

/** A wallet's saved profile bot, loaded with its username from GET /api/profile/:wallet. */
export function useProfileBotOf(wallet: string | null): ProfileBotState {
  const byWallet = useSyncExternalStore(profileBots.subscribe, profileBots.get, profileBots.get);
  useEffect(() => {
    if (wallet !== null) void load(wallet);
  }, [wallet]);
  if (wallet === null) return { bot: null, known: false };
  return { bot: byWallet.get(wallet) ?? null, known: byWallet.has(wallet) };
}
