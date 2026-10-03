/**
 * The crew's mine at a given tier, drawn as bots at their rocks (src/components/BotMine.tsx).
 *
 * Everything is a pure function of the tier: a bigger crew tier puts more bots on shift. There is
 * no randomness anywhere in this file - the picture reports progression, it does not roll anything.
 *
 * Equipped cosmetics (src/components/CosmeticsScreen.tsx) are cosmetic only: an outfit colours the
 * lead bot, a pickaxe colours every pick head and a mine theme picks the backdrop, so no cosmetic
 * can touch Mining Power, ORE or discovery odds.
 */
import { BotMine, Gem, type MineTheme } from "./BotMine";

const OUTFITS: Readonly<Record<string, string>> = {
  outfit_referral_first: "#14b8a6",
  outfit_canvas: "#ff6a00",
  outfit_steel: "#a1a1aa",
  outfit_gilded: "#eab308",
  outfit_legendary: "#a855f7",
  outfit_neon: "#84cc16",
};

const PICKAXES: Readonly<Record<string, string>> = {
  pickaxe_rusted: "#b07a52",
  pickaxe_iron: "#d4d4d8",
  pickaxe_diamond: "#38bdf8",
  pickaxe_plasma: "#d946ef",
  pickaxe_chrome: "#f4f4f5",
};

const THEMES: Readonly<Record<string, MineTheme>> = {
  theme_standard: "standard",
  theme_sunset: "sunset",
  theme_arcane: "arcane",
  theme_deepcore: "deepcore",
};

export interface MineSceneProps {
  /** Crew tier, 1..6 (see DIGGO_CONFIG.crew.tiers). */
  tier: number;
  /** True while the crew is inside an activation window, which sets the bots to work. */
  active?: boolean;
  /** Compact renders the same scene shorter, for dashboard cards. */
  compact?: boolean;
  /** The equipped cosmetics map (slot -> id); visual only. */
  cosmetics?: Readonly<Record<string, string>>;
}

/** Bots on shift at a tier: four at the first tier, one more per tier, nine at most. */
export function crewOnShift(tier: number): number {
  const level = Math.max(1, Math.min(6, Math.round(tier) || 1));
  return Math.min(3 + level, 9);
}

export function MineScene({ tier, active = false, compact = false, cosmetics }: MineSceneProps) {
  const outfit = cosmetics?.miner_outfit ?? cosmetics?.outfit ?? "";
  return (
    <BotMine
      crew={crewOnShift(tier)}
      active={active}
      leadColor={OUTFITS[outfit]}
      toolColor={PICKAXES[cosmetics?.pickaxe ?? ""]}
      theme={THEMES[cosmetics?.mine_theme ?? ""] ?? "standard"}
      hardHats
      className={compact ? "is-compact" : undefined}
    />
  );
}

/**
 * The art for one discovery, keyed by the rarity the server reported: a drawn rock, crystal or
 * nugget (see Gem in BotMine.tsx). Unknown rarities draw a plain rock.
 */
export function DiscoveryArt({ rarity, className = "" }: { rarity: string; className?: string }) {
  return <Gem rarity={rarity} className={className} />;
}
