/**
 * The mine, drawn with nothing but bots and rocks.
 *
 * Each spot is one bot with something to dig beside it: a rock, a crystal or a gold nugget. While
 * the crew is working every bot runs the work routine from bot.css on its own clock - a few swings
 * at its rock (chips fly, the rock shakes), a pause, a hop, a look the other way - and the clocks
 * differ, so the crew never moves in lockstep. A paused crew stands by its rocks and looks around.
 *
 * Everything is flat and rounded, drawn inline, and purely decorative: the picture never reports a
 * number. Crew size, the pickaxe colour and the backdrop are the only inputs.
 */
import type { CSSProperties } from "react";
import { Bot, BOT_COLORS, botAt, type BotLook } from "./Bot";

export type MineTargetKind = "rock" | "crystal" | "gold";

const ROCK = { body: "#52525b", top: "#71717a" };
const GOLD = { body: "#eab308", top: "#fde047" };

/** A rock, a crystal cluster or a nugget, in a 100x80 box standing on its bottom edge. */
export function MineTarget({ kind, color = "#a855f7" }: { kind: MineTargetKind; color?: string }) {
  if (kind === "crystal") {
    return (
      <svg className="mine-target-art" viewBox="0 0 100 80" aria-hidden="true" focusable="false">
        <path d="M14 76C10 76 8 72 10 68L18 56C20 53 24 52 27 52H74C77 52 80 53 82 56L90 68C92 72 90 76 86 76Z" fill={ROCK.body} stroke={ROCK.body} strokeWidth="5" strokeLinejoin="round" />
        <g strokeLinejoin="round" strokeWidth="5">
          <path d="M24 66V44L32 34L40 44V66Z" fill={color} stroke={color} transform="rotate(-16 32 66)" />
          <path d="M58 66V38L66 28L74 38V66Z" fill={color} stroke={color} transform="rotate(14 66 66)" />
          <path d="M38 68V28L50 12L62 28V68Z" fill={color} stroke={color} />
          <path d="M50 12L62 28V68H50Z" fill="#ffffff" opacity=".28" />
        </g>
      </svg>
    );
  }
  const tone = kind === "gold" ? GOLD : ROCK;
  return (
    <svg className="mine-target-art" viewBox="0 0 100 80" aria-hidden="true" focusable="false">
      <path
        d="M14 76C6 76 4 68 8 60L20 34C24 26 32 22 40 24L66 30C76 32 84 38 88 48L95 64C98 71 93 76 86 76Z"
        fill={tone.body}
        stroke={tone.body}
        strokeWidth="6"
        strokeLinejoin="round"
      />
      <path d="M22 36L40 28L66 34L58 48L32 52Z" fill={tone.top} stroke={tone.top} strokeWidth="4" strokeLinejoin="round" />
      {kind === "rock" && <circle cx="62" cy="58" r="5.5" fill={color} />}
    </svg>
  );
}

/**
 * Discovery art by rarity, in the same drawn style: common finds are rocks, then crystals in the
 * rarity colours, then gold, then a crystal cluster for the rarest. Unknown rarities draw a rock.
 */
export function Gem({ rarity, className = "" }: { rarity: string; className?: string }) {
  const look: { kind: MineTargetKind; color: string } =
    rarity === "uncommon" ? { kind: "crystal", color: "#10b981" }
      : rarity === "rare" ? { kind: "crystal", color: "#3b82f6" }
        : rarity === "epic" ? { kind: "crystal", color: "#a855f7" }
          : rarity === "legendary" ? { kind: "gold", color: "#eab308" }
            : rarity === "mythic" ? { kind: "crystal", color: "#ec4899" }
              : { kind: "rock", color: "#a1a1aa" };
  return (
    <span className={"gem gem-" + rarity + (className ? " " + className : "")} aria-hidden="true">
      <MineTarget kind={look.kind} color={look.color} />
    </span>
  );
}

const TARGETS: readonly MineTargetKind[] = ["rock", "crystal", "rock", "gold", "crystal", "rock", "crystal", "gold", "rock"];

