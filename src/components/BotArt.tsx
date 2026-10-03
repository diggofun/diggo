/**
 * The bot drawings: shapes, hats, eyewear and the SVG that puts them together. Kept free of CSS and
 * browser APIs so both the app (src/components/Bot.tsx) and the Worker's share cards
 * (worker/share.ts) draw the same bot. Bot.tsx re-exports everything here.
 */
import type { ReactNode } from "react";
import { BOT_COLORS, BOT_EYEWEAR, BOT_HATS, BOT_SHAPE_NAMES, type BotEyewear, type BotHat, type BotShape } from "../../shared/profileBot";

export { BOT_COLORS, BOT_EYEWEAR, BOT_HATS, BOT_SHAPE_NAMES, type BotEyewear, type BotHat, type BotShape };

interface ShapeDef {
  /** Outline in a 100x100 box. */
  d: string;
  /** Left eye centre; the right eye sits 12 units to its right. Eyes sit upper right: bots face right. */
  eyes: readonly [number, number];
  /** Top of the head (the bottom centre of a hat). */
  head: readonly [number, number];
}

export const BOT_SHAPES = {
  circle: { d: "M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88z", eyes: [58, 32], head: [54, 6] },
  blob: { d: "M52 10c26 0 42 14 42 38c0 26-20 42-46 42C22 90 6 74 6 50C6 26 24 10 52 10z", eyes: [58, 32], head: [56, 10] },
  square: { d: "M30 8h40c14 0 22 8 22 22v40c0 14-8 22-22 22H30C16 92 8 84 8 70V30C8 16 16 8 30 8z", eyes: [58, 30], head: [54, 8] },
  pill: { d: "M30 22h40a28 28 0 0 1 0 56H30a28 28 0 0 1 0-56z", eyes: [60, 38], head: [60, 22] },
  triangle: { d: "M41 14c4.5-7.5 13.5-7.5 18 0l34 58c4.5 7.8-1 16-10 16H17c-9 0-14.5-8.2-10-16z", eyes: [52, 44], head: [50, 10] },
  hexagon: { d: "M50 6l38 22v44L50 94L12 72V28z", eyes: [56, 34], head: [50, 7] },
  cloud: { d: "M30 82c-14 0-24-10-24-22c0-11 8-20 19-21c2-15 13-25 27-25c13 0 24 9 27 21c10 1 17 10 17 21c0 14-10 26-26 26z", eyes: [58, 40], head: [53, 14] },
  drop: { d: "M50 6c14 20 36 38 36 58c0 18-16 30-36 30S14 82 14 64C14 44 36 26 50 6z", eyes: [56, 50], head: [52, 12] },
  star: { d: "M50 10L62.3 37L91.8 40.4L70 60.5L75.9 89.6L50 75L24.1 89.6L30 60.5L8.2 40.4L37.7 37z", eyes: [43, 50], head: [50, 11] },
  heart: { d: "M50 88C20 70 6 52 6 34C6 18 18 8 31 8C40 8 46 13 50 20C54 13 60 8 69 8C82 8 94 18 94 34C94 52 80 70 50 88z", eyes: [52, 38], head: [70, 8] },
  diamond: { d: "M50 6L92 50L50 94L8 50z", eyes: [45, 44], head: [50, 8] },
  ghost: { d: "M50 8c22 0 38 16 38 38V90L78.5 82L69 90L59.5 82L50 90L40.5 82L31 90L21.5 82L12 90V46c0-22 16-38 38-38z", eyes: [56, 36], head: [54, 8] },
  egg: { d: "M50 6c22 0 38 30 38 54c0 20-16 34-38 34S12 80 12 60C12 36 28 6 50 6z", eyes: [54, 42], head: [52, 6] },
  bean: { d: "M30 14c14-6 22 8 34 6c16-3 30 8 30 28c0 26-20 44-46 44C24 92 8 76 8 54C8 34 16 20 30 14z", eyes: [58, 38], head: [72, 18] },
  octagon: { d: "M32 8h36l24 24v36L68 92H32L8 68V32z", eyes: [56, 34], head: [52, 8] },
  bell: { d: "M50 8c24 0 38 20 38 44c0 10 4 18 8 22c2 3 0 6-3 6H7c-3 0-5-3-3-6c4-4 8-12 8-22C12 28 26 8 50 8z", eyes: [56, 40], head: [52, 8] },
} as const satisfies Record<BotShape, ShapeDef>;


/** Wardrobe rotation for line-ups: plenty of bare heads, so the outfits stay a treat. */
const HAT_ROTATION: readonly BotHat[] = ["none", "cap", "hardhat", "beanie", "none", "crown", "party", "bow", "tophat"];
const EYEWEAR_ROTATION: readonly BotEyewear[] = ["none", "glasses", "none", "shades", "none", "goggles"];

