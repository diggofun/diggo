/**
 * Web Push delivery (RFC 8030 transport, RFC 8291 message encryption, RFC 8188 aes128gcm content
 * coding, RFC 8292 VAPID) and the optional Telegram fallback channel.
 *
 * What this module is allowed to decide: whether an alert that worker/notifications.ts already
 * stored can reach a device the player switched on, and nothing else. It never invents an alert,
 * never changes a reward and never touches the reserve - the notification text is rendered from
 * the stored payload and the routing (which mine, which screen) comes from the notification kind.
 *
 * Delivery is at-most-once per (notification, channel, target). A row in push_deliveries is
 * claimed with INSERT OR IGNORE *before* the network call, so the hourly cron sweep, a page load
 * and a retried request cannot each send the same alert. A transport failure is recorded and not
 * retried: a wedged endpoint can never be turned into duplicated alerts. See the header of
 * migrations/0015_push_subscriptions.sql for the storage side of that argument.
 *
 * Everything is opt-in and default off. A subscription row only exists because the player turned
 * the device toggle on (src/components/PushToggle.tsx -> src/push.ts), and DELETE removes it again.
 * VAPID keys, the bot token and the webhook secret are read through optionalBinding (worker/env.ts)
 * so the Worker still runs, and every delivery path becomes a cheap no-op, when an operator has
 * not configured them.
 *
 * The push endpoint and the Telegram chat id are untrusted input. The endpoint must be an https URL
 * of bounded length pointing at one of the four Web Push services a browser can actually subscribe
 * through (see isAllowedPushEndpoint): a signed-in wallet must not be able to point this Worker at
 * an arbitrary host and have it POST there, from a page load or from the cron sweep. The device
 * keys must decode to a P-256 point and a 16 byte auth secret, and a device registration belongs to
 * the wallet that made it - a second wallet cannot take over an endpoint it did not register.
 */
import { sessionWallet } from "./auth";
import { optionalBinding, type RuntimeEnv } from "./env";
import { apiError, checkRateLimit, checkWalletRateLimit, json, readJson } from "./http";
import { metric } from "./telemetry";

/** Push payloads are small by design; 3 KB is well inside the 4096 byte record this module emits. */
const MAX_PAYLOAD_BYTES = 3_000;
/** RFC 8188 record size advertised in every message header. */
const RECORD_SIZE = 4_096;
const DEFAULT_TTL_SECONDS = 3_600;
/** RFC 8292 caps a VAPID token lifetime at 24 hours; twelve keeps clock skew irrelevant. */
const VAPID_TOKEN_TTL_SECONDS = 12 * 3_600;
const PUSH_TIMEOUT_MS = 8_000;
const TELEGRAM_TIMEOUT_MS = 8_000;
const MAX_FAILURES = 8;
const MAX_SUBSCRIPTIONS_PER_WALLET = 10;
const MAX_NOTIFICATIONS_PER_RUN = 5;
const MAX_ENDPOINT_LENGTH = 1_024;
const MAX_USER_AGENT_LENGTH = 200;
const MAX_TELEGRAM_TEXT_LENGTH = 1_000;
const TELEGRAM_CODE_TTL_SECONDS = 600;
const TELEGRAM_CODE_LENGTH = 10;
/** Crockford-style alphabet: no I, O, 0 or 1, so a code survives being read off a screen. */
const TELEGRAM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PUSH_TITLE = "Diggo.fun";
/** RFC 8188: the last (here: only) record ends with 0x02. */
const FINAL_RECORD_DELIMITER = new Uint8Array([2]);

/**
 * The push services a browser subscription can legitimately point at, one entry per browser that
 * ships Web Push. Only these hosts are ever handed to fetch: without this, any signed-in wallet
 * could register `https://attacker.example/` and have the Worker (including its cron trigger) issue
 * an authenticated POST to a host of their choosing - a server-side request forgery primitive.
 */
const PUSH_ENDPOINT_HOSTS: readonly string[] = Object.freeze([
  "fcm.googleapis.com", // Chrome / Chromium / Edge (legacy FCM path)
  "updates.push.services.mozilla.com", // Firefox
  "web.push.apple.com", // Safari
]);
/**
 * Service hosts that are sharded per region or per tenant, so only the parent domain is fixed:
 * `<region>.notify.windows.com` (Edge/Windows) and `<something>.push.apple.com` (Safari).
 */
const PUSH_ENDPOINT_HOST_SUFFIXES: readonly string[] = Object.freeze([
  ".push.services.mozilla.com",
  ".notify.windows.com",
  ".push.apple.com",
]);

/** IPv4 in any of the notations URL parsing normalizes to dotted-quad, plus bracketed/bare IPv6. */
const IPV4_HOST_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function isIpLiteralHost(hostname: string): boolean {
  if (hostname.startsWith("[") || hostname.endsWith("]")) return true;
  if (hostname.includes(":")) return true;
  return IPV4_HOST_PATTERN.test(hostname);
}

