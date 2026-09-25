/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { uploadMedia } from "./tokens";
import type { RuntimeEnv } from "./env";

/**
 * Regression coverage for the "Only images may be uploaded" failure on the Create coin page.
 *
 * The route used to require the *request's* content type to be `image/*`, but the browser client
 * posts a FormData, so the request is `multipart/form-data` and the image type only lives on the
 * file part. Every real pick therefore failed. These tests drive the route the way the browser
 * actually does — a multipart body whose file part may carry an empty or wrong `type` — and assert
 * the format decision is made from magic bytes, not from what the client claimed.
 */
const WALLET = "So11111111111111111111111111111111111111111";

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPEG_MAGIC = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const GIF89_MAGIC = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00]);
const WEBP_MAGIC = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x20,
]);
const SVG_TEXT = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
const PDF_MAGIC = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n");

function padded(magic: Uint8Array, totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(totalBytes);
  bytes.set(magic.subarray(0, Math.min(magic.length, totalBytes)));
  return bytes;
}

interface PutCall {
  key: string;
  value: ArrayBuffer | Uint8Array | string;
  options?: { metadata?: Record<string, unknown>; expirationTtl?: number };
}

function harness() {
  const puts: PutCall[] = [];
  const values = new Map<string, string>();
  const env = {
    TOKEN_CACHE: {
      async get(key: string) { return values.get(key) ?? null; },
      async put(key: string, value: PutCall["value"], options?: PutCall["options"]) {
        // Rate-limit counters share the KV binding; only media objects are interesting here.
        if (key.startsWith("media:")) puts.push({ key, value, options });
        values.set(key, typeof value === "string" ? value : "");
      },
      async delete(key: string) { values.delete(key); },
    },
  } as unknown as RuntimeEnv;
  values.set(`auth:session:session-${WALLET}`, WALLET);
  return { env, puts, values };
}

