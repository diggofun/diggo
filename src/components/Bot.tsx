/**
 * The Diggo crew: small coloured bots with two eyes, borrowed from LowBot's bot characters
 * (Avenium-project/LowBot, client/components/v2/ui.jsx, MIT). LowBot's eight shapes and colours,
 * plus eight more of each, and the same idle float, look-around, blink and tap squish. Diggo adds
 * a pickaxe, a dig cycle, and a wardrobe of hats and glasses.
 *
 * Every shape is drawn with a thick stroke in its own colour and round joins, so even the pointy
 * ones (star, diamond, hexagon) end up with soft, rounded corners.
 *
 * Purely decorative. A bot never carries game state of its own: callers pick a look from a stable
 * seed (botFor) or a slot index (botAt), so the same mine or slot always shows the same bot.
 */
import { useState, type CSSProperties, type ReactNode } from "react";

interface ShapeDef {
  /** Outline in a 100x100 box. */
  d: string;
  /** Left eye centre; the right eye sits 12 units to its right. Eyes sit upper right: bots face right. */
  eyes: readonly [number, number];
  /** Top of the head, where a hat sits. */
  head: readonly [number, number];
}

export const BOT_SHAPES = {
  circle: { d: "M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88z", eyes: [58, 32], head: [52, 7] },
  blob: { d: "M52 10c26 0 42 14 42 38c0 26-20 42-46 42C22 90 6 74 6 50C6 26 24 10 52 10z", eyes: [58, 32], head: [54, 11] },
  square: { d: "M30 8h40c14 0 22 8 22 22v40c0 14-8 22-22 22H30C16 92 8 84 8 70V30C8 16 16 8 30 8z", eyes: [58, 30], head: [52, 9] },
  pill: { d: "M30 22h40a28 28 0 0 1 0 56H30a28 28 0 0 1 0-56z", eyes: [60, 38], head: [58, 23] },
  triangle: { d: "M41 14c4.5-7.5 13.5-7.5 18 0l34 58c4.5 7.8-1 16-10 16H17c-9 0-14.5-8.2-10-16z", eyes: [52, 44], head: [50, 12] },
  hexagon: { d: "M50 6l38 22v44L50 94L12 72V28z", eyes: [56, 34], head: [50, 9] },
  cloud: { d: "M30 82c-14 0-24-10-24-22c0-11 8-20 19-21c2-15 13-25 27-25c13 0 24 9 27 21c10 1 17 10 17 21c0 14-10 26-26 26z", eyes: [58, 40], head: [52, 15] },
  drop: { d: "M50 6c14 20 36 38 36 58c0 18-16 30-36 30S14 82 14 64C14 44 36 26 50 6z", eyes: [56, 50], head: [52, 14] },
  star: { d: "M50 10L62.3 37L91.8 40.4L70 60.5L75.9 89.6L50 75L24.1 89.6L30 60.5L8.2 40.4L37.7 37z", eyes: [43, 50], head: [50, 14] },
  heart: { d: "M50 88C20 70 6 52 6 34C6 18 18 8 31 8C40 8 46 13 50 20C54 13 60 8 69 8C82 8 94 18 94 34C94 52 80 70 50 88z", eyes: [52, 38], head: [69, 9] },
  diamond: { d: "M50 6L92 50L50 94L8 50z", eyes: [45, 44], head: [50, 10] },
  ghost: { d: "M50 8c22 0 38 16 38 38V90L78.5 82L69 90L59.5 82L50 90L40.5 82L31 90L21.5 82L12 90V46c0-22 16-38 38-38z", eyes: [56, 36], head: [52, 9] },
  egg: { d: "M50 6c22 0 38 30 38 54c0 20-16 34-38 34S12 80 12 60C12 36 28 6 50 6z", eyes: [54, 42], head: [50, 7] },
  bean: { d: "M30 14c14-6 22 8 34 6c16-3 30 8 30 28c0 26-20 44-46 44C24 92 8 76 8 54C8 34 16 20 30 14z", eyes: [58, 38], head: [70, 19] },
  octagon: { d: "M32 8h36l24 24v36L68 92H32L8 68V32z", eyes: [56, 34], head: [50, 9] },
  bell: { d: "M50 8c24 0 38 20 38 44c0 10 4 18 8 22c2 3 0 6-3 6H7c-3 0-5-3-3-6c4-4 8-12 8-22C12 28 26 8 50 8z", eyes: [56, 40], head: [50, 9] },
} as const satisfies Record<string, ShapeDef>;

