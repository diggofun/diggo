import type { Leaderboards, MiningReport, PlayerProfile, TokenSummary } from "../shared/types";
import { startAnalytics } from "./analytics";

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export interface DiggoConfig {
  cluster: string;
  posthogApiKey?: string;
  posthogHost?: string;
  turnstileSiteKey: string;
  programId: string;
  vanitySuffix: string;
}

export interface Bootstrap {
  tokens: TokenSummary[];
  config: DiggoConfig;
}

export async function getBootstrap(): Promise<Bootstrap> {
  try {
    const response = await fetch("/api/bootstrap?limit=1000");
    const data = await parseResponse<Bootstrap>(response);
    void startAnalytics(data.config);
    return data;
  } catch {
    return {
      tokens: [],
      config: {
        cluster: "devnet",
        turnstileSiteKey: "",
        programId: "",
        vanitySuffix: "diggo",
      },
    };
  }
}

export async function getToken(mintOrSlug: string): Promise<TokenSummary> {
  const response = await fetch(`/api/tokens/${mintOrSlug}`);
  const data = await parseResponse<{ token: TokenSummary }>(response);
  return data.token;
}

export async function getChallenge(wallet: string): Promise<{ nonce: string; message: string }> {
  const response = await fetch("/api/auth/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  return parseResponse(response);
}

export async function verifyWallet(
  wallet: string,
  nonce: string,
  signature: string,
): Promise<{ session: string }> {
  const response = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, nonce, signature }),
  });
  return parseResponse(response);
}

export async function uploadTokenImage(file: File, session: string): Promise<string> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/media", {
    method: "POST",
    headers: { authorization: `Bearer ${session}` },
    body: form,
  });
  const data = await parseResponse<{ url: string }>(response);
  return data.url;
}

/**
 * Registers a coin the caller's wallet just launched directly on-chain (see
 * src/solanaProgram.ts#launchCoinOnChain) so the Worker's D1 cache — and therefore the rest of
 * the site — picks it up. The Worker independently re-reads the mint from chain and rejects the
 * call if the session wallet doesn't match the on-chain creator, so this cannot be used to claim
 * someone else's launch or to inject fake metadata for a token that doesn't exist.
 */
export async function registerLaunchedToken(
  mint: string,
  metadata: { description?: string; imageUrl?: string },
  session: string,
): Promise<TokenSummary> {
  const response = await fetch("/api/tokens/register", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ mint, ...metadata }),
  });
  const data = await parseResponse<{ token: TokenSummary }>(response);
  return data.token;
}

export async function getActivationChallenge(wallet: string): Promise<{ nonce: string; message: string }> {
  const response = await fetch("/api/mine/activate/challenge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet }),
  });
  return parseResponse(response);
}

export async function activateMine(
  wallet: string,
  nonce: string,
  signature: string,
  mint?: string,
): Promise<{ report: MiningReport; player: PlayerProfile }> {
  const response = await fetch("/api/mine/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ wallet, nonce, signature, mint }),
  });
  return parseResponse(response);
}

export async function getPlayerProfile(wallet: string, session: string): Promise<PlayerProfile> {
  const response = await fetch(`/api/player/${wallet}`, {
    headers: { authorization: `Bearer ${session}` },
  });
  const data = await parseResponse<{ player: PlayerProfile }>(response);
  return data.player;
}

export async function getLeaderboards(): Promise<Leaderboards> {
  const response = await fetch("/api/leaderboards");
  return parseResponse(response);
}

export async function recordTrade(
  mint: string,
  trade: { signature: string; side: "buy" | "sell"; amount: number },
): Promise<{ priceSol: number; priceUsd: number }> {
  const response = await fetch(`/api/tokens/${mint}/trades`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(trade),
  });
  return parseResponse(response);
}

export async function switchMine(mint: string, session: string): Promise<PlayerProfile> {
  const response = await fetch("/api/mine/switch", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ mint }),
  });
  const data = await parseResponse<{ player: PlayerProfile }>(response);
  return data.player;
}

export async function upgradeCrew(
  component: string,
  session: string,
): Promise<{ player: PlayerProfile; spent: number }> {
  const response = await fetch("/api/crew/upgrade", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify({ component }),
  });
  return parseResponse(response);
}