/**
 * True only for an https URL on port 443 whose host is one of the Web Push services above. Every
 * other origin - a bare IP literal, a redirect-free internal host, a lookalike domain, a plain
 * http URL or an unusual port - is refused, so the endpoint stored in D1 and the endpoint passed
 * to fetch are the same closed set (spec 65).
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  // URL parses the default port for https as "", so anything else is an explicit other port.
  if (url.port !== "" && url.port !== "443") return false;
  if (url.username.length > 0 || url.password.length > 0) return false;
  const hostname = url.hostname.toLowerCase();
  if (hostname.length === 0) return false;
  if (isIpLiteralHost(hostname)) return false;
  if (PUSH_ENDPOINT_HOSTS.includes(hostname)) return true;
  return PUSH_ENDPOINT_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
}

/** Loggable form of an endpoint: the host only, never the path, which carries the device token. */
function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid";
  }
}

const TEXT_ENCODER = new TextEncoder();

/**
 * A byte view backed by a plain ArrayBuffer. TypeScript 5.7 made Uint8Array generic, and WebCrypto
 * and fetch only accept ArrayBuffer-backed views, so every byte helper here says so explicitly
 * rather than letting a SharedArrayBuffer-compatible type leak into a subtle call.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/* --- base64url --------------------------------------------------------------------------- */

export function base64UrlToBytes(value: string): Bytes {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, "");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concatBytes(head: Bytes, ...rest: readonly Bytes[]): Bytes {
  let total = head.length;
  for (const part of rest) total += part.length;
  const out = new Uint8Array(total);
  out.set(head, 0);
  let offset = head.length;
  for (const part of rest) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function uint32be(value: number): Bytes {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", TEXT_ENCODER.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* --- RFC 8291 message encryption --------------------------------------------------------- */

export interface EncryptedPushPayload {
  /** The complete request body: the RFC 8188 header followed by the sealed record. */
  readonly body: Bytes;
  readonly salt: Bytes;
  readonly localPublicKey: Bytes;
}

/** The device public key as the browser hands it over: base64url, uncompressed P-256, 65 bytes. */
export function decodeSubscriptionKey(value: string): Bytes {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 65 || bytes[0] !== 4) throw new Error("Invalid device public key");
  return bytes;
}

/** The device auth secret: 16 random bytes, base64url. */
export function decodeAuthSecret(value: string): Bytes {
  const bytes = base64UrlToBytes(value);
  if (bytes.length !== 16) throw new Error("Invalid auth secret");
  return bytes;
}

/**
 * One aes128gcm record, encrypted for a single device.
 *
 * The key schedule is the one RFC 8291 section 3.4 prescribes: ECDH with the device key, the auth
 * secret as HKDF salt, then the "WebPush: info" derivation to obtain the input keying material,
 * and finally the RFC 8188 content encryption key and nonce derived under the per-message salt.
 */
export async function encryptWebPushPayload(
  payload: Bytes,
  p256dh: string,
  authSecret: string,
): Promise<EncryptedPushPayload> {
  if (payload.length === 0) throw new Error("Empty push payload");
  const receiverPublic = decodeSubscriptionKey(p256dh);
  const auth = decodeAuthSecret(authSecret);
  const receiverKey = await crypto.subtle.importKey(
    "raw",
    receiverPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ephemeral = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const localPublicKey = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: receiverKey }, ephemeral.privateKey, 256),
  );
  const sharedKey = await crypto.subtle.importKey("raw", sharedSecret, "HKDF", false, ["deriveBits"]);
  const keyInfo = concatBytes(
    TEXT_ENCODER.encode("WebPush: info"),
    new Uint8Array([0]),
    receiverPublic,
    localPublicKey,
  );
  const inputKeyingMaterial = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: auth, info: keyInfo },
      sharedKey,
      256,
    ),
  );
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const contentKeyMaterial = await crypto.subtle.importKey("raw", inputKeyingMaterial, "HKDF", false, [
    "deriveBits",
  ]);
  const contentEncryptionKey = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: concatBytes(TEXT_ENCODER.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])),
      },
      contentKeyMaterial,
      128,
    ),
  );
  const nonce = new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: concatBytes(TEXT_ENCODER.encode("Content-Encoding: nonce"), new Uint8Array([0])),
      },
      contentKeyMaterial,
      96,
    ),
  );
  const aesKey = await crypto.subtle.importKey("raw", contentEncryptionKey, "AES-GCM", false, ["encrypt"]);
  const plaintext = concatBytes(payload, FINAL_RECORD_DELIMITER);
  if (plaintext.length + 16 > RECORD_SIZE) throw new Error("Push payload too large");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, plaintext),
  );
  const header = concatBytes(salt, uint32be(RECORD_SIZE), new Uint8Array([localPublicKey.length]), localPublicKey);
  return { body: concatBytes(header, ciphertext), salt, localPublicKey };
}

/* --- VAPID (RFC 8292) -------------------------------------------------------------------- */