export type BotShape = keyof typeof BOT_SHAPES;

export const BOT_SHAPE_NAMES = Object.keys(BOT_SHAPES) as BotShape[];

/** LowBot's eight creature colours first, then eight more from its avatar palette and Tailwind. */
export const BOT_COLORS = [
  "#ff6a00", "#3b82f6", "#a855f7", "#10b981", "#f43f5e", "#eab308", "#06b6d4", "#ec4899",
  "#84cc16", "#6366f1", "#14b8a6", "#ef2b3c", "#38bdf8", "#d946ef", "#8d6e4f", "#ffffff",
] as const;

export type BotHat = "none" | "hardhat" | "cap" | "beanie" | "crown" | "party" | "bow";
export type BotEyewear = "none" | "glasses" | "shades";

const HATS: readonly BotHat[] = ["none", "cap", "hardhat", "beanie", "none", "crown", "party", "bow"];
const EYEWEAR: readonly BotEyewear[] = ["none", "glasses", "none", "shades", "none"];

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
    hat: HATS[(h >>> 8) % HATS.length],
    eyewear: EYEWEAR[(h >>> 12) % EYEWEAR.length],
  };
}

/** The nth bot of a line-up: shape, colour and outfit all step, so neighbours never match. */
export function botAt(index: number): BotLook {
  return {
    shape: BOT_SHAPE_NAMES[(index * 5 + 1) % BOT_SHAPE_NAMES.length],
    color: BOT_COLORS[(index * 7) % BOT_COLORS.length],
    hat: HATS[(index * 3 + 1) % HATS.length],
    eyewear: EYEWEAR[(index * 2 + 1) % EYEWEAR.length],
  };
}

/** A second colour from the palette for hats and bows, never the bot's own. */
function accentFor(color: string): string {
  const index = BOT_COLORS.indexOf(color as (typeof BOT_COLORS)[number]);
  return BOT_COLORS[((index < 0 ? hash(color) : index) + 5) % BOT_COLORS.length];
}