export interface BotLook {
  shape: BotShape;
  color: string;
  hat: BotHat;
  eyewear: BotEyewear;
}

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable bot for a seed (a mint, a wallet): the same seed always draws the same bot. */
export function botFor(seed: string): BotLook {
  const h = hash(seed);
  return {
    shape: BOT_SHAPE_NAMES[h % BOT_SHAPE_NAMES.length],
    color: BOT_COLORS[(h >>> 4) % BOT_COLORS.length],
    hat: HAT_ROTATION[(h >>> 8) % HAT_ROTATION.length],
    eyewear: EYEWEAR_ROTATION[(h >>> 12) % EYEWEAR_ROTATION.length],
  };
}

/** The nth bot of a line-up: shape, colour and outfit all step, so neighbours never match. */
export function botAt(index: number): BotLook {
  return {
    shape: BOT_SHAPE_NAMES[(index * 5 + 1) % BOT_SHAPE_NAMES.length],
    color: BOT_COLORS[(index * 7) % BOT_COLORS.length],
    hat: HAT_ROTATION[(index * 4 + 1) % HAT_ROTATION.length],
    eyewear: EYEWEAR_ROTATION[(index * 5 + 1) % EYEWEAR_ROTATION.length],
  };
}

/** A second colour for hats and bows: from the palette, never the bot's own and never white on white. */
function accentFor(color: string): string {
  const index = BOT_COLORS.indexOf(color as (typeof BOT_COLORS)[number]);
  const pick = BOT_COLORS[((index < 0 ? hash(color) : index) + 5) % BOT_COLORS.length];
  return pick === "#ffffff" ? "#3b82f6" : pick;
}

/** A flat shade laid over a part: the only "shading" a bot gets, so it stays flat. */
const SHADE = { fill: "#000000", opacity: 0.2 } as const;
const GOLD = "#facc15";
const GOLD_DARK = "#d4a20a";
const INK = "#18181b";

/**
 * A hat, drawn around its own bottom centre (0, 0) at its final size in the bot's 100x100 box.
 * The wearer translates it onto the head anchor.
 */
function HatArt({ hat, accent }: { hat: BotHat; accent: string }): ReactNode {
  switch (hat) {
    case "hardhat":
      return (
        <>
          <path d="M-17 1C-17-12-9-21 0-21S17-12 17 1Z" fill={GOLD} />
          <path d="M-1.5-20.5V-2" stroke={GOLD_DARK} strokeWidth="4" strokeLinecap="round" />
          <rect x="-23" y="-2.5" width="46" height="7" rx="3.5" fill={GOLD_DARK} />
          <circle className="bot-lamp" cx="10" cy="-10" r="5.6" fill={GOLD_DARK} />
          <circle cx="10" cy="-10" r="3.6" fill="#fef9c3" />
        </>
      );
    case "cap":
      return (
        <>
          <path d="M-15 1C-15-11-8-18 0-18S15-11 15 1Z" fill={accent} />
          <path d="M10-1C18-2.5 25-.5 29.5 3C25 5.5 17 5.5 10 4Z" fill={accent} stroke={accent} strokeWidth="2" strokeLinejoin="round" />
          <path d="M10-1C18-2.5 25-.5 29.5 3C25 5.5 17 5.5 10 4Z" {...SHADE} />
          <circle cx="0" cy="-18" r="2.8" fill={accent} />
        </>
      );
    case "beanie":
      return (
        <>
          <path d="M-16-2C-16-15-9-22 0-22S16-15 16-2Z" fill={accent} />
          <rect x="-18" y="-7" width="36" height="10" rx="5" fill={accent} />
          <rect x="-18" y="-7" width="36" height="10" rx="5" {...SHADE} />
          <circle cx="0" cy="-24.5" r="5.8" fill="#ffffff" />
        </>
      );
    case "crown":
      return (
        <>
          <path d="M-14 1V-13L-7-5.5L0-17L7-5.5L14-13V1Z" fill={GOLD} stroke={GOLD} strokeWidth="4.5" strokeLinejoin="round" />
          <rect x="-16" y="-3.5" width="32" height="6" rx="3" fill={GOLD_DARK} />
          <circle cx="0" cy="-8" r="2.8" fill="#f43f5e" />
        </>
      );
    case "party":
      return (
        <g transform="rotate(14)">
          <path d="M-11 1L0-25L11 1Z" fill={accent} stroke={accent} strokeWidth="4" strokeLinejoin="round" />
          <circle cx="-3" cy="-7" r="2.4" fill="#ffffff" opacity=".9" />
          <circle cx="3" cy="-14" r="2" fill="#ffffff" opacity=".9" />
          <circle cx="0" cy="-28" r="4.4" fill="#ffffff" />
        </g>
      );
    case "bow":
      return (
        <g transform="translate(12 1)">
          <path d="M0-3C-4-11-14-12-14-3S-4 4 0-3Z" fill={accent} stroke={accent} strokeWidth="2" strokeLinejoin="round" />
          <path d="M0-3C4-11 14-12 14-3S4 4 0-3Z" fill={accent} stroke={accent} strokeWidth="2" strokeLinejoin="round" />
          <circle cx="0" cy="-3" r="4" fill={accent} />
          <circle cx="0" cy="-3" r="4" {...SHADE} />
        </g>
      );
    case "tophat":
      return (
        <>
          <rect x="-12" y="-25" width="24" height="25" rx="4.5" fill={INK} />
          <rect x="-12" y="-9" width="24" height="5.5" fill={accent} />
          <rect x="-19" y="-3" width="38" height="6.5" rx="3.25" fill={INK} />
        </>
      );
    default:
      return null;
  }
}