export interface VapidConfig {
  /** base64url, uncompressed P-256 point: the "k" half of the Authorization header. */
  readonly publicKey: string;
  /** base64url, the 32 byte private scalar. */
  readonly privateKey: string;
  /** mailto: or https: contact the push service may use. */
  readonly subject: string;
}

export function vapidConfig(env: RuntimeEnv): VapidConfig | null {
  const publicKey = optionalBinding<string>(env, "VAPID_PUBLIC_KEY");
  const privateKey = optionalBinding<string>(env, "VAPID_PRIVATE_KEY");
  const subject = optionalBinding<string>(env, "VAPID_SUBJECT");
  if (!publicKey || !privateKey || !subject) return null;
  if (!subject.startsWith("mailto:") && !subject.startsWith("https:")) return null;
  try {
    decodeSubscriptionKey(publicKey);
    if (base64UrlToBytes(privateKey).length !== 32) return null;
  } catch {
    return null;
  }
  return { publicKey, privateKey, subject };
}

/** True when Web Push is fully configured. Used by the opt-in UI to stay honest about it. */
export function pushEnabled(env: RuntimeEnv): boolean {
  return vapidConfig(env) !== null;
}

async function vapidSigningKey(config: VapidConfig): Promise<CryptoKey> {
  const publicKey = decodeSubscriptionKey(config.publicKey);
  const privateKey = base64UrlToBytes(config.privateKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToBase64Url(publicKey.slice(1, 33)),
    y: bytesToBase64Url(publicKey.slice(33, 65)),
    d: bytesToBase64Url(privateKey),
    ext: true,
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/**
 * The Authorization header for one push service: a fresh ES256 JWT bound to that service origin.
 * ES256 signatures are raw r||s, which is exactly what WebCrypto returns for P-256.
 */
export async function vapidAuthorizationHeader(
  config: VapidConfig,
  audience: string,
  now = Date.now(),
): Promise<string> {
  const header = bytesToBase64Url(TEXT_ENCODER.encode('{"typ":"JWT","alg":"ES256"}'));
  const claims = JSON.stringify({
    aud: audience,
    exp: Math.floor(now / 1_000) + VAPID_TOKEN_TTL_SECONDS,
    sub: config.subject,
  });
  const signingInput = header + "." + bytesToBase64Url(TEXT_ENCODER.encode(claims));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      await vapidSigningKey(config),
      TEXT_ENCODER.encode(signingInput),
    ),
  );
  return "vapid t=" + signingInput + "." + bytesToBase64Url(signature) + ", k=" + config.publicKey;
}

/* --- message text ------------------------------------------------------------------------ */

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Same-origin path the service worker opens when the player taps the notification. */
  readonly url: string;
  /** Alerts of one kind replace each other instead of stacking. */
  readonly tag: string;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(source: Record<string, unknown>, name: string): string | null {
  const value = source[name];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(source: Record<string, unknown>, name: string): number | null {
  const value = source[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function durationText(seconds: number | null): string {
  if (seconds === null || seconds <= 0) return "shortly";
  if (seconds < 3_600) return Math.max(1, Math.round(seconds / 60)) + " minutes";
  if (seconds < 86_400) {
    const hours = Math.max(1, Math.round(seconds / 3_600));
    return hours + (hours === 1 ? " hour" : " hours");
  }
  const days = Math.max(1, Math.round(seconds / 86_400));
  return days + (days === 1 ? " day" : " days");
}

function mineUrl(data: Record<string, unknown>): string {
  const mint = stringField(data, "mint");
  return mint === null ? "/mines" : "/mines?mint=" + encodeURIComponent(mint);
}

function minePrefix(data: Record<string, unknown>): string {
  const symbol = stringField(data, "symbol");
  return symbol === null ? "This mine's " : symbol + "'s ";
}

/**
 * Renders one stored notification into the sentence a device shows. Pure, so the copy can be
 * reviewed without running a Worker, and total, so an unexpected payload degrades to a generic
 * line instead of an empty notification.
 */
export function notificationMessage(kind: string, payload: unknown): PushMessage {
  const data = payloadRecord(payload);
  const tag = kind.toLowerCase();
  switch (kind) {
    case "MINE_EXPIRES_3H":
      return {
        title: PUSH_TITLE,
        body: "Your mining window closes in " + durationText(numberField(data, "expiresInSeconds")) + ".",
        url: "/mine",
        tag,
      };
    case "MINE_EXPIRED":
      return {
        title: PUSH_TITLE,
        body: "Your mining window ended. Collect the report to bank what you mined.",
        url: "/mine",
        tag,
      };
    case "STREAK_AT_RISK": {
      const streak = numberField(data, "streak");
      const label = streak === null ? "your streak" : "your " + streak + " day streak";
      return {
        title: PUSH_TITLE,
        body: "Activate within " + durationText(numberField(data, "remainingSeconds")) + " to keep " + label + ".",
        url: "/mine",
        tag,
      };
    }
    case "STREAK_7_DAY":
      return {
        title: PUSH_TITLE,
        body: "Seven days in a row. Your streak milestone reward is in.",
        url: "/mine",
        tag,
      };
    case "RARE_DISCOVERY_FOUND": {
      const rarity = stringField(data, "rarity");
      const name = stringField(data, "name");
      return {
        title: PUSH_TITLE,
        body: (name === null ? "A memecoin" : name) + " was mined: " +
          (rarity === null ? "a rare discovery" : rarity) + ".",
        url: "/discoveries",
        tag,
      };
    }
    case "TOKEN_ALMOST_FULLY_MINED":
      return {
        title: PUSH_TITLE,
        body: minePrefix(data) + "reserve is almost fully mined.",
        url: mineUrl(data),
        tag,
      };
    case "REWARD_REDUCTION_APPROACHING":
      return {
        title: PUSH_TITLE,
        body: minePrefix(data) + "reserve is close to the next reward step.",
        url: mineUrl(data),
        tag,
      };
    default:
      return {
        title: PUSH_TITLE,
        body: "Something changed in your mine.",
        url: "/mine",
        tag: "diggo",
      };
  }
}

/* --- subscription input ------------------------------------------------------------------ */

export interface PushSubscriptionInput {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly userAgent: string | null;
}

function validEndpoint(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENDPOINT_LENGTH) return null;
  // The allowlist is checked here and again in sendWebPush, so neither a crafted registration nor a
  // row written before this check existed can ever become a fetch target.
  if (!isAllowedPushEndpoint(value)) return null;
  // The raw string is kept, not url.toString(): the browser sends back exactly this value on
  // unsubscribe, so keying the dedupe on it has to be byte-for-byte stable.
  return value;
}

function validSubscriptionKey(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    decodeSubscriptionKey(value);
  } catch {
    return null;
  }
  return value;
}

function validAuthSecret(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    decodeAuthSecret(value);
  } catch {
    return null;
  }
  return value;
}

