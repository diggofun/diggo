/**
 * The Diggo crew: small coloured bots with two eyes, borrowed from LowBot's bot characters
 * (Avenium-project/LowBot, client/components/v2/ui.jsx, MIT). LowBot's eight shapes and colours,
 * plus eight more of each, drawn flat, with the same idle float, look-around, blink and tap squish.
 * Diggo adds a pickaxe, a work routine (swing, hop, turn around) and a small wardrobe.
 *
 * Every outline is drawn with a thick stroke in its own colour and round joins, so even the pointy
 * shapes (star, diamond, hexagon) end up with soft corners. Hats and glasses follow the same rule.
 *
 * Purely decorative. A bot never carries game state of its own: callers pick a look from a stable
 * seed (botFor) or a slot index (botAt), so the same mine or slot always shows the same bot.
 */
import { useState, type CSSProperties } from "react";
import "./bot.css";
import { BotSvg, type BotEyewear, type BotHat, type BotShape } from "./BotArt";

export * from "./BotArt";

/**
 * "idle" floats, looks around, and now and then turns to look behind it; "busy" hops; "dig" swings
 * the pickaxe on a loop; "work" is the mine routine (a few swings at the rock, a pause, a hop, a
 * look the other way); "attention" wiggles.
 */
export type BotMood = "idle" | "busy" | "dig" | "work" | "attention";

export interface BotProps {
  shape: BotShape;
  color: string;
  hat?: BotHat;
  eyewear?: BotEyewear;
  /** Pixels, or any CSS length ("100%") when a parent box sizes the bot. */
  size?: number | string;
  mood?: BotMood;
  /** Draws the pickaxe. Implied by moods "dig" and "work". */
  tool?: boolean;
  /** Pickaxe head colour (a cosmetic). */
  toolColor?: string;
  /** No animation at all (lists, tiny avatars). */
  still?: boolean;
  /** Offsets this bot's cycle so a line-up never moves in lockstep. Seconds. Inherited when omitted. */
  phase?: number;
  /** Cycle length in seconds (a dig swing, or the whole work routine). Inherited when omitted. */
  tempo?: number;
  className?: string;
}

export function Bot({
  shape,
  color,
  hat = "none",
  eyewear = "none",
  size = 48,
  mood = "idle",
  tool,
  toolColor = "#e4e4e7",
  still,
  phase,
  tempo,
  className = "",
}: BotProps) {
  const [squish, setSquish] = useState(false);
  const withTool = tool ?? (mood === "dig" || mood === "work");
  const style = {
    width: size,
    height: size,
    ...(phase === undefined ? null : { "--bot-phase": -phase + "s" }),
    ...(tempo === undefined ? null : { "--bot-tempo": tempo + "s" }),
  } as CSSProperties;
  const classes = ["bot", "is-" + mood, still ? "is-still" : "", squish ? "is-squish" : "", className].filter(Boolean).join(" ");
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
      {mood === "busy" && !still && <span className="bot-shadow" />}
      <BotSvg shape={shape} color={color} hat={hat} eyewear={eyewear} tool={withTool} toolColor={toolColor} />
      {(mood === "dig" || mood === "work") && !still && (
        <span className="bot-sparks">
          <i /><i /><i />
        </span>
      )}
    </span>
  );
}
