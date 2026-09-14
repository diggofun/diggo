import type { IndexingEvent } from "./types";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.toUpperCase().replace(/[^A-Z0-9_]/g, "_").slice(0, 64);
  return normalized || fallback;
}

function firstMint(payload: Record<string, unknown>): string {
  if (typeof payload.mint === "string" && BASE58_ADDRESS.test(payload.mint)) return payload.mint;
  if (!Array.isArray(payload.tokenTransfers)) return "unknown";
  for (const transfer of payload.tokenTransfers) {
    const item = record(transfer);
    if (item && typeof item.mint === "string" && BASE58_ADDRESS.test(item.mint)) return item.mint;
  }
  return "unknown";
}

export function normalizeHeliusEvent(value: unknown): Extract<IndexingEvent, { type: "helius" }> | null {
  const payload = record(value);
  if (!payload || typeof payload.signature !== "string" || !BASE58_SIGNATURE.test(payload.signature)) {
    return null;
  }
  return {
    type: "helius",
    signature: payload.signature,
    mint: firstMint(payload),
    eventType: safeLabel(payload.type, "UNKNOWN"),
    source: safeLabel(payload.source, "UNKNOWN"),
    slot: typeof payload.slot === "number" && Number.isSafeInteger(payload.slot) ? payload.slot : null,
    timestamp:
      typeof payload.timestamp === "number" && Number.isSafeInteger(payload.timestamp)
        ? payload.timestamp
        : null,
    payload,
  };
}
