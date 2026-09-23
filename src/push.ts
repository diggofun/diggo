/**
 * Client side of the Web Push opt-in. The delivery side is worker/push.ts.
 *
 * Default off, in three separate senses: nothing is registered until enablePush() is called, the
 * subscription only becomes usable after the player grants the browser permission, and the Worker
 * only ever sends to endpoints it has a signed session for. disablePush() unregisters on the
 * server and then drops the browser subscription, so switching alerts off is immediate.
 *
 * A failed DELETE still unsubscribes locally: the device stops receiving anything, and the stale
 * server row is pruned by the push service answering 404/410 (see worker/push.ts).
 */

export type PushState = "unsupported" | "blocked" | "off" | "on";

const SERVICE_WORKER_URL = "/sw.js";
const KEY_ENDPOINT = "/api/push/key";
const SUBSCRIPTION_ENDPOINT = "/api/push/subscription";
const SUBSCRIPTION_CHANGE_MESSAGE = "diggo:push-subscription-change";

export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
  );
}

/**
 * The VAPID public key as the browser wants it: a raw P-256 point. Returned as an ArrayBuffer-backed
 * view because TypeScript 5.7's generic Uint8Array otherwise widens to SharedArrayBuffer, which
 * pushManager.subscribe does not accept.
 */
function decodeApplicationServerKey(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function messageOf(response: Response, fallback: string): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    return typeof data.error === "string" && data.error.length > 0 ? data.error : fallback;
  } catch {
    return fallback;
  }
}

/** The VAPID public key, and whether the server is configured for alerts at all. */
export async function alertsAvailable(): Promise<{ enabled: boolean; publicKey: string | null }> {
  const response = await fetch(KEY_ENDPOINT, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("Alert settings are unavailable right now.");
  const data = (await response.json()) as { enabled?: unknown; publicKey?: unknown };
  return {
    enabled: data.enabled === true,
    publicKey: typeof data.publicKey === "string" && data.publicKey.length > 0 ? data.publicKey : null,
  };
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return "off";
    const subscription = await registration.pushManager.getSubscription();
    return subscription ? "on" : "off";
  } catch {
    return "off";
  }
}

async function activeRegistration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  await navigator.serviceWorker.register(SERVICE_WORKER_URL, { scope: "/" });
  return navigator.serviceWorker.ready;
}

async function registerOnServer(subscription: PushSubscription): Promise<void> {
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  const response = await fetch(SUBSCRIPTION_ENDPOINT, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      userAgent: navigator.userAgent,
    }),
  });
  if (response.status === 401) throw new Error("Sign in with your wallet first.");
  if (!response.ok) throw new Error(await messageOf(response, "Could not turn alerts on."));
}

/** Turns alerts on for this device. Returns "blocked" when the browser refuses permission. */
export async function enablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const key = await alertsAvailable();
  if (!key.enabled || key.publicKey === null) {
    throw new Error("Alerts are not configured on the server yet.");
  }
  const permission = await Notification.requestPermission();
  if (permission !== "granted") return "blocked";
  const registration = await activeRegistration();
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: decodeApplicationServerKey(key.publicKey),
    }));
  await registerOnServer(subscription);
  return "on";
}

/** Turns alerts off for this device: server first, then the browser subscription. */
export async function disablePush(): Promise<PushState> {
  if (!pushSupported()) return "unsupported";
  const registration = await navigator.serviceWorker.getRegistration();
  const subscription = registration ? await registration.pushManager.getSubscription() : null;
  if (!subscription) return "off";
  try {
    await fetch(SUBSCRIPTION_ENDPOINT, {
      method: "DELETE",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } finally {
    await subscription.unsubscribe();
  }
  return "off";
}

/**
 * The push service may rotate an endpoint and the service worker cannot re-register on its own
 * (that needs a signed session). This forwards the worker's request to the page.
 */
export function watchSubscriptionRotations(onRotate: () => void): () => void {
  if (!pushSupported()) return () => undefined;
  const listener = (event: MessageEvent) => {
    const data = event.data as { type?: unknown } | null;
    if (data && data.type === SUBSCRIPTION_CHANGE_MESSAGE) onRotate();
  };
  navigator.serviceWorker.addEventListener("message", listener);
  return () => navigator.serviceWorker.removeEventListener("message", listener);
}
