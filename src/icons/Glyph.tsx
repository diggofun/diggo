import { iconAssetStem, iconFallbackText, type IconName } from "./names";
import { accentFill, type IconProps } from "./types";

export type IconGlyphProps = IconProps & {
  /** Registry key of the glyph; selects /assets/icons/<name>.png. */
  name: IconName;
};

/**
 * Renders one raster glyph.
 *
 * The PNG is painted through a CSS mask on a span, so the glyph takes currentColor (or the
 * accent tint) instead of shipping one colour per asset, and icons.css gives it a 1em box.
 *
 * The mask points at whatever `iconAssetStem` resolves, which for every registry key is the icon's
 * own PNG. Only a name from outside the registry has none, and paints a readable text mark instead,
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
  const stem = iconAssetStem(name, filled);
  const text = stem === undefined ? iconFallbackText(name) : undefined;
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
        ...(stem === undefined ? null : { "--icon": "url(/assets/icons/" + stem + ".png)" }),
        ...(tint === undefined ? null : { "--icon-color": tint }),
        ...style,
      }}
      {...(text === undefined ? null : { children: text })}
      {...rest}
    />
  );
}