/** Glasses, shades and goggles, centred on the eyes so they ride along when the bot looks around. */
function EyewearArt({ eyewear, eyes }: { eyewear: BotEyewear; eyes: readonly [number, number] }): ReactNode {
  const [x, y] = eyes;
  switch (eyewear) {
    case "glasses":
      return (
        <g fill="none" stroke={INK} strokeWidth="2.8" strokeLinecap="round">
          <circle cx={x} cy={y} r="6.6" />
          <circle cx={x + 12.6} cy={y} r="6.6" />
          <path d={`M${x - 6.6} ${y - 1}l-6 -2.5`} />
        </g>
      );
    case "shades":
      return (
        <>
          <rect x={x - 8.5} y={y - 6} width="29.5" height="12" rx="6" fill={INK} />
          <path d={`M${x - 8.5} ${y - 2}l-6 -2.5`} stroke={INK} strokeWidth="2.8" strokeLinecap="round" />
          <path d={`M${x - 3.5} ${y - 2.5}h4`} stroke="#ffffff" strokeOpacity=".6" strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case "goggles":
      return (
        <>
          <path d={`M${x - 20} ${y + 1}H${x + 30}`} stroke={INK} strokeWidth="4.5" strokeLinecap="round" />
          <circle cx={x} cy={y} r="8" fill={INK} />
          <circle cx={x + 13} cy={y} r="8" fill={INK} />
          <circle cx={x} cy={y} r="5.4" fill="#7dd3fc" />
          <circle cx={x + 13} cy={y} r="5.4" fill="#7dd3fc" />
        </>
      );
    default:
      return null;
  }
}

export interface BotSvgProps {
  shape: BotShape;
  color: string;
  hat?: BotHat;
  eyewear?: BotEyewear;
  /** Draws the pickaxe in front of the body. */
  tool?: boolean;
  toolColor?: string;
}

/**
 * The bot drawing itself: a 100x100 SVG with no CSS and no browser APIs, so the Worker can render
 * the same bot into a share card (worker/share.ts) that the app animates (Bot.tsx). The group
 * classes are the hooks bot.css animates; without the stylesheet they are inert.
 */
export function BotSvg({ shape, color, hat = "none", eyewear = "none", tool = false, toolColor = "#e4e4e7" }: BotSvgProps) {
  const s: ShapeDef = BOT_SHAPES[shape] ?? BOT_SHAPES.blob;
  const [ex, ey] = s.eyes;
  const [hx, hy] = s.head;
  const eye = color.toLowerCase() === "#ffffff" ? "#3f3f46" : INK;
  const coversEyes = eyewear === "shades";
  const withTool = tool;
  return (
    <svg className="bot-svg" viewBox="0 0 100 100" focusable="false">
      <g className="bot-turn">
        <g className="bot-body">
          {/* The stroke in the body's own colour with round joins is what rounds every corner. */}
          <path d={s.d} fill={color} stroke={color} strokeWidth="9" strokeLinejoin="round" />
          <g className="bot-eyes">
            {!coversEyes && (
              <>
                <g transform={`rotate(-10 ${ex} ${ey})`}>
                  <rect className="bot-eye" x={ex - 2.8} y={ey - 6.5} width="5.6" height="13" rx="2.8" fill={eye} />
                </g>
                <g transform={`rotate(10 ${ex + 12} ${ey})`}>
                  <rect className="bot-eye" x={ex + 9.2} y={ey - 6.5} width="5.6" height="13" rx="2.8" fill={eye} />
                </g>
              </>
            )}
            <EyewearArt eyewear={eyewear} eyes={s.eyes} />
          </g>
          {hat !== "none" && (
            <g className="bot-hat" transform={`translate(${hx} ${hy - 1}) scale(1.3)`}>
              <HatArt hat={hat} accent={accentFor(color)} />
            </g>
          )}
          {/* The pick is held in front of the body, the way the logo bot holds it: handle across the
              body, head over the shoulder, swinging round the hand at (70, 68). */}
          {withTool && (
            <g className="bot-tool">
              <path d="M70 70L88 22" stroke="#9a5a26" strokeWidth="8" strokeLinecap="round" />
              <path d="M64 25Q88 4 113 31Q88 15 64 25Z" fill={toolColor} stroke={toolColor} strokeWidth="5" strokeLinejoin="round" />
            </g>
          )}
        </g>
      </g>
    </svg>
  );
}
