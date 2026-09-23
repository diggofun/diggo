/**
 * Web Push tests (worker/push.ts).
 *
 * Two things are worth pinning beyond "it compiles". First, the encryption is real: the test
 * decrypts what the Worker produced using only the device's private key and the header the message
 * carries, which is what a browser does, so a mistake in the RFC 8291 key schedule cannot pass
 * unnoticed. Second, a device is only ever registered and paid once: the UNIQUE endpoint and the
 * at-most-once delivery ledger are what stop one alert arriving twice, and both are exercised
 * against the real migrations through the SQLite-backed D1 double (./d1-sqlite).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../env";
import {
  activeSubscriptions,
  base64UrlToBytes,
  bytesToBase64Url,
  deletePushSubscription,
  deliverNotifications,
  encryptWebPushPayload,
  notificationMessage,
  pushPublicKey,
  registerPushSubscription,
  startTelegramLink,
  telegramWebhook,
  vapidAuthorizationHeader,
  type Bytes,
  type VapidConfig,
} from "../push";
import {
  countRows,
  createSession,
  createTestHarness,
  seedPlayer,
  sessionRequest,
  type TestHarness,
} from "./d1-sqlite";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const PUSH_ENDPOINT = "https://fcm.googleapis.com/fcm/send/device-1";

interface DeviceKeys {
  readonly p256dh: string;
  readonly auth: string;
  readonly privateKey: CryptoKey;
  readonly publicKey: Bytes;
}

function concat(...parts: readonly Bytes[]): Bytes {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function deviceKeys(): Promise<DeviceKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  return {
    p256dh: bytesToBase64Url(publicKey),
    auth: bytesToBase64Url(crypto.getRandomValues(new Uint8Array(16))),
    privateKey: pair.privateKey,
    publicKey,
  };
}

async function vapidKeys(): Promise<VapidConfig> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return {
    publicKey: bytesToBase64Url(publicKey),
    privateKey: jwk.d as string,
    subject: "mailto:ops@diggo.fun",
  };
}

async function hkdf(ikm: Bytes, salt: Bytes, info: Bytes, bits: number): Promise<Bytes> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, bits));
}

/** The receiving half of RFC 8291: everything below is read out of the message itself. */
async function openMessage(body: Bytes, device: DeviceKeys) {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0, false);
  const keyIdLength = body[20];
  const keyId = body.slice(21, 21 + keyIdLength);
  const ciphertext = body.slice(21 + keyIdLength);
  const senderKey = await crypto.subtle.importKey("raw", keyId, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: senderKey }, device.privateKey, 256),
  );
  const prk = await hkdf(
    shared,
    base64UrlToBytes(device.auth),
    concat(ENCODER.encode("WebPush: info"), new Uint8Array([0]), device.publicKey, keyId),
    256,
  );
  const cek = await hkdf(prk, salt, concat(ENCODER.encode("Content-Encoding: aes128gcm"), new Uint8Array([0])), 128);
  const nonce = await hkdf(prk, salt, concat(ENCODER.encode("Content-Encoding: nonce"), new Uint8Array([0])), 96);
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const plaintext = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  );
  return { recordSize, keyId, plaintext };
}

function withVapid(harness: TestHarness, config: VapidConfig): RuntimeEnv {
  return {
    ...harness.env,
    VAPID_PUBLIC_KEY: config.publicKey,
    VAPID_PRIVATE_KEY: config.privateKey,
    VAPID_SUBJECT: config.subject,
  } as unknown as RuntimeEnv;
}

function subscribeRequest(endpoint: string, device: DeviceKeys, session: string): Request {
  return sessionRequest("https://diggo.fun/api/push/subscription", session, {
    method: "POST",
    body: { endpoint, keys: { p256dh: device.p256dh, auth: device.auth }, userAgent: "vitest/1.0" },
  });
}

