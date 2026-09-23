/**
 * Synthesised sound effects — no audio files, no network, no gameplay input.
 *
 * Every cue is a handful of WebAudio oscillators built on the spot, so the whole soundtrack costs
 * a few hundred bytes instead of a folder of MP3s. Cues are purely decorative: they are chosen by
 * the client from what the server already decided (a discovery's rarity, for example), and nothing
 * here can influence a reward, a roll or a mine's state.
 *
 * Sound is off until the player turns it on with the header's SoundToggle; that choice is stored
 * in localStorage. Reduced-motion preferences are exposed here too, because the animations that
 * accompany a cue (the collect burst, the discovery reveal) are the ones that must be switchable.
 */
import { useCallback, useSyncExternalStore } from "react";
import type { DiscoveryRarity } from "../shared/config";

export type SoundEffect = "activate" | "collect" | "upgrade" | "discovery";

export interface SoundOptions {
  /** A discovery's rarity, as decided by the server, picks the length and brightness of the cue. */
  rarity?: DiscoveryRarity;
}

const SOUND_STORAGE_KEY = "diggo:sound";

interface Tone {
  /** Hz at the start of the tone. */
  freq: number;
  /** Seconds after the cue begins. */
  at: number;
  /** Seconds. */
  dur: number;
  type: OscillatorType;
  gain: number;
  /** Optional Hz to glide to across the tone. */
  glideTo?: number;
}

/** Activate: the shift starts — a low thud under two rising blips. */
const ACTIVATE: readonly Tone[] = [
  { freq: 98, at: 0, dur: 0.26, type: "triangle", gain: 0.3 },
  { freq: 392, at: 0.04, dur: 0.13, type: "square", gain: 0.16 },
  { freq: 587, at: 0.16, dur: 0.2, type: "square", gain: 0.16 },
];

/** Collect: three coins landing in the vault. */
const COLLECT: readonly Tone[] = [
  { freq: 659, at: 0, dur: 0.1, type: "triangle", gain: 0.18 },
  { freq: 880, at: 0.07, dur: 0.1, type: "triangle", gain: 0.17 },
  { freq: 1175, at: 0.14, dur: 0.16, type: "triangle", gain: 0.15 },
];

/** Upgrade: a saw sweeping up, with the octave arriving on top. */
const UPGRADE: readonly Tone[] = [
  { freq: 220, at: 0, dur: 0.3, type: "sawtooth", gain: 0.14, glideTo: 660 },
  { freq: 660, at: 0.16, dur: 0.22, type: "triangle", gain: 0.16 },
  { freq: 990, at: 0.22, dur: 0.24, type: "triangle", gain: 0.11 },
];

/** Rarity decides how far up the ladder the reveal climbs, and how long it rings. */
const DISCOVERY_LADDER: readonly number[] = [392, 494, 587, 698, 880, 1046];
const DISCOVERY_RARITIES: readonly DiscoveryRarity[] = [
  "common", "uncommon", "rare", "epic", "legendary", "mythic",
];
const DISCOVERY_STEPS: Readonly<Record<DiscoveryRarity, number>> = {
  common: 2,
  uncommon: 3,
  rare: 4,
  epic: 5,
  legendary: 6,
  mythic: 6,
};

/**
 * Narrows the rarity string the API hands back to a known rarity, so an unknown or future value
 * simply plays the common cue instead of breaking the type.
 */
export function discoveryRarityOf(value: string | null | undefined): DiscoveryRarity | undefined {
  return DISCOVERY_RARITIES.find((rarity) => rarity === value);
}

function discoveryCue(rarity: DiscoveryRarity): Tone[] {
  const steps = DISCOVERY_STEPS[rarity] ?? 2;
  const notes = DISCOVERY_LADDER.slice(0, steps);
  const cue: Tone[] = notes.map((freq, index) => ({
    freq,
    at: index * 0.085,
    dur: index === notes.length - 1 ? 0.4 : 0.14,
    type: index === notes.length - 1 ? "triangle" : "square",
    gain: 0.14 + index * 0.012,
  }));
  // A shimmer on top only for the rarities worth showing off.
  if (rarity === "legendary" || rarity === "mythic") {
    cue.push({ freq: 1568, at: notes.length * 0.085, dur: 0.5, type: "triangle", gain: 0.1 });
  }
  return cue;
}

