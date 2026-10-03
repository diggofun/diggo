import { ICON_GLYPHS } from "./glyphs";
import { iconFallbackText, iconGlyphName, type IconName } from "./names";
import { accentFill, type IconProps } from "./types";

export type IconGlyphProps = IconProps & {
  /** Registry key of the glyph; selects its drawing in glyphs.tsx. */
  name: IconName;
};

/**
 * Renders one drawn glyph.
 *
 * The span is the icon's box (1em by default, see icons.css) and carries every attribute a caller
 * passes; the SVG inside fills it and paints in currentColor, or in the accent tint. Strokes are
 * 2.4 units with round caps and joins, so every icon has the same weight and no sharp corner.
 *
 * Only a name from outside the registry has no drawing, and paints a readable text mark instead,
 * so a glyph is never an empty box and never a bare bullet.
 */
export function IconGlyph({
  name,
  accent,
  filled,
  size,
  title,
  className,
  style,
  ...rest
}: IconGlyphProps) {
  const tint = accentFill(accent);
  const glyph = ICON_GLYPHS[iconGlyphName(name, filled)];
  const text = glyph === undefined ? iconFallbackText(name) : undefined;
  return (
    <span
      className={["icon", text === undefined ? undefined : "icon-fallback", className]
        .filter(Boolean)
        .join(" ")}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      title={title}
      data-icon={name}
      data-fallback={text === undefined ? undefined : "true"}
      data-filled={filled ? "true" : undefined}
      style={{
        ...(size === undefined ? null : { width: size, height: size }),
        ...(tint === undefined ? null : { "--icon-color": tint }),
        ...style,
      }}
      {...rest}
    >
      {text === undefined ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
          aria-hidden="true"
        >
          {glyph}
        </svg>
      ) : (
        text
      )}
    </span>
  );
}
