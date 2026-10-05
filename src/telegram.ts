/**
 * Telegram Mini App support. Diggo runs as-is inside Telegram; this only adapts the edges:
 * - loads Telegram's WebApp script (only inside Telegram) and tells Telegram the app is ready,
 *   expanded to full height, with Diggo's colours;
 * - turns the launch parameter of a direct link into the same thing the web links do:
 *   t.me/<bot>/<app>?startapp=m_<mint> is a mine link, ?startapp=r_<code> a referral.
 */
import { rememberMine } from "./mineLink";
import { rememberReferral } from "./referralLink";

const FLAG = "diggo:telegram";
const SCRIPT = "https://telegram.org/js/telegram-web-app.js";

interface TelegramWebApp {
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  openLink?(url: string): void;
  initDataUnsafe?: { start_param?: string };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

/** Telegram opens a Mini App with tgWebApp* parameters in the URL hash or query. */
export function isTelegramLaunch(href: string): boolean {
  return /[#?&]tgWebApp(Data|Version|Platform)=/.test(href);
}

/** The direct-link launch parameter (?startapp=…), as Telegram passes it in the URL. */
export function telegramStartParam(href: string): string | null {
  try {
    const url = new URL(href);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const value = url.searchParams.get("tgWebAppStartParam") ?? hash.get("tgWebAppStartParam");
    return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** What a launch parameter asks for. Mints and referral codes are validated by their own modules. */
export function startTarget(param: string | null): { mine: string } | { referral: string } | null {
  if (!param) return null;
  if (param.startsWith("m_")) return { mine: param.slice(2) };
  if (param.startsWith("r_")) return { referral: param.slice(2) };
  return null;
}

export function inTelegram(): boolean {
  try {
    return sessionStorage.getItem(FLAG) === "1";
  } catch {
    return false;
  }
}

export function startTelegram(href: string = window.location.href): void {
  if (!isTelegramLaunch(href)) return;
  try {
    sessionStorage.setItem(FLAG, "1");
  } catch {
    // Private mode: only this page view knows it runs in Telegram.
  }
  document.documentElement.dataset.telegram = "1";
  const target = startTarget(telegramStartParam(href));
  if (target && "mine" in target) {
    rememberMine(target.mine);
    window.history.replaceState(null, "", "/mine" + window.location.hash);
  }
  if (target && "referral" in target) rememberReferral(target.referral);
  const script = document.createElement("script");
  script.src = SCRIPT;
  script.async = true;
  script.onload = () => {
    const app = window.Telegram?.WebApp;
    if (!app) return;
    app.ready();
    app.expand();
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
    app.setHeaderColor?.(dark ? "#141414" : "#ffffff");
    app.setBackgroundColor?.(dark ? "#141414" : "#ffffff");
  };
  document.head.appendChild(script);
}
