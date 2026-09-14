import type { LaunchRequest, TokenSummary } from "../shared/types";
import { startAnalytics } from "./analytics";

export const FALLBACK_TOKENS: TokenSummary[] = [
  {
    mint: "9xK2hM7qT4vB8nP6sR3wY5cF1aG7uJ2eL8mN4diggo",
    slug: "dogwifdrill",
    name: "Dog Wif Drill",
    symbol: "DRILL",
    description: "He showed up with a hard hat and a plan.",
    creator: "D1gCr8tor...1111",
    imageUrl: null,
    status: "MINING_ACTIVE",
    priceUsd: 0.00284,
    change24h: 18.4,
    marketCapUsd: 2_840_000,
    reserveRemaining: 31_200_000,
    reserveTotal: 50_000_000,
    rewardPerBlock: 7_500,
    networkPower: 2_000_000,
    nextBlockAt: Math.floor(Date.now() / 1000) + 102,
    nextEpochAt: Math.floor(Date.now() / 1000) + 225_120,
    createdAt: Math.floor(Date.now() / 1000) - 86_400,
  },
  {
    mint: "4rT8mQ2vN6kY3cW9pF1sJ7aB5eH8uL2xG6zP9diggo",
    slug: "stone",
    name: "Stone Coin",
    symbol: "STONE",
    description: "Heavy bags. Honest blocks. Zero mint authority.",
    creator: "St0neCr8...1111",
    imageUrl: null,
    status: "MINING_ACTIVE",
    priceUsd: 0.0142,
    change24h: -4.8,
    marketCapUsd: 14_200_000,
    reserveRemaining: 42_800_000,
    reserveTotal: 50_000_000,
    rewardPerBlock: 9_200,
    networkPower: 3_450_000,
    nextBlockAt: Math.floor(Date.now() / 1000) + 221,
    nextEpochAt: Math.floor(Date.now() / 1000) + 151_200,
    createdAt: Math.floor(Date.now() / 1000) - 172_800,
  },
  {
    mint: "7bV3nK9sQ2mF6wT1yR8cP4aH5eJ9uL3xG2dM8diggo",
    slug: "mole",
    name: "Mole Money",
    symbol: "MOLE",
    description: "Underground since genesis.",
    creator: "Mo1eCr8t...1111",
    imageUrl: null,
    status: "LAUNCHING",
    priceUsd: 0.00071,
    change24h: 42.1,
    marketCapUsd: 710_000,
    reserveRemaining: 50_000_000,
    reserveTotal: 50_000_000,
    rewardPerBlock: 10_000,
    networkPower: 870_000,
    nextBlockAt: Math.floor(Date.now() / 1000) + 278,
    nextEpochAt: Math.floor(Date.now() / 1000) + 346_000,
    createdAt: Math.floor(Date.now() / 1000) - 18_000,
  },
  {
    mint: "2mP8xR4vT7kN1sW6cF9yB3aQ5eH8uJ2gL7zD4diggo",
    slug: "golden",
    name: "Golden Byte",
    symbol: "BYTE",
    description: "Internet gold with a finite vein.",
    creator: "ByteCr8t...1111",
    imageUrl: null,
    status: "MINING_ACTIVE",
    priceUsd: 0.0063,
    change24h: 9.7,
    marketCapUsd: 6_300_000,
    reserveRemaining: 19_800_000,
    reserveTotal: 50_000_000,
    rewardPerBlock: 5_625,
    networkPower: 4_890_000,
    nextBlockAt: Math.floor(Date.now() / 1000) + 54,
    nextEpochAt: Math.floor(Date.now() / 1000) + 80_200,
    createdAt: Math.floor(Date.now() / 1000) - 345_600,
  },
];

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export async function getTokens(): Promise<TokenSummary[]> {
  try {
    const response = await fetch("/api/tokens");
    const data = await parseResponse<{ tokens: TokenSummary[] }>(response);
    return data.tokens.length ? data.tokens : FALLBACK_TOKENS;
  } catch {
    return FALLBACK_TOKENS;
  }
}

export async function loadPublicConfig(): Promise<void> {
  try {
    const response = await fetch("/api/config");
    const config = await parseResponse<{
      posthogApiKey?: string;
      posthogHost?: string;
    }>(response);
    void startAnalytics(config);
  } catch {
    // Analytics must never block the app when its endpoint is unavailable.
  }
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

export async function queueLaunch(
  launch: LaunchRequest,
  session: string,
): Promise<{ id: string; status: string; vanitySuffix: string; message: string }> {
  const response = await fetch("/api/tokens", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${session}` },
    body: JSON.stringify(launch),
  });
  return parseResponse(response);
}