describe("encryptWebPushPayload", () => {
  it("seals a payload only the target device can open", async () => {
    const device = await deviceKeys();
    const payload = ENCODER.encode(JSON.stringify({ title: "Diggo.fun", body: "Window closing" }));

    const encrypted = await encryptWebPushPayload(payload, device.p256dh, device.auth);
    const opened = await openMessage(encrypted.body, device);

    // RFC 8188 header: salt, record size, then one key id of 65 bytes - the sender's public key.
    expect(encrypted.body.length).toBe(16 + 4 + 1 + 65 + payload.length + 1 + 16);
    expect(opened.recordSize).toBe(4_096);
    expect(opened.keyId.length).toBe(65);
    expect(bytesToBase64Url(opened.keyId)).toBe(bytesToBase64Url(encrypted.localPublicKey));
    // The last record carries the 0x02 padding delimiter, which the receiver strips.
    expect(opened.plaintext[opened.plaintext.length - 1]).toBe(2);
    expect(DECODER.decode(opened.plaintext.slice(0, -1))).toBe(DECODER.decode(payload));
  });

  it("uses a fresh salt and ephemeral key for every message", async () => {
    const device = await deviceKeys();
    const payload = ENCODER.encode("same message");

    const first = await encryptWebPushPayload(payload, device.p256dh, device.auth);
    const second = await encryptWebPushPayload(payload, device.p256dh, device.auth);

    expect(bytesToBase64Url(first.salt)).not.toBe(bytesToBase64Url(second.salt));
    expect(bytesToBase64Url(first.localPublicKey)).not.toBe(bytesToBase64Url(second.localPublicKey));
    expect(bytesToBase64Url(first.body)).not.toBe(bytesToBase64Url(second.body));
  });

  it("refuses keys and payloads it cannot encode", async () => {
    const device = await deviceKeys();

    await expect(encryptWebPushPayload(ENCODER.encode("x"), device.p256dh, "AAAA")).rejects.toThrow(
      "Invalid auth secret",
    );
    await expect(
      encryptWebPushPayload(ENCODER.encode("x"), bytesToBase64Url(new Uint8Array(65)), device.auth),
    ).rejects.toThrow("Invalid device public key");
    await expect(encryptWebPushPayload(new Uint8Array(5_000), device.p256dh, device.auth)).rejects.toThrow(
      "Push payload too large",
    );
    await expect(encryptWebPushPayload(new Uint8Array(0), device.p256dh, device.auth)).rejects.toThrow(
      "Empty push payload",
    );
  });
});

describe("vapidAuthorizationHeader", () => {
  it("signs an ES256 token the push service can verify", async () => {
    const config = await vapidKeys();
    const now = Date.UTC(2026, 8, 22, 12, 0, 0);

    const header = await vapidAuthorizationHeader(config, "https://push.example", now);
    const parts = header.split(", k=");
    expect(parts.length).toBe(2);
    expect(parts[0].startsWith("vapid t=")).toBe(true);
    expect(parts[1]).toBe(config.publicKey);

    const segments = parts[0].slice("vapid t=".length).split(".");
    expect(segments.length).toBe(3);
    expect(JSON.parse(DECODER.decode(base64UrlToBytes(segments[0])))).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(DECODER.decode(base64UrlToBytes(segments[1])))).toEqual({
      aud: "https://push.example",
      exp: Math.floor(now / 1_000) + 12 * 3_600,
      sub: "mailto:ops@diggo.fun",
    });

    const publicBytes = base64UrlToBytes(config.publicKey);
    const jwk: JsonWebKey = {
      kty: "EC",
      crv: "P-256",
      x: bytesToBase64Url(publicBytes.slice(1, 33)),
      y: bytesToBase64Url(publicBytes.slice(33, 65)),
      ext: true,
    };
    const verifyKey = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, [
      "verify",
    ]);
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      verifyKey,
      base64UrlToBytes(segments[2]),
      ENCODER.encode(segments[0] + "." + segments[1]),
    );
    expect(verified).toBe(true);
  });
});

