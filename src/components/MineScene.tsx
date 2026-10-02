/**
 * The mine, drawn as layers that grow with the crew tier (spec 72).
 *
 * Everything is a pure function of the tier: more miners, drills from tier 2, ore carts from tier 2,
 * surface storage from tier 3 and a foreman once the operation is worth supervising. There is no
 * randomness anywhere in this file - the picture reports progression, it does not roll anything.
 *
 * The scene stands on public/assets/game/mine-bg.webp: a flat 16:9 cross-section with an empty sky,
 * three dark tunnel bands cut through the rock and a headframe at the far left. The crew and the
 * machines are the sprites from the same folder, placed on the floor of a band or on the ground
 * line and sized from their own alpha bounding box (SPRITE_ART), so a miner and a cart read at the
 * size they were drawn rather than at the size of their transparent canvas. The box keeps the
 * illustration's 16:9 ratio on every screen and nothing is ever cropped, which is why a percentage
 * in this file is a percentage of the drawing itself. When a file is missing the SVG below draws the
 * same scene in the same colours, so nothing here waits on a network request to make sense.
 *
 * Equipped cosmetics (src/components/CosmeticsScreen.tsx) are cosmetic only: a theme filters the
 * whole scene layer at once and an outfit, cart or pickaxe colours the frame, so no cosmetic can
 * touch Mining Power, ORE or discovery odds.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DiscoveryRarity } from "../../shared/config";
import { Bot, botAt } from "./Bot";

/* ------------------------------------------------------------------------------------------------
   Generated game art
   ------------------------------------------------------------------------------------------------ */

export const GAME_ART_BASE = "/assets/game/";

/**
 * Discovery art is named after the visual event the server reports, not after the rarity, so the
 * mapping lives here with the rest of the art contract. Unknown or future rarities simply get no
 * image and keep the drawn rarity tag.
 */
const DISCOVERY_ART: Readonly<Record<DiscoveryRarity, string>> = {
  common: "discovery-stone",
  uncommon: "discovery-meme-vein",
  rare: "discovery-crystal-vein",
  epic: "discovery-ancient-geode",
  legendary: "discovery-golden-block",
  mythic: "discovery-degen-core",
};

/** File stem for a discovery's rarity, or null when there is no art for it. */
export function discoveryArtName(rarity: string | null | undefined): string | null {
  return DISCOVERY_ART[rarity as DiscoveryRarity] ?? null;
}

/**
 * The art for one discovery, keyed by the rarity the server reported. Renders nothing at all for a
 * rarity without art, which is how every discovery screen keeps its drawn fallback.
 *
 * `eager` is passed straight through to GameArt for callers that are reviewed rather than played:
 * the dev-only gallery holds every sprite on one page, well below the fold, where a lazy image is
 * simply not painted yet when the page is captured.
 */
export function DiscoveryArt({
  rarity,
  className,
  eager = false,
}: {
  rarity: string;
  className: string;
  eager?: boolean;
}) {
  const name = discoveryArtName(rarity);
  if (!name) return null;
  return (
    <GameArt
      name={name}
      alt={rarity + " discovery art"}
      width={512}
      height={512}
      className={className}
      eager={eager}
    />
  );
}

const artProbes = new Map<string, Promise<string | null>>();

/**
 * Resolves a file stem such as "mine-bg" or "discovery-rare" to the art file that actually exists,
 * preferring the smaller .webp and falling back to .png. The answer is cached per name, so every
 * instance on the page shares one probe, and a missing file is never requested twice.
 */
export function resolveGameArt(name: string): Promise<string | null> {
  let probe = artProbes.get(name);
  if (!probe) {
    probe = firstAvailable([GAME_ART_BASE + name + ".webp", GAME_ART_BASE + name + ".png"]);
    artProbes.set(name, probe);
  }
  return probe;
}

function firstAvailable(candidates: readonly string[]): Promise<string | null> {
  return candidates.reduce<Promise<string | null>>(
    (chain, source) => chain.then(async (found) => found ?? ((await probeImage(source)) ? source : null)),
    Promise.resolve<string | null>(null),
  );
}

function probeImage(source: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") {
      resolve(false);
      return;
    }
    const image = new Image();
    image.onload = () => resolve(true);
    image.onerror = () => resolve(false);
    image.src = source;
  });
}

