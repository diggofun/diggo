/**
 * Preferences: the colour theme (this device, localStorage) and the player's profile bot (saved
 * on the Worker next to the username, so it follows the wallet and shows on the leaderboards).
 */
import { useSyncExternalStore } from "react";
import { botFor, type BotEyewear, type BotHat, type BotLook } from "./components/Bot";
import { BOT_ACCESSORIES, type BotAccessory, type BotColor, type ProfileBot } from "../shared/profileBot";
import { setProfileBot } from "./api";
import { rememberProfileBot, useProfileBotOf } from "./username";

export { BOT_ACCESSORIES, type BotAccessory };

export type ThemeMode = "dark" | "light";

const THEME_KEY = "diggo:theme";
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

/** The look a stored profile bot draws. */
export function lookOf(bot: ProfileBot): BotLook {
  return withAccessory({ shape: bot.shape, color: bot.color, hat: "none", eyewear: "none" }, bot.accessory);
}

/** The profile bot a look stores. */
export function profileBotOf(look: BotLook): ProfileBot {
  return { shape: look.shape, color: look.color as BotColor, accessory: accessoryOf(look) };
}

/** The look a seed draws by default, already trimmed to one accessory. */
export function defaultBot(seed: string): BotLook {
  return oneAccessory(botFor(seed));
}

/**
 * A player's bot: their saved look, or the stable default for their wallet. Pass null for nobody
 * (a guest), which draws the default guest bot and asks the server for nothing.
 */
export function useProfileBot(wallet: string | null): { look: BotLook; custom: boolean; known: boolean } {
  const { bot, known } = useProfileBotOf(wallet);
  return bot ? { look: lookOf(bot), custom: true, known } : { look: defaultBot(wallet ?? "guest"), custom: false, known };
}

/**
 * Saves the signed-in player's bot (null: back to the default). The store updates first, so every
 * bot on the page changes at once; a refused save puts the previous one back and rethrows.
 */
export async function saveProfileBot(wallet: string, look: BotLook | null, previous: ProfileBot | null): Promise<void> {
  const next = look ? profileBotOf(look) : null;
  rememberProfileBot(wallet, next);
  try {
    const saved = await setProfileBot(next);
    rememberProfileBot(wallet, saved.bot);
  } catch (error) {
    rememberProfileBot(wallet, previous);
    throw error;
  }
}
