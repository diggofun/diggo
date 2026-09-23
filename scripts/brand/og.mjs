/**
 * Builds the social card: public/assets/game/og-image.png and its .webp twin, 1200x630.
 *
 * The illustration that ships with the brand leaves the left 43% of the card empty on purpose, so
 * the wordmark and the tagline are composited into it. Both are drawn from the SVG sources in
 * public/assets/brand, which keeps the card in step with the header lockup instead of drifting into
 * a second, hand-made copy of the logo.
 *
 *   node scripts/brand/og.mjs
 *
 * The base is the illustration already in the repository. Before it draws, the script restores the
 * empty left band to the artwork's own background colour, so running it twice gives the same file
 * instead of stacking one copy of the copy on top of the last one.
 */
import { access, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../..");
const gameArt = (name) => path.join(repo, "public", "assets", "game", name);
const brandArt = (name) => path.join(repo, "public", "assets", "brand", name);

const CARD = { width: 1200, height: 630 };
/** Everything left of this is empty backdrop in the illustration, and the copy owns it. */
const COPY_WIDTH = 505;
const PAD = 72;
/** Where the lockup sits: one clean column, level with the middle of the illustration. */
const BLOCK_TOP = 212;
const WORDMARK_WIDTH = 336;
/** The wordmark's own viewBox, so its scale is read from the file rather than guessed. */
const WORDMARK_VIEWBOX_WIDTH = 598;
const WORDMARK_VIEWBOX_HEIGHT = 140;
const TAGLINE = ["Build your memecoin", "mining crew"];
const TAGLINE_SIZE = 30;
const TAGLINE_LEADING = 40;
const TAGLINE_GAP = 30;
const INK = "#171813";

/** A grotesk that is actually installed, so the tagline never falls back to a serif. */
const FONT_CANDIDATES = [
  process.env.DIGGO_OG_FONT,
  "C:/Windows/Fonts/arialbd.ttf",
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
].filter((candidate) => typeof candidate === "string" && candidate.length > 0);

async function installedFonts() {
  const found = [];
  for (const file of FONT_CANDIDATES) {
    try {
      await access(file);
      found.push(file);
    } catch {
      // Not installed here; the next candidate, or the system font stack, takes over.
    }
  }
  return found;
}

/** The inner markup of an SVG file, so a source logo can be placed by this scene. */
function innerSvg(markup) {
  const start = markup.indexOf(">", markup.indexOf("<svg"));
  const end = markup.lastIndexOf("</svg>");
  if (start === -1 || end === -1) throw new Error("Not an SVG document");
  return markup.slice(start + 1, end).trim();
}

function toHex(channels) {
  return "#" + channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("");
}

/**
 * The illustration's own backdrop, read from the columns just right of the band the copy owns.
 * That strip is always empty artwork and never the patch this script paints, so a second run reads
 * the same colour as the first. (sharp's stats() reports the whole image, whatever extract() asked
 * for, which is why the pixels are averaged here by hand.)
 */
async function readBackdrop(source) {
  const { data, info } = await sharp(source)
    .extract({ left: COPY_WIDTH + 2, top: 6, width: 8, height: 8 })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const pixels = info.width * info.height;
  if (pixels === 0) return "#f0ede6";
  const totals = [0, 0, 0];
  for (let index = 0; index < pixels; index++) {
    totals[0] += data[index * info.channels];
    totals[1] += data[index * info.channels + 1];
    totals[2] += data[index * info.channels + 2];
  }
  return toHex(totals.map((total) => total / pixels));
}

async function main() {
  const source = await readFile(gameArt("og-image.png"));
  const meta = await sharp(source).metadata();
  if (meta.width !== CARD.width || meta.height !== CARD.height) {
    throw new Error(
      "og-image.png is " + meta.width + "x" + meta.height + ", expected " + CARD.width + "x" + CARD.height,
    );
  }

  const backdrop = await readBackdrop(source);

  const wordmark = innerSvg(await readFile(brandArt("logo.svg"), "utf8"));
  const scale = WORDMARK_WIDTH / WORDMARK_VIEWBOX_WIDTH;
  const taglineTop = BLOCK_TOP + WORDMARK_VIEWBOX_HEIGHT * scale + TAGLINE_GAP;
  const tagline = TAGLINE.map((line, index) => {
    const y = Math.round(taglineTop + TAGLINE_SIZE * 0.78 + index * TAGLINE_LEADING);
    return (
      '<text x="' + PAD + '" y="' + y + '" font-family="Arial, Helvetica, sans-serif" ' +
      'font-size="' + TAGLINE_SIZE + '" font-weight="700" letter-spacing="-0.4" fill="' + INK + '">' +
      line + "</text>"
    );
  }).join("\n  ");

  const overlay = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + CARD.width + '" height="' + CARD.height + '"',
    ' viewBox="0 0 ' + CARD.width + " " + CARD.height + '">',
    '  <rect x="0" y="0" width="' + COPY_WIDTH + '" height="' + CARD.height + '" fill="' + backdrop + '"/>',
    '  <g transform="translate(' + PAD + " " + BLOCK_TOP + ") scale(" + scale.toFixed(4) + ')">' + wordmark + "</g>",
    "  " + tagline,
    "</svg>",
  ].join("\n");

  // One font file, resolved: text rendering should not depend on whatever the machine has installed.
  const fonts = await installedFonts();
  const copy = new Resvg(overlay, {
    fitTo: { mode: "width", value: CARD.width },
    font: {
      fontFiles: fonts,
      loadSystemFonts: fonts.length === 0,
      defaultFontFamily: "Arial",
    },
  }).render().asPng();

  const card = await sharp(source)
    .composite([{ input: copy, left: 0, top: 0 }])
    .png({ compressionLevel: 9 })
    .toBuffer();

  await writeFile(gameArt("og-image.png"), card);
  await writeFile(gameArt("og-image.webp"), await sharp(card).webp({ quality: 86 }).toBuffer());

  console.log(
    "wrote og-image.png + og-image.webp (" + CARD.width + "x" + CARD.height + "), backdrop " + backdrop +
      ", fonts " + (fonts.length > 0 ? fonts.join(", ") : "system"),
  );
}

await main();