export interface GameArtProps {
  /** File stem under /assets/game, e.g. "mine-bg" or "discovery-legendary". Give the component a new
   * key when it should show a different file. */
  name: string;
  /** Empty for decorative art that repeats a label the surrounding markup already carries. */
  alt: string;
  /** Intrinsic size, so the layout is stable before the file arrives. */
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
  /** True only for art above the fold (the header lockup); everything else stays lazy. */
  eager?: boolean;
  /** Rendered instead of the image while it is being resolved and when the file is missing. */
  fallback?: ReactNode;
  /** Fires once the art is painted, or once it turns out to be unavailable. */
  onAvailable?(available: boolean): void;
}

/**
 * One image from public/assets/game, with the app's own CSS/SVG as its fallback. Images are lazy
 * and decoded off the main thread, and nothing renders until the file is known to exist, so a
 * missing asset costs one probe and no broken image icon.
 */
export function GameArt({
  name,
  alt,
  width,
  height,
  className = "",
  style,
  eager = false,
  fallback = null,
  onAvailable,
}: GameArtProps) {
  const [source, setSource] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const notify = useRef(onAvailable);

  useEffect(() => {
    notify.current = onAvailable;
  }, [onAvailable]);

  useEffect(() => {
    let live = true;
    void resolveGameArt(name).then((found) => {
      if (!live) return;
      if (found) setSource(found);
      else {
        setFailed(true);
        notify.current?.(false);
      }
    });
    return () => {
      live = false;
    };
  }, [name]);

  // A cached image can finish before React attaches its handlers, so the ref is checked too.
  useEffect(() => {
    const image = imageRef.current;
    if (image?.complete && image.naturalWidth > 0) {
      setLoaded(true);
      notify.current?.(true);
      if (eager) void image.decode?.().catch(() => undefined);
    }
  }, [source, eager]);

  if (failed || !source) return <>{fallback}</>;

  return (
    <img
      ref={imageRef}
      className={"game-art " + className + (loaded ? " is-loaded" : "")}
      src={source}
      alt={alt}
      width={width}
      height={height}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
      style={style}
      onLoad={() => {
        // Eager art is decoded here rather than left to decode-on-paint. A caller that is reviewed
        // as a whole page (the gallery) holds every sprite at once, most of them off screen, and an
        // image whose decode is still deferred is an empty box in a full-page capture even though
        // the file has already arrived.
        if (eager) void imageRef.current?.decode?.().catch(() => undefined);
        setLoaded(true);
        notify.current?.(true);
      }}
      onError={() => {
        setFailed(true);
        notify.current?.(false);
      }}
    />
  );
}

/* ------------------------------------------------------------------------------------------------
   Cosmetics - colour only
   ------------------------------------------------------------------------------------------------ */

/**
 * The colours an equipped cosmetic set contributes to the scene. Every field is a CSS colour and
 * nothing else: there is no field here that a game rule could read.
 */
export interface MineLook {
  minerBody: string;
  minerHelmet: string;
  minerTool: string;
  cartBody: string;
  cartWheel: string;
  skyTop: string;
  skyLow: string;
  earthTop: string;
  earthLow: string;
  hills: string;
  vein: string;
  lamp: string;
  /** The lamp while the crew is working; themes light their own colour. */
  lampLit: string;
  /**
   * A CSS filter for the whole scene layer - illustration, crew and machines together - so a theme
   * recolours the picture evenly instead of tinting one layer on top of another.
   */
  sceneFilter: string;
  /** The cosmetic's own colour, carried by the scene's frame and by the shift badge. */
  accent: string;
}

const OUTFITS: Readonly<Record<string, Pick<MineLook, "minerBody" | "minerHelmet">>> = {
  outfit_canvas: { minerBody: "#ff6138", minerHelmet: "#e7e9dd" },
  outfit_steel: { minerBody: "#9aa0a6", minerHelmet: "#e7e9dd" },
  outfit_gilded: { minerBody: "#d4a017", minerHelmet: "#ffe9a8" },
  outfit_legendary: { minerBody: "#7657ff", minerHelmet: "#ffb627" },
  outfit_neon: { minerBody: "#39ff88", minerHelmet: "#d7ff3f" },
};

const PICKAXES: Readonly<Record<string, string>> = {
  pickaxe_rusted: "#8d8f82",
  pickaxe_iron: "#c9cbbd",
  pickaxe_diamond: "#58a6ff",
  pickaxe_plasma: "#d7ff3f",
  pickaxe_chrome: "#e7e9dd",
};

