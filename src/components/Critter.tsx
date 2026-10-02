/**
 * The Diggo crew: small coloured creatures with two eyes, borrowed from LowBot's bot characters
 * (Avenium-project/LowBot, client/components/v2/ui.jsx, MIT). Same eight shapes, same colours,
 * same idle float, look-around, blink and tap squish; Diggo adds a pickaxe and a dig cycle so the
 * crew can actually swing at the rock.
 *
 * Purely decorative. A critter never carries game state of its own: callers pick a shape and a
 * colour from a stable seed (critterFor), so the same mine or slot always shows the same creature.
 */
import { useState, type CSSProperties } from "react";

/** Paths in a 100x100 box; the eyes sit in the upper right of each shape, so every critter faces right. */
export const CRITTER_SHAPES = {
  circle: { d: "M50 6a44 44 0 1 1 0 88a44 44 0 1 1 0-88z", eyes: [58, 32] },
  blob: { d: "M52 10c26 0 42 14 42 38c0 26-20 42-46 42C22 90 6 74 6 50C6 26 24 10 52 10z", eyes: [58, 32] },
  square: { d: "M30 8h40c14 0 22 8 22 22v40c0 14-8 22-22 22H30C16 92 8 84 8 70V30C8 16 16 8 30 8z", eyes: [58, 30] },
  pill: { d: "M30 22h40a28 28 0 0 1 0 56H30a28 28 0 0 1 0-56z", eyes: [60, 38] },
  triangle: { d: "M41 14c4.5-7.5 13.5-7.5 18 0l34 58c4.5 7.8-1 16-10 16H17c-9 0-14.5-8.2-10-16z", eyes: [52, 44] },
  hexagon: { d: "M50 6l38 22v44L50 94L12 72V28z", eyes: [56, 34] },
  cloud: { d: "M30 82c-14 0-24-10-24-22c0-11 8-20 19-21c2-15 13-25 27-25c13 0 24 9 27 21c10 1 17 10 17 21c0 14-10 26-26 26z", eyes: [58, 40] },
  drop: { d: "M50 6c14 20 36 38 36 58c0 18-16 30-36 30S14 82 14 64C14 44 36 26 50 6z", eyes: [56, 50] },
} as const;

export type CritterShape = keyof typeof CRITTER_SHAPES;

export const CRITTER_SHAPE_NAMES = Object.keys(CRITTER_SHAPES) as CritterShape[];

/** LowBot's creature colours, in its own order. */
export const CRITTER_COLORS = ["#ff6a00", "#3b82f6", "#a855f7", "#10b981", "#f43f5e", "#eab308", "#06b6d4", "#ec4899"] as const;

function hash(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return h;
}

/** A stable creature for a seed (a mint, a slot name): the same seed always draws the same critter. */
export function critterFor(seed: string): { shape: CritterShape; color: string } {
  const h = hash(seed);
  return {
    shape: CRITTER_SHAPE_NAMES[h % CRITTER_SHAPE_NAMES.length],
    color: CRITTER_COLORS[Math.floor(h / CRITTER_SHAPE_NAMES.length) % CRITTER_COLORS.length],
  };
}

/** The nth crew member of a line-up: shapes and colours step so neighbours never match. */
export function critterAt(index: number): { shape: CritterShape; color: string } {
  return {
    shape: CRITTER_SHAPE_NAMES[(index * 3 + 1) % CRITTER_SHAPE_NAMES.length],
    color: CRITTER_COLORS[(index * 5) % CRITTER_COLORS.length],
  };
}

export type CritterMood = "idle" | "busy" | "dig" | "attention";

export interface CritterProps {
  shape: CritterShape;
  color: string;
  /** Pixels, or any CSS length ("100%") when a parent box sizes the critter. */
  size?: number | string;
  mood?: CritterMood;
  /** Draws the pickaxe. Implied by mood "dig". */
  tool?: boolean;
  /** No animation at all (lists, tiny avatars). */
  still?: boolean;
  /** Offsets this critter's cycle so a line-up never moves in lockstep. Seconds. */
  phase?: number;
  /** Dig cycle length in seconds; shorter reads as a harder-working crew. */
  tempo?: number;
  className?: string;
}

export function Critter({ shape, color, size = 48, mood = "idle", tool, still, phase = 0, tempo, className = "" }: CritterProps) {
  const [squish, setSquish] = useState(false);
  const s = CRITTER_SHAPES[shape] ?? CRITTER_SHAPES.blob;
  const [ex, ey] = s.eyes;
  const eye = color.toLowerCase() === "#ffffff" ? "#3f3f46" : "#1c1917";
  const withTool = tool ?? mood === "dig";
  const style = {
    width: size,
    height: size,
    "--critter-phase": -phase + "s",
    ...(tempo ? { "--critter-tempo": tempo + "s" } : {}),
  } as CSSProperties;
  const classes = [
    "critter",
    "is-" + mood,
    still ? "is-still" : "",
    squish ? "is-squish" : "",
    className,
  ].filter(Boolean).join(" ");
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
      {(mood === "busy" || mood === "dig") && !still && <span className="critter-shadow" />}
      <svg className="critter-svg" viewBox="0 0 100 100" focusable="false">
        <g className="critter-body">
          {withTool && (
            <g className="critter-tool">
              <line x1="80" y1="64" x2="96" y2="22" stroke="#8d6e4f" strokeWidth="6" strokeLinecap="round" />
              <path d="M78 22 Q96 8 114 26" fill="none" stroke="#d4d4d8" strokeWidth="7" strokeLinecap="round" />
            </g>
          )}
          <path d={s.d} fill={color} />
          <path d={s.d} fill="url(#critter-sheen)" opacity=".5" />
          <g className="critter-eyes">
            <g transform={"rotate(-10 " + ex + " " + ey + ")"}>
              <rect className="critter-eye" x={ex - 2.8} y={ey - 6.5} width="5.6" height="13" rx="2.8" fill={eye} />
            </g>
            <g transform={"rotate(10 " + (ex + 12) + " " + ey + ")"}>
              <rect className="critter-eye" x={ex + 9.2} y={ey - 6.5} width="5.6" height="13" rx="2.8" fill={eye} />
            </g>
          </g>
          {withTool && <circle className="critter-hand" cx="80" cy="64" r="6" fill={color} />}
        </g>
      </svg>
      {mood === "dig" && !still && (
        <span className="critter-sparks">
          <i /><i /><i />
        </span>
      )}
    </span>
  );
}

/**
 * Shared SVG defs (the soft top-left sheen every critter wears). Rendered once near the root so
 * each critter can reference it by id instead of repeating a gradient per instance.
 */
export function CritterDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <radialGradient id="critter-sheen" cx="30%" cy="22%" r="70%">
          <stop offset="0" stopColor="#ffffff" stopOpacity=".55" />
          <stop offset=".45" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity=".22" />
        </radialGradient>
      </defs>
    </svg>
  );
}