function Hat({ hat, head, color }: { hat: BotHat; head: readonly [number, number]; color: string }) {
  const [x, y] = head;
  const accent = accentFor(color);
  switch (hat) {
    case "hardhat":
      return (
        <g className="bot-hat">
          <path d={`M${x - 18} ${y + 5}a18 17 0 0 1 36 0z`} fill="#facc15" />
          <path d={`M${x - 2} ${y - 11}v15`} stroke="#eab308" strokeWidth="3" strokeLinecap="round" />
          <rect x={x - 23} y={y + 2} width="46" height="6" rx="3" fill="#eab308" />
          <circle className="bot-lamp" cx={x + 11} cy={y - 3} r="4.2" fill="#fff7cc" />
        </g>
      );
    case "cap":
      return (
        <g className="bot-hat">
          <path d={`M${x - 16} ${y + 6}a16 15 0 0 1 32 0z`} fill={accent} />
          <path d={`M${x + 10} ${y + 3}q16 -1 22 5q-9 3 -22 1z`} fill={accent} stroke={accent} strokeWidth="2" strokeLinejoin="round" />
          <circle cx={x} cy={y - 9} r="2.4" fill="#ffffff" opacity=".8" />
        </g>
      );
    case "beanie":
      return (
        <g className="bot-hat">
          <path d={`M${x - 17} ${y + 6}a17 18 0 0 1 34 0z`} fill={accent} />
          <rect x={x - 19} y={y + 1} width="38" height="8" rx="4" fill={accent} />
          <rect x={x - 19} y={y + 1} width="38" height="8" rx="4" fill="#000000" opacity=".18" />
          <circle cx={x} cy={y - 13} r="5" fill="#ffffff" />
        </g>
      );
    case "crown":
      return (
        <g className="bot-hat">
          <path
            d={`M${x - 14} ${y + 6}V${y - 8}L${x - 7} ${y - 1}L${x} ${y - 12}L${x + 7} ${y - 1}L${x + 14} ${y - 8}V${y + 6}z`}
            fill="#facc15"
            stroke="#facc15"
            strokeWidth="4"
            strokeLinejoin="round"
          />
          <circle cx={x} cy={y + 1} r="2.6" fill="#f43f5e" />
        </g>
      );
    case "party":
      return (
        <g className="bot-hat" transform={`rotate(14 ${x} ${y + 6})`}>
          <path d={`M${x - 11} ${y + 6}L${x} ${y - 20}L${x + 11} ${y + 6}z`} fill={accent} stroke={accent} strokeWidth="3" strokeLinejoin="round" />
          <path d={`M${x - 7} ${y - 3}L${x + 5} ${y + 2}M${x - 4} ${y - 11}L${x + 3} ${y - 8}`} stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" opacity=".85" />
          <circle cx={x} cy={y - 21} r="3.6" fill="#ffffff" />
        </g>
      );
    case "bow":
      return (
        <g className="bot-hat">
          <path d={`M${x + 4} ${y + 6}l-12 -8v14z M${x + 4} ${y + 6}l12 -8v14z`} fill={accent} stroke={accent} strokeWidth="3" strokeLinejoin="round" />
          <circle cx={x + 4} cy={y + 6} r="3.6" fill={accent} stroke="#000000" strokeOpacity=".2" />
        </g>
      );
    default:
      return null;
  }
}

function Eyewear({ eyewear, eyes }: { eyewear: BotEyewear; eyes: readonly [number, number] }) {
  const [x, y] = eyes;
  if (eyewear === "glasses") {
    return (
      <g className="bot-eyewear" fill="rgba(255,255,255,.22)" stroke="#111111" strokeWidth="2.4">
        <circle cx={x} cy={y} r="7" />
        <circle cx={x + 13} cy={y} r="7" />
        <path d={`M${x + 6} ${y - 1}h1`} strokeLinecap="round" />
        <path d={`M${x - 7} ${y - 1}l-8 -3`} strokeLinecap="round" fill="none" />
      </g>
    );
  }
  if (eyewear === "shades") {
    return (
      <g className="bot-eyewear">
        <rect x={x - 8} y={y - 6} width="29" height="11" rx="5.5" fill="#111111" />
        <path d={`M${x - 8} ${y - 2}l-7 -3`} stroke="#111111" strokeWidth="2.4" strokeLinecap="round" />
        <path d={`M${x - 3} ${y - 3}h5`} stroke="#ffffff" strokeOpacity=".55" strokeWidth="1.8" strokeLinecap="round" />
      </g>
    );
  }
  return null;
}

export type BotMood = "idle" | "busy" | "dig" | "attention";

export interface BotProps {
  shape: BotShape;
  color: string;
  hat?: BotHat;
  eyewear?: BotEyewear;
  /** Pixels, or any CSS length ("100%") when a parent box sizes the bot. */
  size?: number | string;
  mood?: BotMood;
  /** Draws the pickaxe. Implied by mood "dig". */
  tool?: boolean;
  /** No animation at all (lists, tiny avatars). */
  still?: boolean;
  /** Offsets this bot's cycle so a line-up never moves in lockstep. Seconds. */
  phase?: number;
  /** Dig cycle length in seconds; shorter reads as a harder-working crew. */
  tempo?: number;
  className?: string;
}

