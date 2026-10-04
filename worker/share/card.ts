/**
 * The share card: what a player's referral link shows when it is posted on X, Discord or WhatsApp.
 *
 * Pure functions only: the SVG for the 1200x630 card and the preview texts, both built from numbers
 * the server read itself (worker/share/stats.ts), so a card can never claim more than the player
 * actually mined. worker/share/render.ts turns the SVG into a PNG.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { BotSvg, botFor, type BotLook } from "../../src/components/BotArt";
import type { ProfileBot } from "../../shared/profileBot";

export interface ShareStats {
  wallet: string;
  username: string | null;
  bot: ProfileBot | null;
  oreEarned: number;
  longestStreak: number;
  /** Distinct coins this wallet has mined anything of. */
  coins: number;
  /** The coin it holds the most of (pending plus paid out), or null before the first block. */
  top: { symbol: string; amount: number } | null;
}

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const BG = "#141414";
const CARD = "#1f1f1f";
const CONTROL = "#2a2a2a";
const FG = "#f4f4f5";
const MUTED = "#a1a1aa";

export function shortWallet(wallet: string): string {
  return wallet.length > 10 ? wallet.slice(0, 4) + "…" + wallet.slice(-4) : wallet;
}

export function displayNameOf(stats: Pick<ShareStats, "wallet" | "username">): string {
  const name = stats.username?.trim();
  return name ? name : shortWallet(stats.wallet);
}

/** 1,234 / 98,765 / 1.2M / 3.4B: whole numbers up to six digits, then compact. */
export function formatAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 1) return value.toLocaleString("en-US", { maximumFractionDigits: 4 });
  if (value < 1_000_000) return Math.floor(value).toLocaleString("en-US");
  const units: [number, string][] = [[1e12, "T"], [1e9, "B"], [1e6, "M"]];
  for (const [size, unit] of units) {
    if (value >= size) return (Math.floor((value / size) * 10) / 10).toLocaleString("en-US") + unit;
  }
  return Math.floor(value).toLocaleString("en-US");
}

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

/** Cuts a string to a pixel budget, roughly: Roboto averages ~0.56em per character. */
function fit(text: string, fontSize: number, maxWidth: number): string {
  const max = Math.max(4, Math.floor(maxWidth / (fontSize * 0.56)));
  return text.length > max ? text.slice(0, max - 1) + "…" : text;
}

/** The player's bot as the app draws it: their saved look, or the default for their wallet. */
export function lookOf(stats: Pick<ShareStats, "wallet" | "bot">): BotLook {
  if (stats.bot) {
    const [slot, item] = stats.bot.accessory.split(":");
    return {
      shape: stats.bot.shape,
      color: stats.bot.color,
      hat: slot === "hat" ? (item as BotLook["hat"]) : "none",
      eyewear: slot === "eyewear" ? (item as BotLook["eyewear"]) : "none",
    };
  }
  const look = botFor(stats.wallet);
  return look.hat !== "none" ? { ...look, eyewear: "none" } : look;
}

/** The bot's SVG markup, nested into the card at a given box. */
function botMarkup(look: BotLook, x: number, y: number, size: number): string {
  const inner = renderToStaticMarkup(createElement(BotSvg, { ...look, tool: true }));
  // BotSvg renders <svg viewBox="0 0 100 100" ...>; give it a position and a size in the card.
  return inner.replace("<svg", `<svg x="${x}" y="${y}" width="${size}" height="${size}" overflow="visible"`);
}

function pill(x: number, y: number, text: string): { svg: string; width: number } {
  const size = 26;
  const width = Math.round(text.length * size * 0.56 + 44);
  return {
    width,
    svg:
      `<rect x="${x}" y="${y}" width="${width}" height="54" rx="27" fill="${CONTROL}"/>` +
      `<text x="${x + 22}" y="${y + 36}" font-size="${size}" font-weight="500" fill="${FG}">${escapeXml(text)}</text>`,
  };
}

/** The 1200x630 card. `wordmark` is a data: URI of the Diggo wordmark PNG. */
export function cardSvg(stats: ShareStats, wordmark: string): string {
  const name = fit(displayNameOf(stats), 54, 560);
  const look = lookOf(stats);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="Roboto">`,
    `<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#ff6a00"/><stop offset=".55" stop-color="#ec4899"/><stop offset="1" stop-color="#a855f7"/></linearGradient>` +
      `<clipPath id="stage"><rect x="56" y="56" width="452" height="518" rx="48"/></clipPath></defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    // The bot's stage.
    `<g clip-path="url(#stage)"><rect x="56" y="56" width="452" height="518" fill="${CARD}"/>` +
      `<rect x="56" y="470" width="452" height="104" fill="${CONTROL}"/></g>`,
    botMarkup(look, 132, 200, 290),
    `<image x="560" y="62" width="236" height="70" href="${wordmark}" xlink:href="${wordmark}" preserveAspectRatio="xMinYMid meet"/>`,
    `<text x="560" y="250" font-size="54" font-weight="900" fill="${FG}">${escapeXml(name)}</text>`,
  );
  if (stats.top) {
    const amount = formatAmount(stats.top.amount);
    const symbol = "$" + stats.top.symbol;
    const length = amount.length + symbol.length + 1;
    const big = length > 15 ? 56 : length > 12 ? 66 : 80;
    parts.push(
      `<text x="560" y="314" font-size="34" font-weight="500" fill="${MUTED}">My bots dug</text>`,
      `<text x="560" y="${314 + big + 6}" font-size="${big}" font-weight="900" fill="${FG}">${escapeXml(amount)} <tspan fill="url(#g)">${escapeXml(symbol)}</tspan></text>`,
    );
  } else {
    parts.push(
      `<text x="560" y="314" font-size="34" font-weight="500" fill="${MUTED}">Start earning</text>`,
      `<text x="560" y="392" font-size="60" font-weight="900" fill="${FG}">Solana <tspan fill="url(#g)">memecoins</tspan></text>`,
    );
  }
  const pills = [
    stats.longestStreak > 0 ? `${stats.longestStreak}-day streak` : null,
    stats.oreEarned > 0 ? `${formatAmount(stats.oreEarned)} ORE` : null,
    stats.coins > 1 ? `${stats.coins} coins` : null,
  ].filter((value): value is string => value !== null);
  if (pills.length === 0) pills.push("Free to play");
  let px = 560;
  for (const text of pills) {
    if (px > 1080) break;
    const p = pill(px, 432, text);
    parts.push(p.svg);
    px += p.width + 12;
  }
  parts.push(
    `<text x="560" y="560" font-size="34" font-weight="900" fill="${FG}">Earn memecoins <tspan fill="url(#g)">for free.</tspan></text>`,
    `<text x="1144" y="560" font-size="28" font-weight="500" fill="${MUTED}" text-anchor="end">diggo.fun</text>`,
    "</svg>",
  );
  return parts.join("");
}

/** Title and description for the link preview. */
export function previewText(stats: ShareStats): { title: string; description: string } {
  const name = displayNameOf(stats);
  const title = `${name} is earning memecoins on Diggo.fun`;
  const dug = stats.top ? `My bots dug ${formatAmount(stats.top.amount)} $${stats.top.symbol}` : "Earn real Solana memecoins";
  return { title, description: `${dug} for free. Start mining while you're away and upgrade your mining power.` };
}
