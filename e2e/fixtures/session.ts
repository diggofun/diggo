/**
 * A real Worker session for the suite's wallet, obtained once per worker process.
 *
 * Sign-in is the same signed-challenge exchange the header performs (POST /api/auth/challenge,
 * ed25519 signature, POST /api/auth/verify) — just issued over HTTP instead of through clicks, and
 * cached for the whole file. That matters because the Worker rate-limits /api/auth/* to 12 requests
 * per IP per minute (worker/http.ts, bucket "auth"): every browser in a Playwright run shares one
 * IP, so signing in through the UI in all twelve tests would trip the product's own anti-abuse
 * limit. The interactive path is still covered end to end by e2e/auth.e2e.ts.
 */
import bs58 from "bs58";
import { signMessageBytes, wallet } from "./wallet";

const WORKER_ORIGIN = "http://localhost:8787";
const SESSION_COOKIE = "diggo_session";
const RETRY_AFTER_MS = 62_000;

export interface SessionCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  sameSite: "Lax";
}

let pending: Promise<SessionCookie> | null = null;

/** The cookie that makes this worker's wallet signed in; authenticated on first use. */
export function sessionCookie(): Promise<SessionCookie> {
  pending ??= authenticate();
  return pending;
}

async function authenticate(): Promise<SessionCookie> {
  const challenge = await post<{ nonce: string; message: string }>("/api/auth/challenge", {
    wallet: wallet.address,
  });
  const signature = bs58.encode(signMessageBytes(new TextEncoder().encode(challenge.message)));
  const response = await send("/api/auth/verify", {
    wallet: wallet.address,
    nonce: challenge.nonce,
    signature,
  });

  if (response.status === 429) {
    // The per-IP auth window is a minute wide; wait it out rather than fail the file.
    await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
    return authenticate();
  }
  if (!response.ok) {
    throw new Error("e2e session: /api/auth/verify answered " + response.status + " " + (await response.text()));
  }

  const header = response.headers.getSetCookie().find((entry) => entry.startsWith(SESSION_COOKIE + "="));
  if (!header) throw new Error("e2e session: /api/auth/verify returned no " + SESSION_COOKIE + " cookie");

  return {
    name: SESSION_COOKIE,
    value: header.slice(SESSION_COOKIE.length + 1).split(";")[0]!,
    domain: "localhost",
    path: "/",
    secure: true,
    sameSite: "Lax",
  };
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const response = await send(path, body);
  if (!response.ok) throw new Error("e2e session: " + path + " answered " + response.status);
  return (await response.json()) as T;
}

function send(path: string, body: unknown): Promise<Response> {
  return fetch(WORKER_ORIGIN + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