const CARTS: Readonly<Record<string, Pick<MineLook, "cartBody" | "cartWheel">>> = {
  cart_standard: { cartBody: "#d7ff3f", cartWheel: "#d7ff3f" },
  cart_rail: { cartBody: "#58a6ff", cartWheel: "#58a6ff" },
  cart_hauler: { cartBody: "#ffb627", cartWheel: "#ffb627" },
  cart_hover: { cartBody: "#a07bff", cartWheel: "#a07bff" },
};

const THEMES: Readonly<Record<string, Partial<MineLook>>> = {
  theme_standard: {},
  theme_sunset: {
    skyTop: "#7a3b2e",
    skyLow: "#3a1f2a",
    earthTop: "#3a2622",
    earthLow: "#1d1310",
    hills: "#4a2c2c",
    vein: "#ffb627",
    lamp: "#6a4a3a",
    lampLit: "#ff8a4c",
    sceneFilter: "sepia(.35) saturate(1.4) hue-rotate(-18deg) brightness(1.04)",
  },
  theme_arcane: {
    skyTop: "#2b2350",
    skyLow: "#171334",
    earthTop: "#241f45",
    earthLow: "#120f24",
    hills: "#332a5c",
    vein: "#a07bff",
    lamp: "#4a4470",
    lampLit: "#c9b6ff",
    sceneFilter: "hue-rotate(215deg) saturate(1.15) brightness(.95)",
  },
  theme_deepcore: {
    skyTop: "#0f1b1e",
    skyLow: "#0a1113",
    earthTop: "#101a1c",
    earthLow: "#060b0c",
    hills: "#16262a",
    vein: "#39ffd0",
    lamp: "#1e3a3a",
    lampLit: "#7ff0d8",
    sceneFilter: "hue-rotate(150deg) saturate(1.25) brightness(.84)",
  },
};

const DEFAULT_LOOK: MineLook = {
  minerBody: "#ff6138",
  minerHelmet: "#e7e9dd",
  minerTool: "#e7e9dd",
  cartBody: "#d7ff3f",
  cartWheel: "#d7ff3f",
  skyTop: "#3b3d33",
  skyLow: "#24251f",
  earthTop: "#23241e",
  earthLow: "#141510",
  hills: "#2c2e25",
  vein: "rgba(215,255,63,.55)",
  lamp: "#5a5c50",
  lampLit: "#ffd76a",
  // Empty on purpose: the illustration is finished art and takes no filter of its own.
  sceneFilter: "",
  accent: "var(--acid)",
};

/**
 * Turns the server's equipped map (slot -> cosmetic id) into colours. Unknown ids and unequipped
 * slots keep the default palette, and the slot keys come from shared/social.ts.
 */
export function mineLookFromEquipped(equipped: Readonly<Record<string, string>> | undefined): MineLook {
  const outfit = OUTFITS[equipped?.outfit ?? ""] ?? {};
  const cart = CARTS[equipped?.cart ?? ""] ?? {};
  const pickaxe = PICKAXES[equipped?.pickaxe ?? ""];
  const theme = THEMES[equipped?.mine_theme ?? ""] ?? {};
  return {
    ...DEFAULT_LOOK,
    ...outfit,
    cartBody: cart.cartBody ?? DEFAULT_LOOK.cartBody,
    cartWheel: cart.cartWheel ?? DEFAULT_LOOK.cartWheel,
    minerTool: pickaxe ?? DEFAULT_LOOK.minerTool,
    ...theme,
    // The first equipped slot that carries a colour paints the scene's frame.
    accent: outfit.minerBody ?? cart.cartBody ?? pickaxe ?? DEFAULT_LOOK.accent,
  };
}

/* ------------------------------------------------------------------------------------------------
   The scene
   ------------------------------------------------------------------------------------------------ */

export interface MineSceneProps {
  /** Crew tier, 1..6 (see DIGGO_CONFIG.crew.tiers). */
  tier: number;
  /** True while the crew is inside an activation window, which animates the working layers. */
  active?: boolean;
  /** Compact renders the same scene in the dashboard card, without the tier caption. */
  compact?: boolean;
  /** Optional caption (the crew tier name) pinned to the top-left of the scene. */
  label?: string;
  /** The equipped cosmetics map (slot -> id); visual only. */
  cosmetics?: Readonly<Record<string, string>>;
}