function cueFor(effect: SoundEffect, options: SoundOptions): readonly Tone[] {
  if (effect === "activate") return ACTIVATE;
  if (effect === "collect") return COLLECT;
  if (effect === "upgrade") return UPGRADE;
  return discoveryCue(options.rarity ?? "common");
}

let audio: AudioContext | null = null;

/**
 * The context is created lazily, inside a player gesture (the toggle, or the click that leads to
 * the cue), which is what browser autoplay policies require.
 */
function audioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audio) {
    const Ctor = window.AudioContext;
    if (!Ctor) return null;
    try {
      audio = new Ctor();
    } catch {
      return null;
    }
  }
  if (audio.state === "suspended") void audio.resume();
  return audio;
}

function emit(context: AudioContext, cue: readonly Tone[]): void {
  const start = context.currentTime + 0.01;
  const master = context.createGain();
  // A ceiling rather than a volume control: cues overlap with each other and with the modal.
  master.gain.value = 0.45;
  master.connect(context.destination);
  for (const tone of cue) {
    const from = start + tone.at;
    const to = from + tone.dur;
    const oscillator = context.createOscillator();
    const envelope = context.createGain();
    oscillator.type = tone.type;
    oscillator.frequency.setValueAtTime(tone.freq, from);
    if (tone.glideTo) oscillator.frequency.exponentialRampToValueAtTime(tone.glideTo, to);
    // Percussive envelope: near-instant attack, exponential decay (never reaching zero).
    envelope.gain.setValueAtTime(0.0001, from);
    envelope.gain.exponentialRampToValueAtTime(tone.gain, from + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.0001, to);
    oscillator.connect(envelope).connect(master);
    oscillator.start(from);
    oscillator.stop(to + 0.02);
  }
}

let soundEnabled = readStoredPreference();
const soundListeners = new Set<() => void>();

/** True only when the player has explicitly switched sound on; the default is muted. */
export function isSoundEnabled(): boolean {
  return soundEnabled;
}

export function subscribeSound(listener: () => void): () => void {
  soundListeners.add(listener);
  return () => {
    soundListeners.delete(listener);
  };
}

/** Persists the choice and, when switching on, plays a short confirmation in the same gesture. */
export function setSoundEnabled(next: boolean): void {
  if (next === soundEnabled) return;
  soundEnabled = next;
  writeStoredPreference(next);
  if (next) playSound("collect");
  for (const listener of soundListeners) listener();
}

function readStoredPreference(): boolean {
  try {
    return localStorage.getItem(SOUND_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeStoredPreference(next: boolean): void {
  try {
    localStorage.setItem(SOUND_STORAGE_KEY, next ? "on" : "off");
  } catch {
    // Storage blocked: the choice still holds for this page.
  }
}

/** Plays one cue. Silently does nothing while muted, or on a browser without WebAudio. */
export function playSound(effect: SoundEffect, options: SoundOptions = {}): void {
  if (!soundEnabled) return;
  const context = audioContext();
  if (!context) return;
  try {
    emit(context, cueFor(effect, options));
  } catch {
    // A browser refusing to start audio must never break the interaction that triggered it.
  }
}

/** React binding for the mute state, used by the header's SoundToggle. */
export function useSoundEnabled(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribeSound, isSoundEnabled, isSoundEnabled);
  const toggle = useCallback((next: boolean) => setSoundEnabled(next), []);
  return [enabled, toggle];
}

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

/**
 * True when the player asked their system for less motion. Components use it to skip the
 * decorative animations that accompany a cue (bursts, stamps, reveals) rather than the cue itself.
 */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, motionSnapshot, motionSnapshot);
}
