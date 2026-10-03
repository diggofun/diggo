/**
 * The crew's mine at a given tier, drawn as bots at their rocks (src/components/BotMine.tsx).
 *
 * Everything is a pure function of the tier: a bigger crew tier puts more bots on shift. There is
 * no randomness anywhere in this file - the picture reports progression, it does not roll anything.
 */
import { BotMine, Gem } from "./BotMine";

export interface MineSceneProps {
  /** Crew tier, 1..6 (see DIGGO_CONFIG.crew.tiers). */
  tier: number;
  /** True while the crew is inside an activation window, which sets the bots to work. */
  active?: boolean;
  /** Compact renders the same scene shorter, for dashboard cards. */
  compact?: boolean;
}

/** Bots on shift at a tier: four at the first tier, one more per tier, nine at most. */
export function crewOnShift(tier: number): number {
  const level = Math.max(1, Math.min(6, Math.round(tier) || 1));
  return Math.min(3 + level, 9);
}

export function MineScene({ tier, active = false, compact = false }: MineSceneProps) {
  return (
    <BotMine
      crew={crewOnShift(tier)}
      active={active}
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