/**
 * The scene box keeps the 16:9 ratio of the illustration everywhere, the compact dashboard card
 * included, so a percentage below is always a percentage of the drawing and nothing is cropped.
 */
const SCENE_ASPECT = 16 / 9;

/**
 * Anchors measured from public/assets/game/mine-bg.webp (1920x1080): the off-white sky ends at
 * 30.2% of the height, the three dark tunnel bands are cut at 54.6-57.6%, 73.2-76.2% and
 * 89.7-92.4%, and the headframe with its shaft owns the far-left 9% of the width. People and
 * machines stand on the floor of a band, so the bottom edge of each band is the anchor.
 */
const GROUND_Y = 0.302;
const BAND_FLOORS = [0.576, 0.762, 0.924] as const;
/** A row keeps clear of the headframe on the left and of the frame on the right. */
const ROW_LEFT = 0.14;
const ROW_RIGHT = 0.92;

type SpriteKind = "miner" | "foreman" | "cart" | "drill" | "storage";

interface SpriteArt {
  /** File stem under /assets/game. */
  name: string;
  /** Alpha bounding box of the square file, as fractions of its canvas. */
  bx: number;
  bw: number;
  by: number;
  bh: number;
  /** How tall the sprite's own ink should read, as a fraction of the scene height. */
  ink: number;
}

/**
 * Every sprite file is 768x768 with a different amount of empty canvas around the subject: the
 * miner fills 65% of its width, the cart 84% and the storage 54% of its height. Giving them all one
 * CSS width is what made equal sprites look unequal on screen, so each one is sized from its own
 * bounding box and lands at the optical height in "ink".
 */
const SPRITE_ART: Readonly<Record<SpriteKind, SpriteArt>> = {
  miner: { name: "miner", bx: 0.1745, bw: 0.6497, by: 0.0794, bh: 0.8411, ink: 0.16 },
  foreman: { name: "foreman", bx: 0.3385, bw: 0.3216, by: 0.0794, bh: 0.8398, ink: 0.16 },
  cart: { name: "cart", bx: 0.0794, bw: 0.8398, by: 0.0833, bh: 0.832, ink: 0.115 },
  drill: { name: "drill", bx: 0.0794, bw: 0.8398, by: 0.1784, bh: 0.6432, ink: 0.105 },
  storage: { name: "storage", bx: 0.0794, bw: 0.8398, by: 0.2318, bh: 0.5365, ink: 0.15 },
};

/** One sprite's place in the scene, in percentages of the scene box. */
interface Placement {
  key: string;
  kind: SpriteKind;
  left: string;
  top: string;
  width: string;
  delay: string;
}

/**
 * Places a sprite so that the bottom of its ink sits on "floor" (a fraction of the scene height)
 * and its ink is centred on "center" (a fraction of the width). The box is the sprite's whole
 * canvas, so the offsets absorb the empty margins of the file instead of moving the subject.
 */
function place(kind: SpriteKind, key: string, center: number, floor: number, delay = "0s"): Placement {
  const art = SPRITE_ART[kind];
  const height = art.ink / art.bh; // the canvas, as a fraction of the scene height
  const width = height / SCENE_ASPECT; // the same canvas, as a fraction of the scene width
  return {
    key,
    kind,
    left: ((center - (art.bx + art.bw / 2) * width) * 100).toFixed(3) + "%",
    top: ((floor - (art.by + art.bh) * height) * 100).toFixed(3) + "%",
    width: (width * 100).toFixed(3) + "%",
    delay,
  };
}

/** Splits a count across the bands as evenly as possible, filling the shallowest band first. */
function deals(count: number, bands: number): number[] {
  const base = Math.floor(count / bands);
  const extra = count % bands;
  return Array.from({ length: bands }, (_, index) => base + (index < extra ? 1 : 0));
}

/**
 * Miners with the machines of one gallery spread between them, so a cart or a drill is never
 * bunched at one end of a row.
 */