/** The flat backdrops a mine theme cosmetic can pick: scene and ground. */
export const MINE_THEMES = {
  standard: { scene: "#1f1f1f", ground: "#2a2a2a" },
  sunset: { scene: "#2a1d1b", ground: "#3a2622" },
  arcane: { scene: "#1d1a36", ground: "#2b2552" },
  deepcore: { scene: "#0f1d20", ground: "#16292d" },
} as const;

export type MineTheme = keyof typeof MINE_THEMES;

export interface BotMineProps {
  /** How many bots are on shift (1-9). */
  crew: number;
  /** True while the crew is working; false stands them down beside their rocks. */
  active: boolean;
  /** Coin tickers that pop out of the rocks (the home hero); none by default. */
  symbols?: string[];
  /** Pickaxe head colour (a cosmetic). */
  toolColor?: string;
  /** The lead bot's colour (an outfit cosmetic). */
  leadColor?: string;
  theme?: MineTheme;
  /** Every bot in a hard hat, the way a working crew dresses. */
  hardHats?: boolean;
  className?: string;
}

export function BotMine({ crew, active, symbols = [], toolColor, leadColor, theme = "standard", hardHats = false, className = "" }: BotMineProps) {
  const count = Math.max(1, Math.min(9, Math.round(crew) || 1));
  // Up to five bots stand in one row; a bigger crew gets a second, smaller row behind.
  const backCount = count > 5 ? Math.floor(count / 2) : 0;
  const frontCount = count - backCount;
  const colors = MINE_THEMES[theme] ?? MINE_THEMES.standard;
  const spots = Array.from({ length: count }, (_, index) => index);
  const row = (indexes: number[], back: boolean) => (
    <div className={"mine-row" + (back ? " is-back" : "")} style={{ "--spots": indexes.length } as CSSProperties}>
      {indexes.map((index) => {
        const base: BotLook = botAt(index);
        const look: BotLook = {
          ...base,
          color: index === 0 && leadColor ? leadColor : base.color,
          hat: hardHats ? "hardhat" : base.hat,
        };
        const kind = TARGETS[index % TARGETS.length];
        // Each bot keeps its own clock: a slightly different routine length and a head start.
        const tempo = 6.8 + ((index * 7) % 5) * 0.45;
        const phase = (index * 2.3) % tempo;
        return (
          <div
            className="mine-spot"
            key={index}
            style={{ "--bot-tempo": tempo + "s", "--bot-phase": -phase + "s" } as CSSProperties}
          >
            <Bot {...look} mood={active ? "work" : "idle"} tool toolColor={toolColor} size="100%" className="mine-bot" />
            <span className="mine-target">
              <MineTarget kind={kind} color={kind === "crystal" ? BOT_COLORS[(index * 3 + 2) % BOT_COLORS.length] : BOT_COLORS[(index * 5 + 4) % 8]} />
              {active && (
                <span className="mine-chips" aria-hidden="true">
                  <i style={{ "--cx1": "-10px", "--cy1": "-14px", "--cx2": "-18px", "--cy2": "-4px" } as CSSProperties} />
                  <i style={{ "--cx1": "4px", "--cy1": "-20px", "--cx2": "10px", "--cy2": "-8px" } as CSSProperties} />
                  <i style={{ "--cx1": "12px", "--cy1": "-10px", "--cx2": "22px", "--cy2": "2px" } as CSSProperties} />
                </span>
              )}
              {active && symbols.length > 0 && (
                <span className="mine-coin">${symbols[index % symbols.length]}</span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
  return (
    <div
      className={"bot-mine" + (active ? " is-active" : " is-idle") + (className ? " " + className : "")}
      style={{ "--mine-scene": colors.scene, "--mine-ground": colors.ground } as CSSProperties}
      aria-hidden="true"
    >
      <div className="mine-ground" />
      {backCount > 0 && row(spots.slice(frontCount), true)}
      {row(spots.slice(0, frontCount), false)}
    </div>
  );
}