/** Validates the body of POST /api/push/subscription. Returns null on anything unexpected. */
export function parsePushSubscription(body: unknown): PushSubscriptionInput | null {
  const data = payloadRecord(body);
  const endpoint = validEndpoint(data.endpoint);
  if (endpoint === null) return null;
  const keys = payloadRecord(data.keys);
  const p256dh = validSubscriptionKey(keys.p256dh);
  const auth = validAuthSecret(keys.auth);
  if (p256dh === null || auth === null) return null;
  const userAgent = stringField(data, "userAgent");
  return {
    endpoint,
    p256dh,
    auth,
    userAgent: userAgent === null ? null : userAgent.slice(0, MAX_USER_AGENT_LENGTH),
  };
}

/* --- storage ----------------------------------------------------------------------------- */

export interface StoredSubscription {
  readonly id: number;
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
  readonly failureCount: number;
}

interface SubscriptionRow {
  id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  failure_count: number;
}

export async function activeSubscriptions(env: RuntimeEnv, wallet: string): Promise<StoredSubscription[]> {
  const rows = await env.DB.prepare(
    "SELECT id, endpoint, p256dh, auth, failure_count FROM push_subscriptions" +
      " WHERE wallet = ?1 AND disabled_at IS NULL ORDER BY last_seen_at DESC, id DESC LIMIT ?2",
  )
    .bind(wallet, MAX_SUBSCRIPTIONS_PER_WALLET)
    .all<SubscriptionRow>();
  return rows.results.map((row) => ({
    id: row.id,
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
    failureCount: row.failure_count,
  }));
}

async function activeSubscriptionCount(env: RuntimeEnv, wallet: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS total FROM push_subscriptions WHERE wallet = ?1 AND disabled_at IS NULL",
  )
    .bind(wallet)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

/** Keeps the newest devices and drops the rest, so one wallet cannot hoard registrations. */
async function pruneSubscriptions(env: RuntimeEnv, wallet: string, now: number): Promise<void> {
  await env.DB.prepare(
    "DELETE FROM push_subscriptions WHERE wallet = ?1 AND id NOT IN" +
      " (SELECT id FROM push_subscriptions WHERE wallet = ?1 ORDER BY last_seen_at DESC, id DESC LIMIT ?2)",
  )
    .bind(wallet, MAX_SUBSCRIPTIONS_PER_WALLET)
    .run();
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE disabled_at IS NOT NULL AND disabled_at < ?1")
    .bind(now - 180 * 86_400)
    .run();
}

/**
 * Claims the right to deliver one alert to one target. The insert is the mutual exclusion: the
 * second caller sees changes === 0 and stays quiet.
 */
export async function claimDelivery(
  env: RuntimeEnv,
  notificationId: number,
  channel: "webpush" | "telegram",
  target: string,
  now: number,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "INSERT OR IGNORE INTO push_deliveries (notification_id, channel, target, status, delivered_at)" +
      " VALUES (?1, ?2, ?3, 0, ?4)",
  )
    .bind(notificationId, channel, target, now)
    .run();
  return (result.meta?.changes ?? 0) > 0;
}

