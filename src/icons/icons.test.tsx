/**
 * Render test for the icon set, and the audit that keeps it complete and in one style.
 *
 * Vitest runs in node, so the icons are rendered to static markup: every registry entry must
 * produce a span holding an SVG drawn from glyphs.tsx, with the shared round stroke. The title,
 * size, accent, filled and className props must land on the right attributes, and the registry is
 * compared against the Icon*.tsx files on disk so a new icon cannot be added without an export or
 * without a drawing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACCENT_FILL,
  FILLED_VARIANTS,
  ICON_GLYPHS,
  ICON_NAMES,
  ICON_REGISTRY,
  IconBell,
  IconGlyph,
  IconHome,
  IconWatchlist,
  IconWatchlistFilled,
  iconFallbackText,
  iconGlyphName,
  type IconName,
  type IconProps,
} from "./index";

const ENTRIES = Object.entries(ICON_REGISTRY) as Array<[IconName, ComponentType<IconProps>]>;

describe("icon set", () => {
  it("exports an icon for every Icon*.tsx file", () => {
    const files = readdirSync(fileURLToPath(new URL(".", import.meta.url)))
      .filter((name) => /^Icon[A-Z].*\.tsx$/.test(name))
      .map((name) => name.replace(/\.tsx$/, ""))
      .sort();
    const exported = Object.values(ICON_REGISTRY)
      .map((Icon) => Icon.name)
      .sort();
    expect(files.length).toBeGreaterThan(40);
    expect(exported).toEqual(files);
  });

  it("matches the ICON_NAMES list", () => {
    expect(Object.keys(ICON_REGISTRY).sort()).toEqual([...ICON_NAMES].sort());
    expect(new Set(ICON_NAMES).size).toBe(ICON_NAMES.length);
  });

  for (const [name, Icon] of ENTRIES) {
    it(`${name} renders its own drawn glyph`, () => {
      const markup = renderToStaticMarkup(<Icon />);
      expect(markup.startsWith("<span")).toBe(true);
      expect(markup.endsWith("</span>")).toBe(true);
      expect(markup).toContain('class="icon');
      expect(markup).toContain('<svg viewBox="0 0 24 24"');
      // One weight and no sharp corners anywhere in the set.
      expect(markup).toContain('stroke-width="2.4"');
      expect(markup).toContain('stroke-linecap="round"');
      expect(markup).toContain('stroke-linejoin="round"');
      expect(markup).not.toContain('data-fallback="true"');
      expect(markup).not.toContain("•");
      expect(markup).not.toContain("url(");
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain(`data-icon="${name}"`);
    });
  }

  it("stays decorative by default and named when titled", () => {
    const plain = renderToStaticMarkup(<IconHome />);
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain('role="img"');

    const titled = renderToStaticMarkup(<IconHome title="Home" />);
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="Home"');
    expect(titled).toContain('title="Home"');
    // The span carries the name; the drawing inside stays out of the accessibility tree.
    expect(titled.slice(0, titled.indexOf("<svg"))).not.toContain("aria-hidden");
  });

  it("sizes the box through the size prop", () => {
    const markup = renderToStaticMarkup(<IconHome size={48} />);
    expect(markup).toContain("width:48px");
    expect(markup).toContain("height:48px");

    const sized = renderToStaticMarkup(<IconHome size="1.5rem" />);
    expect(sized).toContain("width:1.5rem");
  });

  it("tints the glyph through the accent prop", () => {
    const lime = renderToStaticMarkup(<IconHome accent="lime" />);
    expect(lime).toContain(`--icon-color:${ACCENT_FILL.lime}`);
    const orange = renderToStaticMarkup(<IconHome accent="orange" />);
    expect(orange).toContain(`--icon-color:${ACCENT_FILL.orange}`);
    const plain = renderToStaticMarkup(<IconHome />);
    expect(plain).not.toContain("--icon-color");
  });

  it("switches to the filled glyph on the icon that has one", () => {
    const filled = renderToStaticMarkup(<IconWatchlist filled />);
    expect(filled).toContain('data-filled="true"');
    expect(filled).toContain('fill="currentColor"');
    expect(filled).toBe(renderToStaticMarkup(<IconWatchlistFilled filled />).replace('data-icon="watchlistFilled"', 'data-icon="watchlist"'));

    const outline = renderToStaticMarkup(<IconWatchlist />);
    expect(outline).not.toContain("data-filled");
    expect(outline).not.toContain('fill="currentColor"');

    // Filled must never blank out an icon whose outline is its only glyph.
    const bell = renderToStaticMarkup(<IconBell filled />);
    expect(bell).toContain("<path");
    expect(iconGlyphName("bell", true)).toBe("bell");
    expect(iconGlyphName("home", true)).toBe("home");
  });

  it("keeps extra classes and forwards span attributes", () => {
    const markup = renderToStaticMarkup(<IconHome className="nav-icon" data-testid="home-icon" />);
    expect(markup).toContain('class="icon nav-icon"');
    expect(markup).toContain('data-testid="home-icon"');
  });

  it("keeps the fallback mark visible and never paints a box behind a glyph", () => {
    const css = readFileSync(fileURLToPath(new URL("./icons.css", import.meta.url)), "utf8");
    const box = css.slice(css.indexOf(".icon {"), css.indexOf("}", css.indexOf(".icon {")));
    expect(box).not.toContain("background");
    expect(box).not.toContain("mask");

    const fallback = css.slice(css.indexOf(".icon-fallback"));
    expect(fallback).toContain("color: var(--icon-color, currentColor)");
    expect(fallback).toContain("background-color: transparent");
  });
});

describe("icon glyph audit", () => {
  it("draws every IconName", () => {
    for (const name of ICON_NAMES) {
      expect(ICON_GLYPHS[name], name).toBeDefined();
      expect(iconGlyphName(name), name).toBe(name);
    }
    expect(Object.keys(ICON_GLYPHS).sort()).toEqual([...ICON_NAMES].sort());
  });

  it("points every filled variant at a drawn glyph", () => {
    for (const [name, variant] of Object.entries(FILLED_VARIANTS)) {
      expect(iconGlyphName(name as IconName, true), name).toBe(variant);
      expect(ICON_GLYPHS[variant as IconName], String(variant)).toBeDefined();
    }
  });

  it("renders a readable mark, never a blank bullet, for a name outside the registry", () => {
    expect(iconFallbackText("notAnIcon" as IconName)).toBe("NO");

    const plain = renderToStaticMarkup(<IconGlyph name={"notAnIcon" as IconName} />);
    expect(plain).toContain('class="icon icon-fallback"');
    expect(plain).toContain('data-fallback="true"');
    expect(plain).toContain(">NO<");
    expect(plain).not.toContain("•");
    expect(plain).not.toContain("<svg");
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain('role="img"');

    const titled = renderToStaticMarkup(<IconGlyph name={"notAnIcon" as IconName} title="Unknown" />);
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="Unknown"');
    expect(titled).toContain('title="Unknown"');
    expect(titled).not.toContain("aria-hidden");
  });
});
