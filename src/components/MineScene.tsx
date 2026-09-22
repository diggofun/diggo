/**
 * The mine, drawn as layers that grow with the crew tier (spec 72).
 *
 * Everything is a pure function of the tier: more galleries, more miners, drills from tier 2, ore
 * carts from tier 2, deeper shafts from tier 4 and surface buildings from tier 3. There is no
 * randomness anywhere in this file — the picture reports progression, it does not roll anything.
 */

export interface MineSceneProps {
  /** Crew tier, 1..6 (see DIGGO_CONFIG.crew.tiers). */
  tier: number;
  /** True while the crew is inside an activation window, which animates the working layers. */
  active?: boolean;
  /** Compact renders the same layers in the small dashboard card. */
  compact?: boolean;
  /** Optional caption (the crew tier name) pinned to the top-left of the scene. */
  label?: string;
}

interface Miner {
  x: number;
  y: number;
}

export function MineScene({ tier, active = false, compact = false, label }: MineSceneProps) {
  const level = Math.max(1, Math.min(6, Math.round(tier) || 1));
  const galleries = level;
  const miners: Miner[] = Array.from({ length: Math.min(3 + level, 9) }, (_, index) => ({
    x: 22 + ((index * 37 + level * 11) % 250),
    y: 62 + ((index * 23 + level * 7) % Math.max(1, galleries * 22)),
  }));
  const drills = level >= 2 ? Math.min(level - 1, 4) : 0;
  const carts = Math.min(1 + Math.floor(level / 2), 4);
  const buildings = level >= 3 ? Math.min(level - 2, 4) : 0;
  const deepShafts = level >= 4 ? level - 3 : 0;
  const elevatorHeight = 20 + level * 6;
  // Ore veins in the rock: fixed positions, more of them visible as the mine goes deeper.
  const veins = [
    [64, 88], [214, 76], [100, 128], [246, 140], [40, 170], [180, 182], [284, 112], [118, 190],
  ].slice(0, 3 + level);

  return (
    <div
      className={`mine-diorama${compact ? " mine-diorama-compact" : ""}${active ? " is-working" : " is-idle"}`}
      data-tier={level}
      aria-hidden="true"
    >
      <svg viewBox="0 0 320 200" role="presentation" preserveAspectRatio="xMidYMid slice">
        <defs>
          <linearGradient id="diggo-sky" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#3b3d33" />
            <stop offset="1" stopColor="#24251f" />
          </linearGradient>
          <linearGradient id="diggo-earth" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#23241e" />
            <stop offset="1" stopColor="#141510" />
          </linearGradient>
        </defs>

        <rect className="diorama-sky" x="0" y="0" width="320" height="42" fill="url(#diggo-sky)" />
        <circle className="diorama-sun" cx={active ? 236 : 62} cy={14} r={7} />
        <path className="diorama-hills" d="M0 40 L30 30 L58 38 L92 26 L128 38 L170 29 L210 38 L250 31 L280 39 L320 33 L320 42 L0 42 Z" />
        <rect className="diorama-earth" x="0" y="42" width="320" height="158" fill="url(#diggo-earth)" />
        <rect className="diorama-surface" x="0" y="40" width="320" height="4" />

        {veins.map(([x, y], index) => (
          <path className="diorama-vein" key={`vein-${index}`} d={`M${x} ${y - 4} l4 4 l-4 4 l-4 -4 z`} style={{ animationDelay: `${index * 0.4}s` }} />
        ))}

        {/* Surface buildings appear once the operation is big enough to need them. */}
        {Array.from({ length: buildings }, (_, index) => (
          <g className="diorama-building" key={`building-${index}`}>
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
            <line key={`rung-${index}`} x1={136} y1={60 + index * 16} x2={142} y2={60 + index * 16} />
          ))}
          <line x1={136} y1={58} x2={136} y2={60 + 8 * 16} />
          <line x1={142} y1={58} x2={142} y2={60 + 8 * 16} />
        </g>

        {/* One gallery per crew tier, cut to both sides of the shaft. */}
        {Array.from({ length: galleries }, (_, index) => {
          const y = 58 + index * 22;
          return (
            <g className="diorama-gallery" key={`gallery-${index}`}>
              <rect x={20} y={y} width={112} height={13} />
              <rect x={158} y={y} width={112} height={13} />
              <rect className="diorama-gallery-rail" x={20} y={y + 11} width={112} height={2} />
              <rect className="diorama-gallery-rail" x={158} y={y + 11} width={112} height={2} />
              <circle className="diorama-lamp" cx={30} cy={y + 3} r={1.6} style={{ animationDelay: `${index * 0.3}s` }} />
              <circle className="diorama-lamp" cx={262} cy={y + 3} r={1.6} style={{ animationDelay: `${index * 0.3 + 0.15}s` }} />
            </g>
          );
        })}

        {/* Deeper shafts branch off once the crew is in the Deep Mine Division. */}
        {Array.from({ length: deepShafts }, (_, index) => (
          <rect
            className="diorama-deep-shaft"
            key={`deep-${index}`}
            x={36 + index * 70}
            y={58 + galleries * 22}
            width={12}
            height={Math.max(10, 158 - (58 + galleries * 22))}
          />
        ))}

        {/* Ore carts ride the galleries; a cart is logistics, never extra mining power. */}
        {Array.from({ length: carts }, (_, index) => (
          <g className="diorama-cart" key={`cart-${index}`}>
            <rect x={28 + index * 34} y={58 + (index % galleries) * 22 - 9} width={18} height={9} />
            <circle cx={32 + index * 34} cy={58 + (index % galleries) * 22} r={2.4} />
            <circle cx={42 + index * 34} cy={58 + (index % galleries) * 22} r={2.4} />
          </g>
        ))}

        {/* Drills chew at the face of a gallery each. */}
        {Array.from({ length: drills }, (_, index) => (
          <g className="diorama-drill" key={`drill-${index}`}>
            <rect x={196 + index * 20} y={58 + ((index + 1) % galleries) * 22 + 2} width={13} height={5} />
            <path d={`M${209 + index * 20} ${58 + ((index + 1) % galleries) * 22 + 2} l7 2.5 l-7 2.5 z`} />
            <circle className="diorama-dust" cx={218 + index * 20} cy={58 + ((index + 1) % galleries) * 22 + 4} r={1.4} />
            <circle className="diorama-dust diorama-dust-late" cx={219 + index * 20} cy={58 + ((index + 1) % galleries) * 22 + 3} r={1} />
          </g>
        ))}

        {/* The crew itself: one miner per layer, spread over the galleries and benches. */}
        {miners.map((miner, index) => (
          <g className="diorama-miner" key={`miner-${index}`} style={{ animationDelay: `${(index % 5) * 0.18}s` }}>
            <circle cx={miner.x} cy={miner.y - 8} r={2.6} />
            <rect x={miner.x - 2.6} y={miner.y - 5} width={5.2} height={7} />
            <line x1={miner.x + 4} y1={miner.y - 6} x2={miner.x + 9} y2={miner.y - 11} />
          </g>
        ))}
      </svg>
      {label && <span className="diorama-label">T{level} · {label}</span>}
      {active ? <span className="diorama-shift">SHIFT ACTIVE</span> : <span className="diorama-shift diorama-shift-idle">PAUSED</span>}
    </div>
  );
}
