import type { LaunchRequest, MiningReport, PlayerProfile, TokenSummary } from "../shared/types";
import { startAnalytics } from "./analytics";

async function parseResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? "Request failed");
  return data;
}

export async function getBootstrap(): Promise<TokenSummary[]> {
  try {
    const response = await fetch("/api/bootstrap?limit=1000");
    const data = await parseResponse<{
      tokens: TokenSummary[];
      config: { posthogApiKey?: string; posthogHost?: string };
    }>(response);
    void startAnalytics(data.config);
    return data.tokens;
  } catch {
    return [];
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