function interleave(miners: number, machines: readonly SpriteKind[]): SpriteKind[] {
  const total = miners + machines.length;
  const row: (SpriteKind | null)[] = Array.from({ length: total }, () => null);
  const taken = new Set<number>();
  machines.forEach((kind, index) => {
    let slot = Math.round(((index + 1) * total) / (machines.length + 1)) - 1;
    slot = Math.max(0, Math.min(total - 1, slot));
    while (taken.has(slot)) slot = (slot + 1) % total;
    taken.add(slot);
    row[slot] = kind;
  });
  return row.map((kind) => kind ?? "miner");
}

/** One gallery: its crew and machines, spaced across the clear width of the scene. */
function bandRow(kinds: readonly SpriteKind[], floor: number, depth: number): Placement[] {
  if (kinds.length === 0) return [];
  const share = (ROW_RIGHT - ROW_LEFT) / kinds.length;
  return kinds.map((kind, index) =>
    place(
      kind,
      kind + "-" + depth + "-" + index,
      ROW_LEFT + share * (index + 0.5),
      floor,
      ((index + depth) % 4) * 0.22 + "s",
    ),
  );
}

/**
 * Ore veins in the rock of the drawn fallback, in its own 320x200 coordinates: fixed positions,
 * more of them visible as the mine goes deeper.
 */
const VEINS = [
  [64, 88], [214, 76], [100, 128], [246, 140], [40, 170], [180, 182], [284, 112], [118, 190],
] as const satisfies readonly (readonly [number, number])[];