describe("notificationMessage", () => {
  it("routes each stored notification to the screen it belongs to", () => {
    const expiring = notificationMessage("MINE_EXPIRES_3H", { expiresInSeconds: 7_200 });
    expect(expiring).toMatchObject({ url: "/mine", tag: "mine_expires_3h" });
    expect(expiring.body).toContain("2 hours");

    expect(notificationMessage("RARE_DISCOVERY_FOUND", { rarity: "epic" })).toMatchObject({ url: "/discoveries" });
    expect(notificationMessage("RARE_DISCOVERY_FOUND", { rarity: "epic" }).body).toContain("epic");

    expect(notificationMessage("TOKEN_ALMOST_FULLY_MINED", { mint: "mint-1", symbol: "DIG" }).url).toBe(
      "/mines?mint=mint-1",
    );
    expect(notificationMessage("REWARD_REDUCTION_APPROACHING", { symbol: "DIG" }).body).toContain("DIG's");

    // An unknown kind still produces a usable alert rather than an empty one.
    expect(notificationMessage("SOMETHING_NEW", null)).toMatchObject({ title: "Diggo.fun", url: "/mine" });
  });
});

describe("push subscriptions", () => {
  it("keeps one row per device and never lets another wallet take it over", async () => {
    const harness = createTestHarness();
    const alice = await createSession(harness, "alice", "session-alice");
    const bob = await createSession(harness, "bob", "session-bob");
    const device = await deviceKeys();

    const first = await registerPushSubscription(subscribeRequest(PUSH_ENDPOINT, device, alice), harness.env);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, subscriptions: 1 });
    expect(countRows(harness.db, "push_subscriptions")).toBe(1);

    // The same browser re-registers with rotated keys: still one row, updated in place.
    const rotated = await deviceKeys();
    await registerPushSubscription(subscribeRequest(PUSH_ENDPOINT, rotated, alice), harness.env);
    expect(countRows(harness.db, "push_subscriptions")).toBe(1);
    const row = harness.db.prepare("SELECT wallet, p256dh FROM push_subscriptions").get() as {
      wallet: string;
      p256dh: string;
    };
    expect(row.p256dh).toBe(rotated.p256dh);

    // A second wallet on the same browser cannot re-point that device at itself: the registration is
    // refused and the row keeps both its owner and the keys the real device rotates (spec 65).
    const takeover = await registerPushSubscription(subscribeRequest(PUSH_ENDPOINT, rotated, bob), harness.env);
    expect(takeover.status).toBe(409);
    expect(countRows(harness.db, "push_subscriptions")).toBe(1);
    const still = harness.db.prepare("SELECT wallet, p256dh FROM push_subscriptions").get() as {
      wallet: string;
      p256dh: string;
    };
    expect(still.wallet).toBe("alice");
    expect(still.p256dh).toBe(rotated.p256dh);

    // A genuinely different device is a different row, owned by whoever registered it.
    await registerPushSubscription(
      subscribeRequest("https://fcm.googleapis.com/fcm/send/device-2", rotated, bob),
      harness.env,
    );
    expect(countRows(harness.db, "push_subscriptions")).toBe(2);
    expect(await activeSubscriptions(harness.env, "bob")).toHaveLength(1);
    expect(await activeSubscriptions(harness.env, "alice")).toHaveLength(1);
  });

  it("refuses malformed subscriptions and anonymous callers", async () => {
    const harness = createTestHarness();
    const session = await createSession(harness, "alice", "session-alice");
    const device = await deviceKeys();

    const insecure = await registerPushSubscription(
      subscribeRequest("http://push.example/x", device, session),
      harness.env,
    );
    expect(insecure.status).toBe(400);

    const shortKey = await registerPushSubscription(
      sessionRequest("https://diggo.fun/api/push/subscription", session, {
        method: "POST",
        body: { endpoint: PUSH_ENDPOINT, keys: { p256dh: bytesToBase64Url(new Uint8Array(10)), auth: device.auth } },
      }),
      harness.env,
    );
    expect(shortKey.status).toBe(400);

    const anonymous = await registerPushSubscription(
      new Request("https://diggo.fun/api/push/subscription", { method: "POST", body: "{}" }),
      harness.env,
    );
    expect(anonymous.status).toBe(401);
    expect(countRows(harness.db, "push_subscriptions")).toBe(0);
  });

  it("removes exactly the device that unsubscribes", async () => {
    const harness = createTestHarness();
    const session = await createSession(harness, "alice", "session-alice");
    const device = await deviceKeys();
    await registerPushSubscription(subscribeRequest(PUSH_ENDPOINT, device, session), harness.env);
    await registerPushSubscription(
      subscribeRequest("https://fcm.googleapis.com/fcm/send/device-2", device, session),
      harness.env,
    );

    const removed = await deletePushSubscription(
      sessionRequest("https://diggo.fun/api/push/subscription", session, {
        method: "DELETE",
        body: { endpoint: PUSH_ENDPOINT },
      }),
      harness.env,
    );
    expect(await removed.json()).toMatchObject({ removed: 1 });
    expect(countRows(harness.db, "push_subscriptions")).toBe(1);

    const all = await deletePushSubscription(
      sessionRequest("https://diggo.fun/api/push/subscription", session, { method: "DELETE" }),
      harness.env,
    );
    expect(await all.json()).toMatchObject({ removed: 1 });
    expect(countRows(harness.db, "push_subscriptions")).toBe(0);
  });

  it("accepts a subscription only for a real Web Push service", async () => {
    const harness = createTestHarness();
    const session = await createSession(harness, "alice", "session-alice");
    const device = await deviceKeys();

    // Every service a browser can subscribe through, including the sharded ones.
    const allowed = [
      "https://fcm.googleapis.com/fcm/send/device-1",
      "https://updates.push.services.mozilla.com/wpush/v2/device-1",
      "https://eu-central-1.push.services.mozilla.com/wpush/v2/device-1",
      "https://wns2-par02p.notify.windows.com/w/?token=device-1",
      "https://web.push.apple.com/Qs7device-1",
      "https://api.push.apple.com/3/device/device-1",
    ];
    for (const endpoint of allowed) {
      const response = await registerPushSubscription(subscribeRequest(endpoint, device, session), harness.env);
      expect(response.status, endpoint).toBe(200);
    }
    expect(countRows(harness.db, "push_subscriptions")).toBe(allowed.length);

    // Nothing else is: the endpoint becomes a fetch target, so an arbitrary https host is an SSRF
    // primitive, and a bare IP or an unusual port is exactly how one is smuggled in.
    const refused = [
      "https://attacker.example/collect",
      "https://fcm.googleapis.com.attacker.example/collect",
      "https://127.0.0.1/collect",
      "https://2130706433/collect",
      "https://[::1]/collect",
      "https://169.254.169.254/latest/meta-data/",
      "https://fcm.googleapis.com:8443/fcm/send/device-1",
      "https://user:secret@fcm.googleapis.com/fcm/send/device-1",
      "http://fcm.googleapis.com/fcm/send/device-1",
    ];
    for (const endpoint of refused) {
      const response = await registerPushSubscription(subscribeRequest(endpoint, device, session), harness.env);
      expect(response.status, endpoint).toBe(400);
    }
    expect(countRows(harness.db, "push_subscriptions")).toBe(allowed.length);
  });

  it("reports whether alerts are configured, without a session", async () => {
    const harness = createTestHarness();
    const off = await pushPublicKey(new Request("https://diggo.fun/api/push/key"), harness.env);
    expect(await off.json()).toEqual({ enabled: false, publicKey: null });

    const config = await vapidKeys();
    const on = await pushPublicKey(new Request("https://diggo.fun/api/push/key"), withVapid(harness, config));
    expect(await on.json()).toEqual({ enabled: true, publicKey: config.publicKey });
  });
});

