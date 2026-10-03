/**
 * Dev-only gallery for the icon set.
 *
 * Not wired into the router: render <IconGallery /> from the dev entry (the same way UiGallery is
 * served at /__ui) to review the drawn glyph set — every name, the accent tints, the filled
 * variants and the size scale. Nothing here talks to the Worker. Every registered name must have
 * its own drawing; src/icons/icons.test.tsx enforces that invariant.
 */
import type { ComponentType, CSSProperties } from "react";
import {
  ACCENT_FILL,
  ICON_NAMES,
  ICON_REGISTRY,
  IconBell,
  IconMine,
  IconWatchlist,
  type IconName,
  type IconProps,
} from "../icons";

const ENTRIES = Object.entries(ICON_REGISTRY) as Array<[IconName, ComponentType<IconProps>]>;

const SIZES = [16, 24, 32, 48];

const S = {
  page: {
    background: "#efeee6",
    color: "#14110f",
    minHeight: "100vh",
    padding: "48px 40px 64px",
    fontFamily: "Inter, system-ui, sans-serif",
  },
  eyebrow: {
    font: "800 10px/1 ui-monospace, SFMono-Regular, monospace",
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: "#ff7a1a",
    margin: 0,
  },
  h1: {
    font: "900 34px/1 Arial Black, Arial, sans-serif",
    textTransform: "uppercase",
    letterSpacing: "-.02em",
    margin: "10px 0 12px",
  },
  lead: {
    maxWidth: 720,
    margin: 0,
    fontSize: 13,
    lineHeight: 1.6,
    color: "#5f5d57",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(112px, 1fr))",
    gap: 10,
    marginTop: 34,
  },
  cell: {
    display: "grid",
    placeItems: "center",
    gap: 7,
    padding: "18px 8px 12px",
    background: "#f8f5ec",
    border: "2px solid #14110f",
    borderRadius: 4,
  },
  label: {
    font: "700 9px/1.2 ui-monospace, SFMono-Regular, monospace",
    letterSpacing: ".06em",
    color: "#6d6b64",
    textAlign: "center",
    wordBreak: "break-all",
    margin: 0,
  },
  asset: {
    font: "400 8px/1.2 ui-monospace, SFMono-Regular, monospace",
    color: "#a09e96",
    textAlign: "center",
    wordBreak: "break-all",
  },
  panel: {
    marginTop: 36,
    padding: "22px 24px 26px",
    background: "#14110f",
    borderRadius: 6,
    display: "grid",
    gap: 14,
  },
  panelLabel: {
    font: "800 10px/1 ui-monospace, SFMono-Regular, monospace",
    letterSpacing: ".14em",
    textTransform: "uppercase",
    color: "#d8ff00",
    margin: 0,
  },
  row: {
    display: "flex",
    flexWrap: "wrap",
    gap: 13,
    alignItems: "center",
    color: "#efeee6",
  },
  states: {
    marginTop: 20,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
    gap: 16,
  },
  stateGroup: {
    display: "grid",
    gap: 12,
    padding: "14px 16px 18px",
    background: "#f8f5ec",
    border: "2px solid #14110f",
    borderRadius: 4,
  },
  stateRow: {
    display: "flex",
    alignItems: "flex-end",
    gap: 16,
  },
  foot: {
    marginTop: 30,
    font: "700 10px/1.7 ui-monospace, SFMono-Regular, monospace",
    color: "#6d6b64",
  },
} satisfies Record<string, CSSProperties>;

export function IconGallery() {
  return (
    <main style={S.page}>
      <header>
        <p style={S.eyebrow}>dev gallery · not routed</p>
        <h1 style={S.h1}>Icon set</h1>
        <p style={S.lead}>
          {ENTRIES.length} drawn glyphs painted in currentColor — {ICON_NAMES.length} names, one
          drawing each in glyphs.tsx. The icon glyph audit fails if any registered name is missing
          its drawing.
        </p>
      </header>

      <section style={S.grid}>
        {ENTRIES.map(([name, Icon]) => (
          <article key={name} style={S.cell}>
            <Icon size={28} />
            <span style={S.label}>{name}</span>
          </article>
        ))}
      </section>

      <section style={S.panel}>
        <p style={S.panelLabel}>accent = lime</p>
        <div style={S.row}>
          {ENTRIES.map(([name, Icon]) => (
            <Icon key={"lime-" + name} size={30} accent="lime" />
          ))}
        </div>
        <p style={S.panelLabel}>accent = orange</p>
        <div style={S.row}>
          {ENTRIES.map(([name, Icon]) => (
            <Icon key={"orange-" + name} size={30} accent="orange" />
          ))}
        </div>
      </section>

      <section style={S.states}>
        <div style={S.stateGroup}>
          <p style={S.label}>watchlist · outline / filled / lime / orange</p>
          <div style={S.stateRow}>
            <IconWatchlist size={32} />
            <IconWatchlist size={32} filled />
            <IconWatchlist size={32} accent="lime" />
            <IconWatchlist size={32} accent="orange" />
          </div>
          <span style={S.asset}>watchlist · watchlistFilled</span>
        </div>
        <div style={S.stateGroup}>
          <p style={S.label}>bell · outline, filled, orange</p>
          <div style={S.stateRow}>
            <IconBell size={32} />
            <IconBell size={32} filled />
            <IconBell size={32} accent="orange" />
          </div>
          <span style={S.asset}>bell · filled repeats the outline, there is no variant</span>
        </div>
        <div style={S.stateGroup}>
          <p style={S.label}>size scale · 16, 24, 32, 48</p>
          <div style={S.stateRow}>
            {SIZES.map((size) => (
              <IconMine key={size} size={size} />
            ))}
          </div>
          <span style={S.asset}>mine · size overrides the 1em box</span>
        </div>
      </section>

      <p style={S.foot}>
        accent lime {ACCENT_FILL.lime} · accent orange {ACCENT_FILL.orange} — the tints the mask
        paints instead of currentColor.
      </p>
    </main>
  );
}
