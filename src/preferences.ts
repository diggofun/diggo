/**
 * Device preferences: the colour theme and the player's own bot. Both live in localStorage only;
 * they change how this browser draws the site, never anything on chain or on the Worker.
 */
import { useSyncExternalStore } from "react";
import {
  BOT_COLORS,
  BOT_EYEWEAR,
  BOT_HATS,
  BOT_SHAPE_NAMES,
  botFor,
  type BotEyewear,
  type BotHat,
  type BotLook,
  type BotShape,
} from "./components/Bot";

export type ThemeMode = "dark" | "light";

const THEME_KEY = "diggo:theme";
const BOT_KEY = "diggo:profile-bot";
const CHANGE_EVENT = "diggo:preferences";

const THEME_COLORS: Record<ThemeMode, string> = { dark: "#141414", light: "#f4f4f5" };

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked storage: the choice still applies until the page reloads.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

export function loadTheme(): ThemeMode {
  return read(THEME_KEY) === "light" ? "light" : "dark";
}

/** Puts the theme on <html> (the CSS keys off data-theme) and on the browser chrome colour. */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  root.style.colorScheme = mode;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLORS[mode]);
}

export function saveTheme(mode: ThemeMode): void {
  applyTheme(mode);
  write(THEME_KEY, mode);
}

export function useTheme(): ThemeMode {
  return useSyncExternalStore(subscribe, loadTheme, () => "dark");
}

/**
 * The single accessory slot: a hat or a piece of eyewear, never both. "none" is the bare head.
 * Values are prefixed so a hat and eyewear can share one list.
 */
export type BotAccessory = "none" | `hat:${Exclude<BotHat, "none">}` | `eyewear:${Exclude<BotEyewear, "none">}`;

export const BOT_ACCESSORIES: readonly BotAccessory[] = [
  "none",
  ...BOT_HATS.filter((hat): hat is Exclude<BotHat, "none"> => hat !== "none").map((hat) => `hat:${hat}` as const),
  ...BOT_EYEWEAR.filter((eyewear): eyewear is Exclude<BotEyewear, "none"> => eyewear !== "none").map((eyewear) => `eyewear:${eyewear}` as const),
];

export function accessoryOf(look: Pick<BotLook, "hat" | "eyewear">): BotAccessory {
  if (look.hat !== "none") return `hat:${look.hat}` as BotAccessory;
  if (look.eyewear !== "none") return `eyewear:${look.eyewear}` as BotAccessory;
  return "none";
}

export function withAccessory(look: BotLook, accessory: BotAccessory): BotLook {
  if (accessory.startsWith("hat:")) return { ...look, hat: accessory.slice(4) as BotHat, eyewear: "none" };
  if (accessory.startsWith("eyewear:")) return { ...look, hat: "none", eyewear: accessory.slice(8) as BotEyewear };
  return { ...look, hat: "none", eyewear: "none" };
}

/** Keeps at most one accessory: a hat wins over eyewear, as it is the more visible of the two. */
export function oneAccessory(look: BotLook): BotLook {
  return withAccessory(look, accessoryOf(look));
}

/** Parses a stored look; anything unknown or malformed yields null, so the default bot shows. */
export function parseBotLook(raw: string | null): BotLook | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof BotLook, unknown>>;
    if (!BOT_SHAPE_NAMES.includes(value.shape as BotShape)) return null;
    if (!(BOT_COLORS as readonly string[]).includes(value.color as string)) return null;
    const hat = BOT_HATS.includes(value.hat as BotHat) ? (value.hat as BotHat) : "none";
    const eyewear = BOT_EYEWEAR.includes(value.eyewear as BotEyewear) ? (value.eyewear as BotEyewear) : "none";
    return oneAccessory({ shape: value.shape as BotShape, color: value.color as string, hat, eyewear });
  } catch {
    return null;
  }
}

function storedBot(): string | null {
  return read(BOT_KEY);
}

/** The look a seed draws by default, already trimmed to one accessory. */
export function defaultBot(seed: string): BotLook {
  return oneAccessory(botFor(seed));
}

export function saveProfileBot(look: BotLook | null): void {
  write(BOT_KEY, look ? JSON.stringify(oneAccessory(look)) : null);
}

/** The player's bot: their saved look, or the stable default for their wallet. */
export function useProfileBot(seed: string): { look: BotLook; custom: boolean } {
  const raw = useSyncExternalStore(subscribe, storedBot, () => null);
  const saved = parseBotLook(raw);
  return saved ? { look: saved, custom: true } : { look: defaultBot(seed), custom: false };
}