async function recordDelivery(
  env: RuntimeEnv,
  notificationId: number,
  channel: "webpush" | "telegram",
  target: string,
  status: number,
  now: number,
): Promise<void> {
  await env.DB.prepare(
    "UPDATE push_deliveries SET status = ?4, delivered_at = ?5" +
      " WHERE notification_id = ?1 AND channel = ?2 AND target = ?3",
  )
    .bind(notificationId, channel, target, status, now)
    .run();
}

async function noteSuccess(env: RuntimeEnv, id: number, now: number): Promise<void> {
  await env.DB.prepare("UPDATE push_subscriptions SET failure_count = 0, last_success_at = ?2 WHERE id = ?1")
    .bind(id, now)
    .run();
}

async function noteFailure(env: RuntimeEnv, id: number, now: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE push_subscriptions SET failure_count = failure_count + 1," +
      " disabled_at = CASE WHEN failure_count + 1 >= ?2 THEN ?3 ELSE disabled_at END WHERE id = ?1",
  )
    .bind(id, MAX_FAILURES, now)
    .run();
}

async function disableSubscription(env: RuntimeEnv, id: number, now: number): Promise<void> {
  await env.DB.prepare("UPDATE push_subscriptions SET disabled_at = ?2 WHERE id = ?1").bind(id, now).run();
}

/* --- web push transport ------------------------------------------------------------------ */

export interface SendWebPushResult {
  readonly status: number;
  readonly ok: boolean;
  /** The push service says this subscription is finished (404/410) or will never fit (413). */
  readonly finished: boolean;
}

export async function sendWebPush(
  config: VapidConfig,
  subscription: Pick<StoredSubscription, "endpoint" | "p256dh" | "auth">,
  message: PushMessage,
  ttlSeconds = DEFAULT_TTL_SECONDS,
): Promise<SendWebPushResult> {
  const payload = TEXT_ENCODER.encode(JSON.stringify({ ...message }));
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("Push payload too large");
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    // A stored endpoint outside the Web Push allowlist can never be delivered to, whatever wrote it.
    // Reporting it as finished retires the row instead of leaving a request the Worker must not make.
    console.error(
      JSON.stringify({ event: "push.endpoint_refused", host: endpointHost(subscription.endpoint) }),
    );
    return { status: 0, ok: false, finished: true };
  }
  const encrypted = await encryptWebPushPayload(payload, subscription.p256dh, subscription.auth);
  const audience = new URL(subscription.endpoint).origin;
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      authorization: await vapidAuthorizationHeader(config, audience),
      "content-encoding": "aes128gcm",
      "content-type": "application/octet-stream",
      ttl: String(ttlSeconds),
      urgency: "normal",
      topic: message.tag.slice(0, 32),
    },
    body: encrypted.body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
  });
  const status = response.status;
  return {
    status,
    ok: response.ok,
    finished: status === 404 || status === 410 || status === 413,
  };
}

/* --- Telegram (optional second channel) -------------------------------------------------- */

export interface TelegramConfig {
  readonly token: string;
  readonly username: string | null;
  readonly webhookSecret: string | null;
}

export function telegramConfig(env: RuntimeEnv): TelegramConfig | null {
  const token = optionalBinding<string>(env, "TELEGRAM_BOT_TOKEN");
  if (!token || !/^[0-9]+:[A-Za-z0-9_-]+$/.test(token)) return null;
  return {
    token,
    username: optionalBinding<string>(env, "TELEGRAM_BOT_USERNAME") ?? null,
    webhookSecret: optionalBinding<string>(env, "TELEGRAM_WEBHOOK_SECRET") ?? null,
  };
}

/** True when at least one delivery channel is configured at all. */
export function deliveryConfigured(env: RuntimeEnv): boolean {
  return vapidConfig(env) !== null || telegramConfig(env) !== null;
}

export interface TelegramSendResult {
  readonly ok: boolean;
  readonly status: number;
  /** The chat is gone or the bot was blocked: the link should be dropped. */
  readonly finished: boolean;
}

