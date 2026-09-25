/**
 * Render test for the icon set, and the audit that keeps it complete.
 *
 * Vitest runs in node, so the icons are rendered to static markup: every registry entry must
 * produce a span whose --icon points at its own PNG, and that file has to exist under
 * public/assets/icons. The asset directory is read here rather than trusted from the code, so a
 * name added without art fails the suite instead of shipping as an empty box. The title, size,
 * accent, filled and className props must land on the right attributes, and the registry is
 * compared against the Icon*.tsx files on disk so a new icon cannot be added without an export.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ACCENT_FILL,
  FILLED_VARIANTS,
  ICON_ASSET_NAMES,
  ICON_NAMES,
  ICON_REGISTRY,
  IconBell,
  IconGlyph,
  IconHome,
  IconWatchlist,
  IconWatchlistFilled,
  iconAssetStem,
  iconFallbackText,
  type IconName,
  type IconProps,
} from "./index";

const ENTRIES = Object.entries(ICON_REGISTRY) as Array<[IconName, ComponentType<IconProps>]>;

/** The PNG stems really present in public/assets/icons, read from disk instead of from the code. */
const ASSET_DIR = fileURLToPath(new URL("../../public/assets/icons/", import.meta.url));
/** Brand logos rendered as plain <img> files; they sit beside the glyphs but are not mask icons. */
const BRAND_IMAGE_STEMS = new Set(["x", "x@2x"]);

const SHIPPED_STEMS = readdirSync(ASSET_DIR)
  .filter((file) => file.endsWith(".png"))
  .map((file) => file.replace(/\.png$/, ""))
  .filter((stem) => !BRAND_IMAGE_STEMS.has(stem))
  .sort();

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
    it(`${name} renders a masked span for its own PNG`, () => {
      const markup = renderToStaticMarkup(<Icon />);
      expect(markup.startsWith("<span")).toBe(true);
      expect(markup.endsWith("</span>")).toBe(true);
      expect(markup).toContain('class="icon');
      expect(markup).toContain(`--icon:url(/assets/icons/${name}.png)`);
      expect(markup).not.toContain('data-fallback="true"');
      expect(markup).not.toContain("•");
      expect(markup).toContain('aria-hidden="true"');
      expect(markup).toContain(`data-icon="${name}"`);
      expect(markup).not.toContain("<svg");
      expect(markup).not.toContain("<path");
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
    expect(titled).not.toContain('aria-hidden');
  });

  it("sizes the box through the size prop", () => {
    const markup = renderToStaticMarkup(<IconHome size={48} />);
    expect(markup).toContain("width:48px");
    expect(markup).toContain("height:48px");

    const sized = renderToStaticMarkup(<IconHome size="1.5rem" />);
    expect(sized).toContain("width:1.5rem");
  });

  it("tints the mask through the accent prop", () => {
    const lime = renderToStaticMarkup(<IconHome accent="lime" />);
    expect(lime).toContain(`--icon-color:${ACCENT_FILL.lime}`);
    const orange = renderToStaticMarkup(<IconHome accent="orange" />);
    expect(orange).toContain(`--icon-color:${ACCENT_FILL.orange}`);
    const plain = renderToStaticMarkup(<IconHome />);
    expect(plain).not.toContain("--icon-color");
  });

  it("switches to the filled asset on the icon that ships one", () => {
    const filled = renderToStaticMarkup(<IconWatchlist filled />);
    expect(filled).toContain("--icon:url(/assets/icons/watchlistFilled.png)");
    expect(filled).toContain('data-filled="true"');
    expect(filled).not.toContain('data-fallback="true"');

    const variant = renderToStaticMarkup(<IconWatchlistFilled />);
    expect(variant).toContain("--icon:url(/assets/icons/watchlistFilled.png)");

    const outline = renderToStaticMarkup(<IconWatchlist />);
    expect(outline).toContain("--icon:url(/assets/icons/watchlist.png)");
    expect(outline).not.toContain("data-filled");

    // Filled must never blank out an icon whose outline is its only asset.
    const bell = renderToStaticMarkup(<IconBell filled />);
    expect(bell).toContain("--icon:url(/assets/icons/bell.png)");
    const other = renderToStaticMarkup(<IconHome filled />);
    expect(other).toContain("--icon:url(/assets/icons/home.png)");
  });

  it("keeps extra classes and forwards span attributes", () => {
    const markup = renderToStaticMarkup(<IconHome className="nav-icon" data-testid="home-icon" />);
    expect(markup).toContain('class="icon nav-icon"');
    expect(markup).toContain('data-testid="home-icon"');
  });

  it("keeps missing-asset fallbacks visible without a mask paint", () => {
    const css = readFileSync(fileURLToPath(new URL("./icons.css", import.meta.url)), "utf8");
    const fallback = css.slice(css.indexOf(".icon-fallback"));

    expect(fallback).toContain("color: var(--icon-color, currentColor)");
    expect(fallback).toContain("background-color: transparent");
    expect(fallback).toContain("mask-image: none");
  });
});

describe("icon asset audit", () => {
  it("gives every IconName its own PNG in public/assets/icons", () => {
    for (const name of ICON_NAMES) {
      // The stem has to be the name itself: no stand-in, no alias, no text mark.
      expect(iconAssetStem(name), name).toBe(name);
      expect(SHIPPED_STEMS, `${name}.png`).toContain(name);
    }
  });

  it("keeps ICON_ASSET_NAMES in step with the PNGs on disk", () => {
    expect([...ICON_ASSET_NAMES].sort()).toEqual(SHIPPED_STEMS);
  });

  it("points every filled variant at a shipped PNG", () => {
    for (const [name, variant] of Object.entries(FILLED_VARIANTS)) {
      expect(iconAssetStem(name as IconName, true), name).toBe(variant);
      expect(SHIPPED_STEMS, `${variant}.png`).toContain(variant);
    }
  });

  it("renders a readable mark, never a blank bullet, for a name outside the registry", () => {
    expect(iconFallbackText("notAnIcon" as IconName)).toBe("NO");

    const plain = renderToStaticMarkup(<IconGlyph name={"notAnIcon" as IconName} />);
    expect(plain).toContain('class="icon icon-fallback"');
    expect(plain).toContain('data-fallback="true"');
    expect(plain).toContain(">NO<");
    expect(plain).not.toContain("•");
    expect(plain).not.toContain("--icon:url");
    expect(plain).not.toContain("<svg");
    expect(plain).toContain('aria-hidden="true"');
    expect(plain).not.toContain('role="img"');

    const titled = renderToStaticMarkup(<IconGlyph name={"notAnIcon" as IconName} title="Unknown" />);
    expect(titled).toContain('role="img"');
    expect(titled).toContain('aria-label="Unknown"');
    expect(titled).toContain('title="Unknown"');
    expect(titled).not.toContain('aria-hidden');
  });
});

