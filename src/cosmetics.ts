/**
 * The player's equipped cosmetics, shared by every screen that draws the mine.
 *
 * Cosmetics are visual only, but they are drawn in three places: the cosmetics page, the mining
 * dashboard and the crew board. Each of those could fetch /api/cosmetics for itself, which would
 * put the same request on the dashboard's critical path and let the screens disagree about the
 * look after an equip. This module keeps one map instead: src/components/CosmeticsScreen.tsx
 * publishes what the server returned, the mine scenes read it through useEquippedCosmetics(), and
 * the dashboard's single load is de-duplicated across every caller.
 *
 * Nothing here decides what is equipped — that is the Worker's answer — and an empty map simply
 * means "not loaded yet", which MineScene already treats as the default look.
 */
import { useSyncExternalStore } from "react";
import { getCosmetics } from "./api";

const EMPTY: Readonly<Record<string, string>> = Object.freeze({});

let equipped: Readonly<Record<string, string>> = EMPTY;
const listeners = new Set<() => void>();

function publish(next: Readonly<Record<string, string>>): void {
  equipped = next;
  for (const listener of listeners) listener();
}

/** Snapshot for useSyncExternalStore: the same object until the equipped map genuinely changes. */
export function equippedCosmetics(): Readonly<Record<string, string>> {
  return equipped;
}

/** The equipped map as it currently stands; a stable empty map until something loads it. */
export function useEquippedCosmetics(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    equippedCosmetics,
    equippedCosmetics,
  );
}

/** Called by the cosmetics screen with the server's own map, after a load, equip or unequip. */
export function setEquippedCosmetics(next: Record<string, string>): void {
  publish(next);
}

/** A signed-out player has no loadout, so the dashboard draws the default look again. */
export function clearEquippedCosmetics(): void {
  if (equipped !== EMPTY) publish(EMPTY);
}

let loadRequest: Promise<void> | null = null;

/**
 * Loads the equipped map once per page. A failure is not worth surfacing on the dashboard: the
 * mine simply keeps its default look, and the cosmetics page reports the error itself.
 */
export function loadEquippedCosmetics(): Promise<void> {
  loadRequest ??= getCosmetics()
    .then((view) => {
      publish(view.equipped);
    })
    .catch(() => {
      // Allow a later call (a sign-in, or a page revisit) to try again.
      loadRequest = null;
    });
  return loadRequest;
}