describe("deliverNotifications", () => {
  async function subscribedHarness() {
    const harness = createTestHarness();
    // notifications.wallet references players.wallet, and the harness runs with foreign keys on.
    seedPlayer(harness.db, { wallet: "alice" });
    const config = await vapidKeys();
    const env = withVapid(harness, config);
    const session = await createSession(harness, "alice", "session-alice");
    const device = await deviceKeys();
    await registerPushSubscription(subscribeRequest(PUSH_ENDPOINT, device, session), env);
    return { harness, env, device };
  }

  function storeNotification(harness: TestHarness, kind: string, payload: unknown, dedupeKey: string): number {
    harness.db
      .prepare(
        "INSERT INTO notifications (wallet, kind, payload, dedupe_key, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
      )
      .run("alice", kind, JSON.stringify(payload), dedupeKey, 1_800_000_000);
    return Number((harness.db.prepare("SELECT id FROM notifications").get() as { id: number }).id);
  }

  it("delivers one alert to a device exactly once", async () => {
    const { harness, env } = await subscribedHarness();
    const sent: { url: string; headers: Headers; body: Uint8Array }[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body as Uint8Array });
      return new Response(null, { status: 201 });
    });
    const id = storeNotification(harness, "MINE_EXPIRES_3H", { expiresInSeconds: 3_600 }, "MINE_EXPIRES_3H:1");
    const notification = { id, kind: "MINE_EXPIRES_3H", payload: { expiresInSeconds: 3_600 } };

    const first = await deliverNotifications(env, "alice", [notification], 1_800_000_000);
    expect(first).toMatchObject({ attempted: 1, delivered: 1, skipped: 0, failed: 0 });
    expect(sent.length).toBe(1);
    expect(sent[0].url).toBe(PUSH_ENDPOINT);
    expect(sent[0].headers.get("content-encoding")).toBe("aes128gcm");
    expect(sent[0].headers.get("topic")).toBe("mine_expires_3h");
    expect(sent[0].headers.get("authorization")?.startsWith("vapid t=")).toBe(true);
    expect(sent[0].body.length).toBeGreaterThan(86);
    expect(countRows(harness.db, "push_deliveries")).toBe(1);

    // The same notification again, as a page load or a cron retry would: the ledger claim fails.
    const second = await deliverNotifications(env, "alice", [notification], 1_800_000_001);
    expect(second).toMatchObject({ attempted: 0, delivered: 0, skipped: 1 });
    expect(sent.length).toBe(1);
  });

  it("disables a device the push service says is finished", async () => {
    const { harness, env } = await subscribedHarness();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 410 }));
    const id = storeNotification(harness, "MINE_EXPIRED", {}, "MINE_EXPIRED:1");

    const summary = await deliverNotifications(env, "alice", [{ id, kind: "MINE_EXPIRED", payload: {} }], 1_800_000_000);

    expect(summary).toMatchObject({ attempted: 1, delivered: 0, finished: 1 });
    expect(await activeSubscriptions(env, "alice")).toHaveLength(0);
    const row = harness.db.prepare("SELECT disabled_at FROM push_subscriptions").get() as { disabled_at: unknown };
    expect(row.disabled_at).not.toBeNull();
  });

  it("counts a transient failure against the device without disabling it", async () => {
    const { harness, env } = await subscribedHarness();
    vi.stubGlobal("fetch", async () => new Response(null, { status: 500 }));
    const id = storeNotification(harness, "STREAK_AT_RISK", { streak: 4 }, "STREAK_AT_RISK:1");

    const summary = await deliverNotifications(env, "alice", [{ id, kind: "STREAK_AT_RISK", payload: {} }], 1_800_000_000);

    expect(summary).toMatchObject({ attempted: 1, delivered: 0, failed: 1 });
    const row = harness.db.prepare("SELECT failure_count, disabled_at FROM push_subscriptions").get() as {
      failure_count: number;
      disabled_at: unknown;
    };
    expect(Number(row.failure_count)).toBe(1);
    expect(row.disabled_at).toBeNull();
    expect(await activeSubscriptions(env, "alice")).toHaveLength(1);
  });

  it("does nothing at all when no channel is configured", async () => {
    const harness = createTestHarness();
    seedPlayer(harness.db, { wallet: "alice" });
    const session = await createSession(harness, "alice", "session-alice");
    const device = await deviceKeys();
    await registerPushSubscription(subscribeRequest(PUSH_ENDPOINT, device, session), harness.env);
    const push = vi.fn();
    vi.stubGlobal("fetch", push);
    const id = storeNotification(harness, "MINE_EXPIRED", {}, "MINE_EXPIRED:1");

    const summary = await deliverNotifications(
      harness.env,
      "alice",
      [{ id, kind: "MINE_EXPIRED", payload: {} }],
      1_800_000_000,
    );

    expect(summary).toMatchObject({ attempted: 0, delivered: 0 });
    expect(push).not.toHaveBeenCalled();
  });

  it("retires a stored endpoint outside the allowlist instead of calling it", async () => {
    const { harness, env } = await subscribedHarness();
    // A row written before the allowlist existed, or by an older deploy, is still untrusted input:
    // the send path re-checks it rather than trusting what storage holds.
    harness.db
      .prepare("UPDATE push_subscriptions SET endpoint = ?1 WHERE wallet = 'alice'")
      .run("https://attacker.example/collect");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const id = storeNotification(harness, "MINE_EXPIRED", {}, "MINE_EXPIRED:refused");

    const summary = await deliverNotifications(
      env,
      "alice",
      [{ id, kind: "MINE_EXPIRED", payload: {} }],
      1_800_000_000,
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    // Reported as finished, so the row is retired rather than retried forever on every sweep.
    expect(summary).toMatchObject({ attempted: 1, delivered: 0, failed: 0, finished: 1 });
    expect(await activeSubscriptions(env, "alice")).toHaveLength(0);
  });
});

