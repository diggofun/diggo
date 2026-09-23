/**
 * The mine, drawn as layers that grow with the crew tier (spec 72).
 *
 * Everything is a pure function of the tier: more galleries, more miners, drills from tier 2, ore
 * carts from tier 2, deeper shafts from tier 4 and surface buildings from tier 3. There is no
 * randomness anywhere in this file — the picture reports progression, it does not roll anything.
 *
 * The same scene is also drawn from generated art when it is available (see GameArt below):
 * public/assets/game holds the illustrated mine, the crew sprites and the logo, and every one of
 * them falls back to the SVG that ships with the app, so the scene is never empty and never waits
 * on a network request to make sense. Equipped cosmetics (src/components/CosmeticsScreen.tsx) are
 * applied as colours and tints on top of either drawing; they are purely visual and are read from
 * the server's own equipped map, so nothing here can touch Mining Power, ORE or discovery odds.
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { DiscoveryRarity } from "../../shared/config";
import { playSound } from "../sound";

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
 */
export function DiscoveryArt({ rarity, className }: { rarity: string; className: string }) {
  const name = discoveryArtName(rarity);
  if (!name) return null;
  return (
    <GameArt
      name={name}
      alt={rarity + " discovery art"}
      width={512}
      height={512}
      className={className}
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
  /** File stem under /assets/game, e.g. "logo" or "discovery-legendary". Give the component a new
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
    }
  }, [source]);

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
   Cosmetics — colour only
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
  /** CSS filter applied to the illustrated mine, so a theme also recolours the raster art. */
  artFilter: string;
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
    artFilter: "sepia(.35) saturate(1.4) hue-rotate(-18deg) brightness(1.04)",
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
    artFilter: "hue-rotate(215deg) saturate(1.15) brightness(.95)",
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
    artFilter: "hue-rotate(150deg) saturate(1.25) brightness(.84)",
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
  artFilter: "none",
};

/**
 * Turns the server's equipped map (slot → cosmetic id) into colours. Unknown ids and unequipped
 * slots keep the default palette, and the slot keys come from shared/social.ts.
 */
export function mineLookFromEquipped(equipped: Readonly<Record<string, string>> | undefined): MineLook {
  const outfit = OUTFITS[equipped?.outfit ?? ""] ?? {};
  const cart = CARTS[equipped?.cart ?? ""] ?? {};
  const theme = THEMES[equipped?.mine_theme ?? ""] ?? {};
  return {
    ...DEFAULT_LOOK,
    ...outfit,
    cartBody: cart.cartBody ?? DEFAULT_LOOK.cartBody,
    cartWheel: cart.cartWheel ?? DEFAULT_LOOK.cartWheel,
    minerTool: PICKAXES[equipped?.pickaxe ?? ""] ?? DEFAULT_LOOK.minerTool,
    ...theme,
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
  /** Compact renders the same layers in the small dashboard card. */
  compact?: boolean;
  /** Optional caption (the crew tier name) pinned to the top-left of the scene. */
  label?: string;
  /** The equipped cosmetics map (slot → id); visual only. */
  cosmetics?: Readonly<Record<string, string>>;
}

interface Point {
  x: number;
  y: number;
}

/** A sprite's position and size as percentages of the scene box, ready for CSS. */
interface SpriteSpec {
  left: string;
  top: string;
  width: string;
  delay: string;
}

/**
 * Ore veins in the rock, in the SVG's own 320x200 coordinates: fixed positions, more of them
 * visible as the mine goes deeper.
 */
const VEINS = [
  [64, 88], [214, 76], [100, 128], [246, 140], [40, 170], [180, 182], [284, 112], [118, 190],
] as const satisfies readonly (readonly [number, number])[];

function sprite(x: number, y: number, width: string, delay = "0s"): SpriteSpec {
  return {
    left: ((x / 320) * 100).toFixed(2) + "%",
    top: ((y / 200) * 100).toFixed(2) + "%",
    width,
    delay,
  };
}

export function MineScene({ tier, active = false, compact = false, label, cosmetics }: MineSceneProps) {
  const level = Math.max(1, Math.min(6, Math.round(tier) || 1));
  const galleries = level;
  const miners: Point[] = Array.from({ length: Math.min(3 + level, 9) }, (_, index) => ({
    x: 22 + ((index * 37 + level * 11) % 250),
    y: 62 + ((index * 23 + level * 7) % Math.max(1, galleries * 22)),
  }));
  const drills = level >= 2 ? Math.min(level - 1, 4) : 0;
  const carts = Math.min(1 + Math.floor(level / 2), 4);
  const buildings = level >= 3 ? Math.min(level - 2, 4) : 0;
  const deepShafts = level >= 4 ? level - 3 : 0;
  const elevatorHeight = 20 + level * 6;
  const veins = VEINS.slice(0, 3 + level);

  const look = mineLookFromEquipped(cosmetics);

  // Sprites grow a little with the tier, so a deeper mine reads as a bigger operation.
  const spriteWidth = (base: number) => (base * (0.88 + level * 0.05)).toFixed(2) + "%";

  // Which generated files actually exist; the SVG draws anything that is missing.
  const [art, setArt] = useState<Readonly<Record<string, boolean>>>({});
  const markArt = useCallback((key: string, available: boolean) => {
    setArt((current) => (current[key] === available ? current : { ...current, [key]: available }));
  }, []);

  // The activation cue belongs to the moment the shift starts, not to every render of the scene.
  const wasActive = useRef(active);
  useEffect(() => {
    if (active && !wasActive.current) playSound("activate");
    wasActive.current = active;
  }, [active]);

  const showSvg = !art["mine-bg"];
  const sceneClass = [
    "mine-diorama",
    compact ? "mine-diorama-compact" : "",
    active ? "is-working" : "is-idle",
    art["mine-bg"] ? "has-art-bg" : "",
    art.miner ? "has-art-miner" : "",
    art.drill ? "has-art-drill" : "",
    art.cart ? "has-art-cart" : "",
    art.storage ? "has-art-storage" : "",
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
    "--diorama-art-filter": look.artFilter,
    // Deeper mines read as bigger: a small, purely decorative zoom that grows with the tier.
    "--tier-zoom": (1 + (level - 1) * 0.015).toFixed(3),
  } as CSSProperties;

  return (
    <div className={sceneClass} data-tier={level} style={lookVars} aria-hidden="true">
      {showSvg && (
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
          {Array.from({ length: buildings }, (_, index) => (
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
          {miners.map((miner, index) => (
            <g className="diorama-miner" key={"miner-" + index} style={{ animationDelay: (index % 5) * 0.18 + "s" }}>
              <circle cx={miner.x} cy={miner.y - 8} r={2.6} />
              <rect x={miner.x - 2.6} y={miner.y - 5} width={5.2} height={7} />
              <line x1={miner.x + 4} y1={miner.y - 6} x2={miner.x + 9} y2={miner.y - 11} />
            </g>
          ))}
        </svg>
      )}

      {/* The illustrated mine, when public/assets/game has one: it covers the SVG drawing and the
          SVG is dropped as soon as the image has painted. */}
      <GameArt
        name="mine-bg"
        alt=""
        width={1672}
        height={941}
        className="diorama-art-bg"
        onAvailable={(available) => markArt("mine-bg", available)}
      />

      {/* Crew sprites replace the drawn figures when the art exists, and carry the equipped
          outfit and cart colours as a tint. */}
      {miners.map((miner, index) => {
        const spot = sprite(miner.x, miner.y, spriteWidth(6.5), (index % 5) * 0.18 + "s");
        return (
          <Sprite
            key={"sprite-miner-" + index}
            name="miner"
            alt=""
            className="diorama-sprite-miner"
            left={spot.left}
            top={spot.top}
            width={spot.width}
            delay={spot.delay}
            tint={look.minerBody}
            onAvailable={(available) => markArt("miner", available)}
          />
        );
      })}
      {Array.from({ length: drills }, (_, index) => {
        const spot = sprite(196 + index * 20, 58 + ((index + 1) % galleries) * 22 + 4, spriteWidth(7));
        return (
          <Sprite
            key={"sprite-drill-" + index}
            name="drill"
            alt=""
            className="diorama-sprite-drill"
            left={spot.left}
            top={spot.top}
            width={spot.width}
            onAvailable={(available) => markArt("drill", available)}
          />
        );
      })}
      {Array.from({ length: carts }, (_, index) => {
        const spot = sprite(28 + index * 34, 58 + (index % galleries) * 22, spriteWidth(7.5));
        return (
          <Sprite
            key={"sprite-cart-" + index}
            name="cart"
            alt=""
            className="diorama-sprite-cart"
            left={spot.left}
            top={spot.top}
            width={spot.width}
            tint={look.cartBody}
            onAvailable={(available) => markArt("cart", available)}
          />
        );
      })}
      {/* Storage is the surface building; the foreman only appears on a large operation. */}
      {Array.from({ length: buildings }, (_, index) => {
        const spot = sprite(12 + index * 30, 40, spriteWidth(9));
        return (
          <Sprite
            key={"sprite-storage-" + index}
            name="storage"
            alt=""
            className="diorama-sprite-storage"
            left={spot.left}
            top={spot.top}
            width={spot.width}
            onAvailable={(available) => markArt("storage", available)}
          />
        );
      })}
      {level >= 3 && (
        <Sprite
          name="foreman"
          alt=""
          className="diorama-sprite-foreman"
          left="46%"
          top="40%"
          width={spriteWidth(8)}
        />
      )}

      {label && <span className="diorama-label">T{level} · {label}</span>}
      {active ? <span className="diorama-shift">SHIFT ACTIVE</span> : <span className="diorama-shift diorama-shift-idle">PAUSED</span>}
    </div>
  );
}

/**
 * A single generated sprite placed over the scene. It renders nothing at all when its file is
 * missing, so the SVG figure it stands in for stays visible instead.
 */
function Sprite({
  name,
  alt,
  className,
  left,
  top,
  width,
  delay,
  tint,
  onAvailable,
}: {
  name: string;
  alt: string;
  className: string;
  left: string;
  top: string;
  width: string;
  delay?: string;
  /** CSS colour painted over the sprite's own silhouette to carry an equipped cosmetic. */
  tint?: string;
  onAvailable?(available: boolean): void;
}) {
  const [source, setSource] = useState<string | null>(null);
  const notify = useRef(onAvailable);

  useEffect(() => {
    notify.current = onAvailable;
  }, [onAvailable]);

  useEffect(() => {
    let live = true;
    void resolveGameArt(name).then((found) => {
      if (!live) return;
      setSource(found);
      notify.current?.(found !== null);
    });
    return () => {
      live = false;
    };
  }, [name]);

  if (!source) return null;

  return (
    <span
      className={"diorama-sprite " + className}
      style={{ left, top, width, animationDelay: delay } as CSSProperties}
    >
      <GameArt name={name} alt={alt} width={768} height={768} className="diorama-sprite-art" />
      {tint && (
        <i
          className="diorama-sprite-tint"
          style={{ background: tint, "--sprite-src": 'url("' + source + '")' } as CSSProperties}
        />
      )}
    </span>
  );
}
