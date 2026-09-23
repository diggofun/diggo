import { DIGGO_CONFIG, type DiggoConfig, type DiscoveryRarity } from "./config";

/**
 * Visual discovery events (spec 28).
 *
 * These are animation / mining-report events, not clicker gameplay: the server decides which
 * one the player sees, and the mapping is a pure function of the rarity the server rolled. The
 * UI must never derive it from a client-side roll, for the same reason it never derives the
 * rarity itself (spec 55).
 *
 * The client renders the event; it does not choose it.
 */
export const DISCOVERY_VISUAL_EVENTS = [
  "Stone",
  "Meme Vein",
  "Crystal Vein",
  "Ancient Geode",
  "Golden Block",
  "Degen Core",
] as const;

export type DiscoveryVisualEvent = (typeof DISCOVERY_VISUAL_EVENTS)[number];

/**
 * Rarity -> visual event. Ordered from the cheapest to the richest rarity, matching
 * DIGGO_CONFIG.rarity.tiers, so adding a configured rarity only needs one entry here.
 */
export const DISCOVERY_VISUAL_BY_RARITY: Readonly<Record<DiscoveryRarity, DiscoveryVisualEvent>> =
  Object.freeze({
    common: "Stone",
    uncommon: "Meme Vein",
    rare: "Crystal Vein",
    epic: "Ancient Geode",
    legendary: "Golden Block",
    mythic: "Degen Core",
  });

/**
 * Resolves the visual event for a rarity. Unknown or legacy rarity strings degrade to the
 * cheapest event instead of throwing, because this runs on the read path for historic rows.
 */
export function discoveryVisualEvent(rarity: string): DiscoveryVisualEvent {
  const mapped = DISCOVERY_VISUAL_BY_RARITY[rarity as DiscoveryRarity];
  if (mapped) return mapped;
  return DISCOVERY_VISUAL_BY_RARITY[DIGGO_CONFIG.rarity.tiers[0].rarity];
}

/** True when the rarity is one the current configuration can actually roll. */
export function isConfiguredRarity(rarity: string, config: DiggoConfig = DIGGO_CONFIG): boolean {
  return config.rarity.tiers.some((tier) => tier.rarity === rarity);
}