export function MineScene({ tier, active = false, compact = false, label, cosmetics }: MineSceneProps) {
  const level = Math.max(1, Math.min(6, Math.round(tier) || 1));
  const galleries = level;
  const miners = Math.min(3 + level, 9);
  const drills = level >= 2 ? Math.min(level - 1, 4) : 0;
  const carts = Math.min(1 + Math.floor(level / 2), 4);
  const storages = level >= 3 ? Math.min(level - 2, 4) : 0;
  const hasForeman = level >= 3;
  const deepShafts = level >= 4 ? level - 3 : 0;
  const elevatorHeight = 20 + level * 6;
  const veins = VEINS.slice(0, 3 + level);

  const look = mineLookFromEquipped(cosmetics);

  // The illustration is the scene; the SVG is only what the app draws when the file is missing.
  const [bgArt, setBgArt] = useState(false);

  // The crew and the machines are placed against the illustration's own anchors, and they ride with
  // it alone: half a download can never mix the two coordinate systems.
  const crew: Placement[] = [];
  if (hasForeman) crew.push(place("foreman", "foreman", 0.16, GROUND_Y));
  for (let index = 0; index < storages; index++) {
    const center = storages === 1 ? 0.4 : 0.3 + (index * 0.6) / (storages - 1);
    crew.push(place("storage", "storage-" + index, center, GROUND_Y, index * 0.3 + "s"));
  }
  const minersPerBand = deals(miners, BAND_FLOORS.length);
  const cartsPerBand = deals(carts, BAND_FLOORS.length);
  const drillsPerBand = deals(drills, BAND_FLOORS.length);
  BAND_FLOORS.forEach((floor, depth) => {
    const machines: SpriteKind[] = [
      ...Array.from({ length: cartsPerBand[depth] }, () => "cart" as SpriteKind),
      ...Array.from({ length: drillsPerBand[depth] }, () => "drill" as SpriteKind),
    ];
    crew.push(...bandRow(interleave(minersPerBand[depth], machines), floor, depth));
  });

  const sceneClass = [
    "mine-diorama",
    compact ? "mine-diorama-compact" : "",
    active ? "is-working" : "is-idle",
    bgArt ? "has-art-bg" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const lookVars = {
    "--diorama-sky-top": look.skyTop,
    "--diorama-sky-low": look.skyLow,
    "--diorama-earth-top": look.earthTop,
    "--diorama-earth-low": look.earthLow,
    "--diorama-hills": look.hills,
    "--diorama-vein": look.vein,
    "--diorama-lamp": look.lamp,
    "--diorama-lamp-lit": look.lampLit,
    "--diorama-miner-body": look.minerBody,
    "--diorama-miner-helmet": look.minerHelmet,
    "--diorama-miner-tool": look.minerTool,
    "--diorama-cart-body": look.cartBody,
    "--diorama-cart-wheel": look.cartWheel,
    "--diorama-scene-filter": look.sceneFilter,
    "--diorama-accent": look.accent,
  } as CSSProperties;

  return (
    <div className={sceneClass} data-tier={level} style={lookVars} aria-hidden="true">
      <div className="diorama-stage">
        <svg className="diorama-svg" viewBox="0 0 320 200" role="presentation" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="diggo-sky" x1="0" y1="0" x2="0" y2="1">
              <stop className="diorama-sky-top" offset="0" />
              <stop className="diorama-sky-low" offset="1" />
            </linearGradient>
            <linearGradient id="diggo-earth" x1="0" y1="0" x2="0" y2="1">
              <stop className="diorama-earth-top" offset="0" />
              <stop className="diorama-earth-low" offset="1" />
            </linearGradient>
          </defs>

          <rect className="diorama-sky" x="0" y="0" width="320" height="42" fill="url(#diggo-sky)" />
          <circle className="diorama-sun" cx={active ? 236 : 62} cy={14} r={7} />
          <path className="diorama-hills" d="M0 40 L30 30 L58 38 L92 26 L128 38 L170 29 L210 38 L250 31 L280 39 L320 33 L320 42 L0 42 Z" />
          <rect className="diorama-earth" x="0" y="42" width="320" height="158" fill="url(#diggo-earth)" />
          <rect className="diorama-surface" x="0" y="40" width="320" height="4" />

          {veins.map(([x, y], index) => (
            <path className="diorama-vein" key={"vein-" + index} d={"M" + x + " " + (y - 4) + " l4 4 l-4 4 l-4 -4 z"} style={{ animationDelay: index * 0.4 + "s" }} />
          ))}

          {/* Surface buildings appear once the operation is big enough to need them. */}
          {Array.from({ length: storages }, (_, index) => (
            <g className="diorama-building" key={"building-" + index}>
              <rect x={10 + index * 30} y={40 - (12 + index * 2)} width={22} height={12 + index * 2} />
              <rect className="diorama-building-roof" x={8 + index * 30} y={40 - (14 + index * 2)} width={26} height={3} />
              <rect className="diorama-window" x={15 + index * 30} y={40 - (8 + index * 2)} width={4} height={4} />
              <rect className="diorama-window" x={23 + index * 30} y={40 - (8 + index * 2)} width={4} height={4} />
            </g>
          ))}

          {/* The elevator tower rises with the tier; the cab rides it while the crew is active. */}
          <g className="diorama-elevator">
            <rect className="diorama-tower" x={286} y={40 - elevatorHeight} width={20} height={elevatorHeight} />
            <rect className="diorama-tower-cap" x={282} y={40 - elevatorHeight - 5} width={28} height={5} />
            <rect className="diorama-cab" x={290} y={34 - Math.round(elevatorHeight * 0.25)} width={12} height={10} />
            <line className="diorama-cable" x1={296} y1={40 - elevatorHeight - 4} x2={296} y2={34 - Math.round(elevatorHeight * 0.25)} />
          </g>

          {/* Main shaft down the middle of the mine. */}
          <rect className="diorama-shaft" x={132} y={42} width={26} height={156} />
          <g className="diorama-ladder">
            {Array.from({ length: 9 }, (_, index) => (
              <line key={"rung-" + index} x1={136} y1={60 + index * 16} x2={142} y2={60 + index * 16} />
            ))}
            <line x1={136} y1={58} x2={136} y2={60 + 8 * 16} />
            <line x1={142} y1={58} x2={142} y2={60 + 8 * 16} />
          </g>

          {/* One gallery per crew tier, cut to both sides of the shaft. */}
          {Array.from({ length: galleries }, (_, index) => {
            const y = 58 + index * 22;
            return (
              <g className="diorama-gallery" key={"gallery-" + index}>
                <rect x={20} y={y} width={112} height={13} />
                <rect x={158} y={y} width={112} height={13} />
                <rect className="diorama-gallery-rail" x={20} y={y + 11} width={112} height={2} />
                <rect className="diorama-gallery-rail" x={158} y={y + 11} width={112} height={2} />
                <circle className="diorama-lamp" cx={30} cy={y + 3} r={1.6} style={{ animationDelay: index * 0.3 + "s" }} />
                <circle className="diorama-lamp" cx={262} cy={y + 3} r={1.6} style={{ animationDelay: index * 0.3 + 0.15 + "s" }} />
              </g>
            );
          })}

          {/* Deeper shafts branch off once the crew is in the Deep Mine Division. */}
          {Array.from({ length: deepShafts }, (_, index) => (
            <rect
              className="diorama-deep-shaft"
              key={"deep-" + index}
              x={36 + index * 70}
              y={58 + galleries * 22}
              width={12}
              height={Math.max(10, 158 - (58 + galleries * 22))}
            />
          ))}

          {/* Ore carts ride the galleries; a cart is logistics, never extra mining power. */}
          {Array.from({ length: carts }, (_, index) => (
            <g className="diorama-cart" key={"cart-" + index}>
              <rect x={28 + index * 34} y={58 + (index % galleries) * 22 - 9} width={18} height={9} />
              <circle cx={32 + index * 34} cy={58 + (index % galleries) * 22} r={2.4} />
              <circle cx={42 + index * 34} cy={58 + (index % galleries) * 22} r={2.4} />
            </g>
          ))}

          {/* Drills chew at the face of a gallery each. */}
          {Array.from({ length: drills }, (_, index) => (
            <g className="diorama-drill" key={"drill-" + index}>
              <rect x={196 + index * 20} y={58 + ((index + 1) % galleries) * 22 + 2} width={13} height={5} />
              <path d={"M" + (209 + index * 20) + " " + (58 + ((index + 1) % galleries) * 22 + 2) + " l7 2.5 l-7 2.5 z"} />
              <circle className="diorama-dust" cx={218 + index * 20} cy={58 + ((index + 1) % galleries) * 22 + 4} r={1.4} />
              <circle className="diorama-dust diorama-dust-late" cx={219 + index * 20} cy={58 + ((index + 1) % galleries) * 22 + 3} r={1} />
            </g>
          ))}

          {/* The crew itself: one miner per layer, spread over the galleries and benches. */}
          {Array.from({ length: miners }, (_, index) => {
            const x = 22 + ((index * 37 + level * 11) % 250);
            const y = 62 + ((index * 23 + level * 7) % Math.max(1, galleries * 22));
            return (
              <g className="diorama-miner" key={"miner-" + index} style={{ animationDelay: (index % 5) * 0.18 + "s" }}>
                <circle cx={x} cy={y - 8} r={2.6} />
                <rect x={x - 2.6} y={y - 5} width={5.2} height={7} />
                <line x1={x + 4} y1={y - 6} x2={x + 9} y2={y - 11} />
              </g>
            );
          })}
        </svg>

        {/* The illustration, when public/assets/game has one: it fills the box and the drawn scene
            steps aside for it. */}
        <GameArt
          name="mine-bg"
          alt=""
          width={1920}
          height={1080}
          className="diorama-art-bg"
          onAvailable={setBgArt}
        />

        {/* The crew: sprites standing on the tunnel floors and the ground line of the illustration. */}
        {/* Miners and the foreman are bots (src/components/Bot.tsx): each crew member keeps
            the same shape and colour from its slot, and digs only while the shift is active. */}
        {bgArt &&
          crew.filter((spot) => spot.kind === "miner" || spot.kind === "foreman").map((spot, index) => (
            <span
              key={spot.key}
              className={"diorama-bot diorama-bot-" + spot.kind}
              style={{ left: spot.left, top: spot.top, width: spot.width }}
            >
              <Bot
                {...botAt(index)}
                hat={spot.kind === "miner" ? "hardhat" : "crown"}
                size="100%"
                mood={spot.kind === "foreman" ? (active ? "attention" : "idle") : active ? "dig" : "idle"}
                tool={spot.kind === "miner"}
                phase={index * 0.37}
                tempo={1 + (index % 3) * 0.12}
              />
            </span>
          ))}
        {bgArt &&
          crew.filter((spot) => spot.kind !== "miner" && spot.kind !== "foreman").map((spot) => (
            <GameArt
              key={spot.key}
              name={SPRITE_ART[spot.kind].name}
              alt=""
              width={768}
              height={768}
              className={"diorama-sprite diorama-sprite-" + spot.kind}
              style={{ left: spot.left, top: spot.top, width: spot.width, animationDelay: spot.delay }}
            />
          ))}
      </div>

      {/* The caption and the shift state sit on the empty sky, clear of the crew and the machines. */}
      {label && <span className="diorama-label">T{level} · {label}</span>}
      {active ? <span className="diorama-shift">SHIFT ACTIVE</span> : <span className="diorama-shift diorama-shift-idle">PAUSED</span>}
    </div>
  );
}
