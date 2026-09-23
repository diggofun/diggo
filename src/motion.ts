/**
 * The player's motion preference.
 *
 * Components use this to skip the decorative animations that accompany a moment in the game (the
 * collect burst, the discovery reveal), so a player who asked their system for less motion still
 * gets the same numbers, just without the movement. It is a client preference and nothing else:
 * the app plays no audio, so this is the only per-browser display choice left to read.
 */
import { useSyncExternalStore } from "react";

const motionQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)")
    : null;

function subscribeMotion(listener: () => void): () => void {
  motionQuery?.addEventListener("change", listener);
  return () => motionQuery?.removeEventListener("change", listener);
}

function motionSnapshot(): boolean {
  return motionQuery?.matches ?? false;
}

/** True when the player asked their system for less motion. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, motionSnapshot, motionSnapshot);
}