export async function sendTelegramMessage(
  env: RuntimeEnv,
  chatId: string,
  text: string,
  /** A button that opens Diggo inside Telegram as a Mini App. */
  play?: { label: string; url: string },
): Promise<TelegramSendResult> {
  const config = telegramConfig(env);
  if (config === null) return { ok: false, status: 0, finished: false };
  let response: Response;
  try {
    response = await fetch("https://api.telegram.org/bot" + config.token + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: text.slice(0, MAX_TELEGRAM_TEXT_LENGTH),
        disable_web_page_preview: true,
        ...(play ? { reply_markup: { inline_keyboard: [[{ text: play.label, web_app: { url: play.url } }]] } } : {}),
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, finished: false };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const data = payloadRecord(body);
  const ok = response.ok && data.ok === true;
  const description = (stringField(data, "description") ?? "").toLowerCase();
  const finished =
    !ok &&
    (response.status === 403 ||
      description.includes("blocked") ||
      description.includes("chat not found") ||
      description.includes("deactivated") ||
      description.includes("kicked"));
  return { ok, status: response.status, finished };
}

function telegramText(message: PushMessage, origin: string): string {
  return [message.title, message.body, origin + message.url].join("\n");
}

function randomTelegramCode(): string {
  const random = crypto.getRandomValues(new Uint8Array(TELEGRAM_CODE_LENGTH));
  let code = "";
  // 256 is an exact multiple of the alphabet length, so the modulo introduces no bias.
  for (const byte of random) code += TELEGRAM_CODE_ALPHABET[byte % TELEGRAM_CODE_ALPHABET.length] ?? "A";
  return code;
}

async function telegramChatId(env: RuntimeEnv, wallet: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT chat_id FROM telegram_links WHERE wallet = ?1")
    .bind(wallet)
    .first<{ chat_id: string }>();
  return row?.chat_id ?? null;
}

async function stampTelegramDelivery(env: RuntimeEnv, wallet: string, now: number): Promise<void> {
  await env.DB.prepare("UPDATE telegram_links SET last_delivery_at = ?2 WHERE wallet = ?1")
    .bind(wallet, now)
    .run();
}

async function unlinkTelegram(env: RuntimeEnv, chatId: string): Promise<void> {
  await env.DB.prepare("DELETE FROM telegram_links WHERE chat_id = ?1").bind(chatId).run();
}

/* --- delivery ---------------------------------------------------------------------------- */

export interface DeliverableNotification {
  readonly id: number;
  readonly kind: string;
  readonly payload: unknown;
}

export interface DeliverySummary {
  readonly attempted: number;
  readonly delivered: number;
  readonly failed: number;
  readonly skipped: number;
  readonly finished: number;
}

const EMPTY_SUMMARY: DeliverySummary = { attempted: 0, delivered: 0, failed: 0, skipped: 0, finished: 0 };

/**
 * Sends the given already-stored notifications to every channel the wallet has switched on.
 *
 * Never throws: delivery is best effort and a push service having a bad day must not fail the
 * request or the cron tick that asked for it. Bounded per run, so a wallet with a long backlog
 * cannot turn one page load into a burst of HTTP calls.
 */
export async function deliverNotifications(
  env: RuntimeEnv,
  wallet: string,
  notifications: readonly DeliverableNotification[],
  now = Math.floor(Date.now() / 1_000),
): Promise<DeliverySummary> {
  if (notifications.length === 0 || !deliveryConfigured(env)) return EMPTY_SUMMARY;
  const vapid = vapidConfig(env);
  let subscriptions: StoredSubscription[];
  let chatId: string | null;
  try {
    subscriptions = vapid === null ? [] : await activeSubscriptions(env, wallet);
    chatId = telegramConfig(env) === null ? null : await telegramChatId(env, wallet);
  } catch (error) {
    console.error(JSON.stringify({ event: "push.targets_failed", wallet, error: String(error) }));
    return EMPTY_SUMMARY;
  }
  if (subscriptions.length === 0 && chatId === null) return EMPTY_SUMMARY;
  let attempted = 0;
  let delivered = 0;
  let failed = 0;
  let skipped = 0;
  let finished = 0;
  for (const notification of notifications.slice(0, MAX_NOTIFICATIONS_PER_RUN)) {
    const message = notificationMessage(notification.kind, notification.payload);
    for (const subscription of subscriptions) {
      const claimed = await claimDelivery(env, notification.id, "webpush", subscription.endpoint, now);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      attempted += 1;
      let result: SendWebPushResult;
      try {
        result = await sendWebPush(vapid as VapidConfig, subscription, message);
      } catch (error) {
        failed += 1;
        console.error(
          JSON.stringify({ event: "push.send_failed", wallet, subscription: subscription.id, error: String(error) }),
        );
        await recordDelivery(env, notification.id, "webpush", subscription.endpoint, 0, now);
        continue;
      }
      await recordDelivery(env, notification.id, "webpush", subscription.endpoint, result.status, now);
      if (result.ok) {
        delivered += 1;
        await noteSuccess(env, subscription.id, now);
      } else if (result.finished) {
        finished += 1;
        await disableSubscription(env, subscription.id, now);
      } else {
        failed += 1;
        await noteFailure(env, subscription.id, now);
      }
    }
    if (chatId !== null) {
      const claimed = await claimDelivery(env, notification.id, "telegram", chatId, now);
      if (!claimed) {
        skipped += 1;
        continue;
      }
      attempted += 1;
      const result = await sendTelegramMessage(env, chatId, telegramText(message, "https://diggo.fun"));
      await recordDelivery(env, notification.id, "telegram", chatId, result.status, now);
      if (result.ok) {
        delivered += 1;
        await stampTelegramDelivery(env, wallet, now);
      } else if (result.finished) {
        finished += 1;
        await unlinkTelegram(env, chatId);
        chatId = null;
      } else {
        failed += 1;
      }
    }
  }
  return { attempted, delivered, failed, skipped, finished };
}

/* --- HTTP handlers ----------------------------------------------------------------------- */

/**
 * GET /api/push/key: the application server key the browser needs before it can subscribe.
 * Unauthenticated on purpose - it is a public key, and the UI has to know whether alerts are
 * available at all before asking anyone to sign in.
 */
export async function pushPublicKey(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!(await checkRateLimit(request, env, "push-key", 60))) return apiError("Too many requests", 429);
  const config = vapidConfig(env);
  return json({ enabled: config !== null, publicKey: config?.publicKey ?? null });
}