export function Bot({ shape, color, hat = "none", eyewear = "none", size = 48, mood = "idle", tool, still, phase = 0, tempo, className = "" }: BotProps) {
  const [squish, setSquish] = useState(false);
  const s: ShapeDef = BOT_SHAPES[shape] ?? BOT_SHAPES.blob;
  const [ex, ey] = s.eyes;
  const eye = color.toLowerCase() === "#ffffff" ? "#3f3f46" : "#1c1917";
  const withTool = tool ?? mood === "dig";
  const style = {
    width: size,
    height: size,
    "--bot-phase": -phase + "s",
    ...(tempo ? { "--bot-tempo": tempo + "s" } : {}),
  } as CSSProperties;
  const classes = ["bot", "is-" + mood, still ? "is-still" : "", squish ? "is-squish" : "", className].filter(Boolean).join(" ");
  let eyesNode: ReactNode = (
    <>
      <g transform={"rotate(-10 " + ex + " " + ey + ")"}>
        <rect className="bot-eye" x={ex - 2.8} y={ey - 6.5} width="5.6" height="13" rx="2.8" fill={eye} />
      </g>
      <g transform={"rotate(10 " + (ex + 12) + " " + ey + ")"}>
        <rect className="bot-eye" x={ex + 9.2} y={ey - 6.5} width="5.6" height="13" rx="2.8" fill={eye} />
      </g>
    </>
  );
  if (eyewear === "shades") eyesNode = null; // shades cover the eyes completely
  return (
    <span
      className={classes}
      style={style}
      aria-hidden="true"
      onPointerDown={() => {
        if (still) return;
        setSquish(true);
        window.setTimeout(() => setSquish(false), 460);
      }}
    >
      {(mood === "busy" || mood === "dig") && !still && <span className="bot-shadow" />}
      <svg className="bot-svg" viewBox="0 0 100 100" focusable="false">
        <g className="bot-body">
          {withTool && (
            <g className="bot-tool">
              <line x1="80" y1="64" x2="96" y2="22" stroke="#8d6e4f" strokeWidth="6" strokeLinecap="round" />
              <path d="M78 22 Q96 8 114 26" fill="none" stroke="#d4d4d8" strokeWidth="7" strokeLinecap="round" />
            </g>
          )}
          {/* The stroke in the body's own colour with round joins is what rounds every corner. */}
          <path d={s.d} fill={color} stroke={color} strokeWidth="9" strokeLinejoin="round" />
          <path d={s.d} fill="url(#bot-sheen)" stroke="url(#bot-sheen)" strokeWidth="9" strokeLinejoin="round" opacity=".5" />
          <g className="bot-eyes">
            {eyesNode}
            <Eyewear eyewear={eyewear} eyes={s.eyes} />
          </g>
          {hat !== "none" && (
            <g transform={`translate(${s.head[0]} ${s.head[1] + 4}) scale(1.35) translate(${-s.head[0]} ${-s.head[1] - 4})`}>
              <Hat hat={hat} head={s.head} color={color} />
            </g>
          )}
          {withTool && <circle className="bot-hand" cx="80" cy="64" r="6" fill={color} stroke="#000000" strokeOpacity=".12" />}
        </g>
      </svg>
      {mood === "dig" && !still && (
        <span className="bot-sparks">
          <i /><i /><i />
        </span>
      )}
    </span>
  );
}

/**
 * Shared SVG defs (the soft top-left sheen every bot wears). Rendered once near the root so each
 * bot can reference it by id instead of repeating a gradient per instance.
 */
export function BotDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="bot-sheen" cx="30%" cy="22%" r="70%">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".55" />
          <stop offset=".45" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity=".22" />
        </radialGradient>
      </defs>
    </svg>
  );
}