function mediaRequest(body: BodyInit, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer session-${WALLET}`);
  return new Request("https://diggo.fun/api/media", {
    method: "POST",
    ...init,
    headers,
    body,
  });
}

/** Builds the FormData the browser would send, with the file part's own `type` under our control. */
function browserUpload(bytes: Uint8Array, fileType: string, name = "coin.png"): Request {
  const form = new FormData();
  form.set("file", new File([bytes.slice().buffer as ArrayBuffer], name, { type: fileType }));
  return mediaRequest(form);
}

async function errorOf(response: Response): Promise<{ status: number; message: string }> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return { status: response.status, message: body.error ?? "" };
}

describe("media upload validation", () => {
  it("accepts a real PNG sent as multipart, the way the Create coin page sends it", async () => {
    const { env, puts } = harness();
    const response = await uploadMedia(browserUpload(PNG_MAGIC, "image/png"), env);
    expect(response.status).toBe(200);
    const { imageKey, url } = (await response.json()) as { imageKey: string; url: string };
    expect(url).toBe(`/media/${imageKey}`);
    expect(imageKey).toMatch(/^So111111-[0-9a-f-]{36}\.png$/);
    expect(puts).toHaveLength(1);
    expect(puts[0]!.options?.metadata).toMatchObject({ contentType: "image/png" });
  });

  it.each([
    ["JPEG", JPEG_MAGIC, "image/jpeg", "jpg"],
    ["WebP", WEBP_MAGIC, "image/webp", "webp"],
    ["GIF", GIF89_MAGIC, "image/gif", "gif"],
  ])("accepts a %s and names the stored object by its sniffed type", async (_label, magic, type, extension) => {
    const { env } = harness();
    const response = await uploadMedia(browserUpload(magic as Uint8Array, type as string), env);
    expect(response.status).toBe(200);
    const { imageKey } = (await response.json()) as { imageKey: string };
    expect(imageKey.endsWith(`.${extension}`)).toBe(true);
  });

  it("sniffs the bytes when the browser reports an empty file type", async () => {
    const { env } = harness();
    const response = await uploadMedia(browserUpload(padded(PNG_MAGIC, 64), "", "no-extension"), env);
    expect(response.status).toBe(200);
    const { imageKey } = (await response.json()) as { imageKey: string };
    expect(imageKey.endsWith(".png")).toBe(true);
  });

  it("trusts the bytes over a wrong declared type, storing the real format", async () => {
    const { env, puts } = harness();
    // A JPEG the browser (or an old Safari) mislabels as a TIFF, and a PNG sent as octet-stream.
    for (const [magic, declared] of [[JPEG_MAGIC, "image/tiff"], [PNG_MAGIC, "application/octet-stream"]] as const) {
      const response = await uploadMedia(browserUpload(magic, declared), env);
      expect(response.status).toBe(200);
    }
    const types = puts.map((call) => call.options?.metadata?.contentType);
    expect(types).toEqual(["image/jpeg", "image/png"]);
  });

  it("still rejects a non-image body even when it is labelled image/png", async () => {
    const { env, puts } = harness();
    const response = await uploadMedia(browserUpload(PDF_MAGIC, "image/png", "coin.png"), env);
    expect(await errorOf(response)).toEqual({ status: 400, message: "Only images may be uploaded" });
    expect(puts).toHaveLength(0);
  });

  it("rejects SVG, which would be script running on this origin when served back", async () => {
    const { env, puts } = harness();
    const response = await uploadMedia(browserUpload(SVG_TEXT, "image/svg+xml", "coin.svg"), env);
    expect(response.status).toBe(400);
    expect(puts).toHaveLength(0);
  });

  it("rejects an empty upload", async () => {
    const { env } = harness();
    const response = await uploadMedia(browserUpload(new Uint8Array(), "image/png"), env);
    expect(await errorOf(response)).toEqual({ status: 400, message: "Empty upload" });
  });

  it("rejects an oversized image with 413 and never stores it", async () => {
    const { env, puts } = harness();
    const response = await uploadMedia(browserUpload(padded(PNG_MAGIC, 2_000_001), "image/png"), env);
    expect(await errorOf(response)).toEqual({ status: 413, message: "Image too large (2 MB maximum)" });
    expect(puts).toHaveLength(0);
  });

  it("refuses an oversized body before buffering it", async () => {
    const { env } = harness();
    const declared = new Request("https://diggo.fun/api/media", {
      method: "POST",
      headers: {
        authorization: `Bearer session-${WALLET}`,
        "content-type": "multipart/form-data; boundary=xyz",
        "content-length": String(2_000_001 + 65_536 + 1),
      },
      body: new Uint8Array(8),
    });
    expect(await errorOf(await uploadMedia(declared, env))).toEqual({
      status: 413,
      message: "Image too large (2 MB maximum)",
    });
  });

  it("rejects a non-image request envelope that is not multipart", async () => {
    const { env } = harness();
    const response = await uploadMedia(mediaRequest('{"file":"nope"}', {
      headers: { "content-type": "application/json" },
    }), env);
    expect(await errorOf(response)).toEqual({ status: 400, message: "Only images may be uploaded" });
  });

  it("rejects a multipart body with no file part", async () => {
    const { env } = harness();
    const form = new FormData();
    form.set("description", "just text");
    const response = await uploadMedia(mediaRequest(form), env);
    expect(await errorOf(response)).toEqual({ status: 400, message: "No image was uploaded" });
  });

  it("still requires a wallet session before touching the body", async () => {
    const { env, puts } = harness();
    const anonymous = new Request("https://diggo.fun/api/media", { method: "POST", body: PNG_MAGIC });
    const response = await uploadMedia(anonymous, env);
    expect(await errorOf(response)).toEqual({ status: 401, message: "Wallet session required" });
    expect(puts).toHaveLength(0);
  });

  it("accepts a raw image/* body from a non-browser caller", async () => {
    const { env } = harness();
    const response = await uploadMedia(mediaRequest(PNG_MAGIC, {
      headers: { "content-type": "image/png" },
    }), env);
    expect(response.status).toBe(200);
    const { imageKey } = (await response.json()) as { imageKey: string };
    expect(imageKey.endsWith(".png")).toBe(true);
  });
});