/** POST /api/push/subscription: registers (or refreshes) this device for the signed-in wallet. */
export async function registerPushSubscription(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkRateLimit(request, env, "push-subscribe", 30))) {
    return apiError("Too many requests", 429);
  }
  let body: unknown;
  try {
    body = await readJson<unknown>(request, 8_192);
  } catch {
    return apiError("Invalid JSON body");
  }
  const subscription = parsePushSubscription(body);
  if (subscription === null) return apiError("Invalid push subscription");
  const now = Math.floor(Date.now() / 1_000);
  // The WHERE on the upsert is the ownership rule: only the wallet that already owns the endpoint
  // may refresh it. A second wallet registering the same endpoint changes nothing (changes === 0)
  // and is refused, so a signed-in attacker cannot re-point someone else's device at themselves and
  // have alerts they did not earn delivered to it, nor silence the device by overwriting its keys.
  const upsert = await env.DB.prepare(
    "INSERT INTO push_subscriptions (wallet, endpoint, p256dh, auth, user_agent, created_at, last_seen_at," +
      " failure_count, disabled_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 0, NULL)" +
      " ON CONFLICT(endpoint) DO UPDATE SET wallet = excluded.wallet, p256dh = excluded.p256dh," +
      " auth = excluded.auth, user_agent = excluded.user_agent, last_seen_at = excluded.last_seen_at," +
      " failure_count = 0, disabled_at = NULL WHERE push_subscriptions.wallet = excluded.wallet",
  )
    .bind(wallet, subscription.endpoint, subscription.p256dh, subscription.auth, subscription.userAgent, now)
    .run();
  if ((upsert.meta?.changes ?? 0) === 0) {
    await metric(env, "push.subscription_conflict", 1, {});
    return apiError("This device is already registered to another wallet", 409);
  }
  await pruneSubscriptions(env, wallet, now);
  return json({
    ok: true,
    subscriptions: await activeSubscriptionCount(env, wallet),
    enabled: pushEnabled(env),
  });
}

/**
 * DELETE /api/push/subscription: removes one device (body { endpoint }) or every device of the
 * signed-in wallet (no body). The delivery ledger is deliberately left alone: it is what stops an
 * alert the player already received from being sent again if the same device re-subscribes.
 */
export async function deletePushSubscription(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  if (!(await checkRateLimit(request, env, "push-unsubscribe", 30))) {
    return apiError("Too many requests", 429);
  }
  const raw = await request.text();
  let endpoint: string | null = null;
  if (raw.trim().length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return apiError("Invalid JSON body");
    }
    const candidate = payloadRecord(parsed).endpoint;
    if (candidate !== undefined) {
      endpoint = validEndpoint(candidate);
      if (endpoint === null) return apiError("Invalid push endpoint");
    }
  }
  const result =
    endpoint === null
      ? await env.DB.prepare("DELETE FROM push_subscriptions WHERE wallet = ?1").bind(wallet).run()
      : await env.DB.prepare("DELETE FROM push_subscriptions WHERE wallet = ?1 AND endpoint = ?2")
          .bind(wallet, endpoint)
          .run();
  return json({ removed: result.meta?.changes ?? 0 });
}

/**
 * POST /api/telegram/link: mints a one-time code for the signed-in wallet. The plaintext code is
 * returned once and stored only as a hash; nothing is linked until the player sends it back to the
 * bot, which is what proves they control that chat.
 */
export async function startTelegramLink(request: Request, env: RuntimeEnv): Promise<Response> {
  const wallet = await sessionWallet(request, env);
  if (!wallet) return apiError("Wallet authentication required", 401);
  const config = telegramConfig(env);
  if (config === null) return apiError("Telegram alerts are not configured", 503);
  if (!(await checkWalletRateLimit(env, wallet, "telegram-link", 5, 3_600))) {
    return apiError("Too many link codes requested", 429);
  }
  const now = Math.floor(Date.now() / 1_000);
  const code = randomTelegramCode();
  const expiresAt = now + TELEGRAM_CODE_TTL_SECONDS;
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO telegram_link_codes (code_hash, wallet, created_at, expires_at, consumed_at)" +
        " VALUES (?1, ?2, ?3, ?4, NULL)",
    ).bind(await sha256Hex(code), wallet, now, expiresAt),
    env.DB.prepare("DELETE FROM telegram_link_codes WHERE wallet = ?1 AND expires_at <= ?2").bind(wallet, now),
  ]);
  return json({
    code,
    expiresAt,
    command: "/start " + code,
    url: config.username === null ? null : "https://t.me/" + config.username + "?start=" + code,
  });
}

