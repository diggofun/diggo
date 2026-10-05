/**
 * The mine card: what a mine link (diggo.fun/m/<mint>) shows when it is posted on X, Discord or
 * Telegram. Pure functions, like card.ts: the numbers come from worker/share/mineStats.ts.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server.edge";
import { BotSvg, botAt, botFor, type BotLook } from "../../src/components/BotArt";
import { CARD_HEIGHT, CARD_WIDTH, escapeXml, formatAmount } from "./card";

export interface MineShareStats {
  mint: string;
  symbol: string;
  name: string;
  /** Who created the mine: a project's name for an added coin, null for a Diggo launch. */
  createdBy: string | null;
  /** Added coins pay out right away; launches pay after graduation. */
  paysNow: boolean;
  open: boolean;
  remaining: number;
  reserve: number;
  crews: number;
}

/** A stable starting point in the bot rotation for a ticker. */
function botStart(symbol: string): number {
  let h = 0;
  for (const char of symbol) h = (h * 31 + char.charCodeAt(0)) >>> 0;
  return h % 97;
}

const BG = "#141414";
const CARD = "#1f1f1f";
const CONTROL = "#2a2a2a";
const FG = "#f4f4f5";
const MUTED = "#a1a1aa";

/** Strips a symbol to what the card's font can show. */
export function cleanSymbol(symbol: string): string {
  return symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 10).toUpperCase() || "COIN";
}

function bot(look: BotLook, x: number, y: number, size: number): string {
  const inner = renderToStaticMarkup(createElement(BotSvg, { ...look, tool: true }));
  return inner.replace("<svg", `<svg x="${x}" y="${y}" width="${size}" height="${size}" overflow="visible"`);
}

function pill(x: number, y: number, text: string): { svg: string; width: number } {
  const width = Math.round(text.length * 26 * 0.56 + 44);
  return {
    width,
    svg: `<rect x="${x}" y="${y}" width="${width}" height="54" rx="27" fill="${CONTROL}"/>` +
      `<text x="${x + 22}" y="${y + 36}" font-size="26" font-weight="500" fill="${FG}">${escapeXml(text)}</text>`,
  };
}

/** A coin token drawn as a gold disc with the ticker, for the bots to dig around. */
function coin(cx: number, cy: number, r: number, symbol: string): string {
  const label = symbol.length <= 6 ? symbol : symbol.slice(0, 4);
  const size = Math.round(r * (label.length <= 3 ? 0.62 : label.length === 4 ? 0.5 : label.length === 5 ? 0.4 : 0.34));
  return `<circle cx="${cx}" cy="${cy + 6}" r="${r}" fill="#b45309"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="#f59e0b"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r * 0.8}" fill="none" stroke="#fcd34d" stroke-width="5"/>` +
    `<text x="${cx}" y="${cy + size * 0.36}" font-size="${size}" font-weight="900" fill="#78350f" text-anchor="middle">${escapeXml(label)}</text>`;
}

export function mineCardSvg(stats: MineShareStats, wordmark: string): string {
  const symbol = cleanSymbol(stats.symbol);
  // Three different bots: the coin's own look picks where in the rotation the crew starts.
  const start = botStart(symbol);
  const crew = [0, 1, 2].map((offset) => {
    const look = offset === 0 ? botFor(symbol) : botAt(start + offset * 3);
    return look.hat !== "none" ? { ...look, eyewear: "none" as const } : look;
  });
  const big = symbol.length > 8 ? 76 : symbol.length > 6 ? 92 : 108;
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" viewBox="0 0 ${CARD_WIDTH} ${CARD_HEIGHT}" font-family="Roboto">`,
    `<defs><linearGradient id="g" x1="0" x2="1" y1="0" y2="0"><stop offset="0" stop-color="#ff6a00"/><stop offset=".55" stop-color="#ec4899"/><stop offset="1" stop-color="#a855f7"/></linearGradient>` +
      `<clipPath id="stage"><rect x="56" y="56" width="452" height="518" rx="48"/></clipPath></defs>`,
    `<rect width="${CARD_WIDTH}" height="${CARD_HEIGHT}" fill="${BG}"/>`,
    `<g clip-path="url(#stage)"><rect x="56" y="56" width="452" height="518" fill="${CARD}"/><rect x="56" y="470" width="452" height="104" fill="${CONTROL}"/></g>`,
    coin(282, 190, 78, symbol),
    bot(crew[0]!, 76, 330, 140),
    bot(crew[1]!, 212, 330, 140),
    bot(crew[2]!, 348, 330, 140),
    `<image x="560" y="62" width="236" height="70" href="${wordmark}" xlink:href="${wordmark}" preserveAspectRatio="xMinYMid meet"/>`,
    `<text x="560" y="214" font-size="34" font-weight="500" fill="${MUTED}">${stats.open ? "Bots are mining" : "Mine"}</text>`,
    `<text x="556" y="${214 + big}" font-size="${big}" font-weight="900" fill="url(#g)">$${escapeXml(symbol)}</text>`,
  ];
  const by = stats.createdBy ? "Mine created by " + stats.createdBy : "Launched on Diggo";
  parts.push(`<text x="560" y="${214 + big + 52}" font-size="30" font-weight="500" fill="${FG}">${escapeXml(by.length > 34 ? by.slice(0, 33) + "…" : by)}</text>`);
  const pills = [
    stats.reserve > 0 ? `${formatAmount(stats.remaining)} left` : null,
    stats.paysNow ? "Pays out now" : null,
    stats.crews > 0 ? `${stats.crews} ${stats.crews === 1 ? "crew" : "crews"}` : null,
  ].filter((value): value is string => value !== null);
  let px = 560;
  for (const text of pills) {
    const p = pill(px, 448, text);
    if (px + p.width > 1150) break;
    parts.push(p.svg);
    px += p.width + 12;
  }
  parts.push(
    `<text x="560" y="560" font-size="34" font-weight="900" fill="${FG}">Mine $${escapeXml(symbol)} <tspan fill="url(#g)">for free.</tspan></text>`,
    `<text x="1144" y="560" font-size="28" font-weight="500" fill="${MUTED}" text-anchor="end">diggo.fun</text>`,
    "</svg>",
  );
  return parts.join("");
}

export function minePreviewText(stats: MineShareStats): { title: string; description: string } {
  const symbol = cleanSymbol(stats.symbol);
  const title = `Mine $${symbol} on Diggo.fun`;
  const by = stats.createdBy ? ` Mine created by ${stats.createdBy}.` : "";
  const left = stats.reserve > 0 ? ` ${formatAmount(stats.remaining)} $${symbol} left to mine.` : "";
  return { title, description: `Send your bots to dig $${symbol} for free and get paid out in $${symbol}.${by}${left}` };
}
