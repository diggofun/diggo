/**
 * Renders the raster icon set into a PNG contact sheet.
 *
 * The glyphs are PNGs under public/assets/icons, so the sheet is assembled in two passes: resvg
 * rasterises the paper, the cards and the labels, then sharp tints each glyph PNG into ink and
 * composites it on top at 2x (48px, the 24px design box doubled). Cells whose asset is missing are
 * marked, so the sheet doubles as an asset checklist for the art pass.
 *
 *   node scripts/dev/icon-sheet.mjs
 */
import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";
import { createServer } from "vite";

const OUT_DIR = "C:/Users/Jurek/.codex/visualizations/2026/09/22/01a0ca64-293a-7d01-a1d7-77a6002cdfbd/shots";
const OUT_FILE = path.join(OUT_DIR, "icons-sheet.png");
const ASSET_DIR = path.resolve("public/assets/icons");

const PAPER = "#efeee6";
const CARD = "#f8f5ec";
const INK = "#14110f";
const MUTED = "#6d6b64";
const PENDING = "#b6b3a8";

const MONO = "Consolas, monospace";
const SANS = "Arial";

const GLYPH = 48;
const COLS = 12;
const CELL_W = 124;
const CELL_H = 118;
const PAD = 32;
const TITLE_H = 120;
const FOOT_H = 60;
const WIDTH = PAD * 2 + COLS * CELL_W;

function tag(name, attrs, inner) {
  const parts = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    parts.push(key + '="' + value + '"');
  }
  const open = "<" + name + (parts.length > 0 ? " " + parts.join(" ") : "");
  return inner === undefined ? open + " />" : open + ">" + inner + "</" + name + ">";
}

function text(x, y, value, opts) {
  const o = opts || {};
  return tag(
    "text",
    {
      x,
      y,
      fill: o.fill || INK,
      "font-family": o.mono === false ? SANS : MONO,
      "font-size": o.size || 10,
      "font-weight": o.weight || 700,
      "letter-spacing": o.spacing,
      "text-anchor": o.anchor,
    },
    value,
  );
}

// The asset list comes from the components themselves, so the sheet cannot drift from the code.
const server = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});
const { ICON_NAMES } = await server.ssrLoadModule("/src/icons/index.ts");
await server.close();

// One asset per name, and the components request exactly these paths.
const stems = [...ICON_NAMES];
const present = new Set();
for (const stem of stems) {
  try {
    await stat(path.join(ASSET_DIR, stem + ".png"));
    present.add(stem);
  } catch {
    // Not drawn yet: the cell is marked and the glyph is skipped.
  }
}
const missing = stems.filter((stem) => !present.has(stem));

const rows = Math.ceil(stems.length / COLS);
const HEIGHT = TITLE_H + rows * CELL_H + PAD + FOOT_H;
const chunks = [tag("rect", { x: 0, y: 0, width: WIDTH, height: HEIGHT, fill: PAPER })];

chunks.push(text(PAD, 84, "Icon set", { fill: INK, size: 40, weight: 900, mono: false, spacing: "-0.8" }));

stems.forEach((stem, i) => {
  const x = PAD + (i % COLS) * CELL_W;
  const y = TITLE_H + Math.floor(i / COLS) * CELL_H;
  const drawn = present.has(stem);
  chunks.push(
    tag("rect", {
      x: x + 3,
      y: y + 3,
      width: CELL_W - 6,
      height: CELL_H - 6,
      rx: 4,
      fill: drawn ? CARD : "none",
      stroke: drawn ? INK : PENDING,
      "stroke-width": drawn ? 1.5 : 1,
      "stroke-dasharray": drawn ? undefined : "4 4",
    }),
  );
  chunks.push(
    text(x + CELL_W / 2, y + GLYPH + 38, stem, {
      anchor: "middle",
      fill: drawn ? MUTED : PENDING,
      size: 10,
    }),
  );
  if (!drawn) {
    chunks.push(text(x + CELL_W / 2, y + 30, "not drawn yet", { anchor: "middle", fill: PENDING, size: 9, weight: 400 }));
  }
});

chunks.push(
  text(
    PAD,
    HEIGHT - 24,
    present.size +
      " of " +
      stems.length +
      " glyph PNGs present in public/assets/icons, painted at 2x (48px). Source: node scripts/dev/icon-sheet.mjs",
    { fill: MUTED, size: 10, weight: 400 },
  ),
);

const svg =
  '<svg xmlns="http://www.w3.org/2000/svg" width="' +
  WIDTH +
  '" height="' +
  HEIGHT +
  '" viewBox="0 0 ' +
  WIDTH +
  " " +
  HEIGHT +
  '">' +
  chunks.join("") +
  "</svg>";

const base = new Resvg(svg, {
  fitTo: { mode: "width", value: WIDTH },
  font: {
    fontFiles: ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"],
    loadSystemFonts: true,
    defaultFontFamily: "Consolas",
  },
  background: PAPER,
})
  .render()
  .asPng();

const layers = [];
for (let i = 0; i < stems.length; i++) {
  const stem = stems[i];
  if (!present.has(stem)) continue;
  const glyph = await sharp(path.join(ASSET_DIR, stem + ".png"))
    .resize(GLYPH, GLYPH, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const meta = await sharp(glyph).metadata();
  const width = meta.width || GLYPH;
  const height = meta.height || GLYPH;
  const tinted = await sharp({ create: { width, height, channels: 4, background: INK } })
    .composite([{ input: glyph, blend: "dest-in" }])
    .png()
    .toBuffer();
  const cellX = PAD + (i % COLS) * CELL_W;
  const cellY = TITLE_H + Math.floor(i / COLS) * CELL_H;
  layers.push({
    input: tinted,
    left: Math.round(cellX + (CELL_W - width) / 2),
    top: Math.round(cellY + 14 + (GLYPH - height) / 2),
  });
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(OUT_FILE, await sharp(base).composite(layers).png().toBuffer());
console.log(
  "wrote " +
    OUT_FILE +
    " (" +
    WIDTH +
    "x" +
    HEIGHT +
    ", " +
    present.size +
    "/" +
    stems.length +
    " glyphs present)",
);
if (missing.length > 0) console.log("missing: " + missing.join(", "));