describe("Telegram link flow", () => {
  function telegramEnv(harness: TestHarness): RuntimeEnv {
    return {
      ...harness.env,
      TELEGRAM_BOT_TOKEN: "123456:AAbbCCddEEffGGhh",
      TELEGRAM_BOT_USERNAME: "diggo_test_bot",
      TELEGRAM_WEBHOOK_SECRET: "hook-secret",
    } as unknown as RuntimeEnv;
  }

  function update(text: string, secret = "hook-secret"): Request {
    return new Request("https://diggo.fun/webhooks/telegram", {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
      body: JSON.stringify({ update_id: 1, message: { message_id: 1, chat: { id: 555 }, text } }),
    });
  }

  it("links a chat with a single-use code, then unlinks on /stop", async () => {
    const harness = createTestHarness();
    const env = telegramEnv(harness);
    const session = await createSession(harness, "alice", "session-alice");
    const replies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string | URL | Request, init?: RequestInit) => {
      replies.push(String(init?.body ?? ""));
      return new Response(JSON.stringify({ ok: true, result: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const link = await startTelegramLink(
      sessionRequest("https://diggo.fun/api/telegram/link", session, { method: "POST" }),
      env,
    );
    expect(link.status).toBe(200);
    const payload = (await link.json()) as { code: string; url: string };
    expect(payload.code.length).toBe(10);
    expect(payload.url).toBe("https://t.me/diggo_test_bot?start=" + payload.code);
    // The code is stored only as a hash, so reading the database does not hand out a live code.
    const stored = harness.db.prepare("SELECT code_hash FROM telegram_link_codes").get() as { code_hash: string };
    expect(stored.code_hash).not.toBe(payload.code);

    expect((await telegramWebhook(update("/start " + payload.code), env)).status).toBe(200);
    const linked = harness.db.prepare("SELECT chat_id FROM telegram_links WHERE wallet = 'alice'").get() as {
      chat_id: string;
    };
    expect(linked.chat_id).toBe("555");
    expect(countRows(harness.db, "telegram_links")).toBe(1);

    // The same code cannot be used a second time.
    const replay = await telegramWebhook(update("/start " + payload.code), env);
    expect(await replay.json()).toMatchObject({ action: "rejected" });
    expect(countRows(harness.db, "telegram_links")).toBe(1);

    expect(await (await telegramWebhook(update("/stop"), env)).json()).toMatchObject({ action: "unlinked" });
    expect(countRows(harness.db, "telegram_links")).toBe(0);
    expect(replies.length).toBeGreaterThan(1);
  });

  it("fails closed when the webhook secret is absent or wrong", async () => {
    const harness = createTestHarness();
    const env = telegramEnv(harness);
    const wrong = await telegramWebhook(update("/start ABCDEFGHIJ", "not-the-secret"), env);
    expect(wrong.status).toBe(401);

    const unconfigured = await telegramWebhook(update("/start ABCDEFGHIJ"), harness.env);
    expect(unconfigured.status).toBe(404);
    expect(countRows(harness.db, "telegram_links")).toBe(0);
  });
});