const PLAY_URL = "https://diggo.fun";

/** What a /start argument opens in the Mini App: a mine (m_<mint>) or a referral (r_<code>). */
export function telegramPlayTarget(argument: string): { url: string; text: string } | null {
  const mine = /^m_([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(argument);
  if (mine) return { url: PLAY_URL + "/m/" + mine[1], text: "Tap Play and your bots start digging this coin." };
  const referral = /^r_([A-Za-z0-9_-]{2,32})$/.exec(argument);
  if (referral) return { url: PLAY_URL + "/r/" + referral[1], text: "A friend invited you to Diggo. Tap Play to start mining memecoins." };
  return null;
}

/**
 * POST /webhooks/telegram: the bot side of the link flow. Fails closed when no webhook secret is
 * configured or the secret header does not match, because this endpoint is reachable from the
 * public internet and can bind a chat to a wallet.
 */
export async function telegramWebhook(request: Request, env: RuntimeEnv): Promise<Response> {
  const config = telegramConfig(env);
  if (config === null || config.webhookSecret === null) {
    return apiError("Telegram webhook is not configured", 404);
  }
  const received = request.headers.get("x-telegram-bot-api-secret-token");
  if (received === null || received !== config.webhookSecret) return apiError("Unauthorized", 401);
  let update: unknown;
  try {
    update = await readJson<unknown>(request, 16_384);
  } catch {
    return apiError("Invalid JSON body");
  }
  const message = payloadRecord(payloadRecord(update).message);
  const chatId = numberField(payloadRecord(message.chat), "id");
  const text = stringField(message, "text");
  if (chatId === null || text === null) return json({ ok: true, ignored: true });
  const chat = String(chatId);
  const trimmed = text.trim();
  const now = Math.floor(Date.now() / 1_000);
  if (trimmed === "/stop" || trimmed.startsWith("/stop ")) {
    await unlinkTelegram(env, chat);
    await sendTelegramMessage(env, chat, "Alerts are off for this chat. You can link again at any time.");
    return json({ ok: true, action: "unlinked" });
  }
  if (trimmed === "/start" || trimmed.startsWith("/start ")) {
    const argument = trimmed.slice("/start".length).trim();
    // t.me/<bot>?start=m_<mint> and ?start=r_<code>: open the mine or the referral inside Telegram.
    const target = telegramPlayTarget(argument);
    if (target) {
      await sendTelegramMessage(env, chat, target.text, { label: "⛏️ Play Diggo", url: target.url });
      return json({ ok: true, action: "play" });
    }
    const code = argument.toUpperCase();
    if (code.length === 0) {
      await sendTelegramMessage(
        env,
        chat,
        "Diggo: your bots mine Solana memecoins for you. Tap Play to start. To get alerts here, turn on Telegram alerts in the app and send the code as /start CODE.",
        { label: "⛏️ Play Diggo", url: PLAY_URL + "/mine" },
      );
      return json({ ok: true, action: "help" });
    }
    const hash = await sha256Hex(code);
    const consumed = await env.DB.prepare(
      "UPDATE telegram_link_codes SET consumed_at = ?1 WHERE code_hash = ?2 AND consumed_at IS NULL" +
        " AND expires_at > ?1",
    )
      .bind(now, hash)
      .run();
    if ((consumed.meta?.changes ?? 0) === 0) {
      await sendTelegramMessage(env, chat, "That code is no longer valid. Mint a fresh one in the app.");
      return json({ ok: true, action: "rejected" });
    }
    const row = await env.DB.prepare("SELECT wallet FROM telegram_link_codes WHERE code_hash = ?1")
      .bind(hash)
      .first<{ wallet: string }>();
    if (!row) {
      await sendTelegramMessage(env, chat, "That code is no longer valid. Mint a fresh one in the app.");
      return json({ ok: true, action: "rejected" });
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO telegram_links (wallet, chat_id, created_at) VALUES (?1, ?2, ?3)" +
          " ON CONFLICT(wallet) DO UPDATE SET chat_id = excluded.chat_id",
      ).bind(row.wallet, chat, now),
      // One chat belongs to one wallet: linking it here detaches it from any earlier wallet.
      env.DB.prepare("DELETE FROM telegram_links WHERE chat_id = ?1 AND wallet <> ?2").bind(chat, row.wallet),
    ]);
    await sendTelegramMessage(env, chat, "Alerts are on for this chat. Send /stop to turn them off.");
    return json({ ok: true, action: "linked" });
  }
  await sendTelegramMessage(env, chat, "Send /start CODE to link alerts, or /stop to turn them off.", { label: "⛏️ Play Diggo", url: PLAY_URL + "/mine" });
  return json({ ok: true, action: "help" });
}
