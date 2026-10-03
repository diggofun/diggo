/**
 * Builds every brand file from the two bot-style sources in scripts/brand/source:
 *
 *   diggo-logo.png    the orange bot with its pickaxe (the mark)
 *   diggo-banner.png  the "diggo" wordmark spelled in bots (the banner)
 *
 * Both sources are drawn on a near-black backdrop. The backdrop is removed by flooding inward from
 * the image border, so only background that touches the edge goes: the bots' black eyes are
 * enclosed by their bodies and stay opaque. The one-to-three pixel fringe where a shape meets the
 * backdrop is un-blended against the backdrop colour (colour-to-alpha), so the cut-out keeps a soft
 * edge instead of a dark halo.
 *
 *   node scripts/brand/make-bot-brand.mjs
 *
 * Writes into public/: the transparent mark and wordmark (png + webp), the favicons (ico, svg, png),
 * the app icons (any + maskable + apple-touch) and the 1200x630 social card.
 */
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = new URL("../../", import.meta.url);
const source = (name) => fileURLToPath(new URL("scripts/brand/source/" + name, ROOT));
const output = (path) => fileURLToPath(new URL("public/" + path, ROOT));

/** The site's page colour, used where an icon needs an opaque backdrop (iOS, maskable, social). */
const PAGE = { r: 20, g: 20, b: 20, alpha: 1 };
const CLEAR = { r: 0, g: 0, b: 0, alpha: 0 };

/** RGB distance a pixel may sit from the backdrop and still count as backdrop. */
const BACKDROP_TOLERANCE = 42;
/** How far into the shapes (in pixels) the soft edge is recomputed. */
const FRINGE = 3;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Cuts the backdrop out of one source and returns a trimmed RGBA sharp image. */
async function cutout(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  const pixels = width * height;

  // The backdrop colour is the median of the border, which ignores a stray bright pixel at an edge.
  const border = [];
  for (let x = 0; x < width; x += 1) border.push(x, (height - 1) * width + x);
  for (let y = 0; y < height; y += 1) border.push(y * width, y * width + width - 1);
  const bg = [0, 1, 2].map((channel) => median(border.map((p) => data[p * 4 + channel])));
  const distance = (p) =>
    Math.hypot(data[p * 4] - bg[0], data[p * 4 + 1] - bg[1], data[p * 4 + 2] - bg[2]);

  // Flood the backdrop inward from every border pixel that looks like it.
  const backdrop = new Uint8Array(pixels);
  const queue = new Int32Array(pixels);
  let head = 0;
  let tail = 0;
  for (const p of border) {
    if (!backdrop[p] && distance(p) < BACKDROP_TOLERANCE) {
      backdrop[p] = 1;
      queue[tail++] = p;
    }
  }
  while (head < tail) {
    const p = queue[head++];
    const x = p % width;
    const y = (p - x) / width;
    const next = [x > 0 ? p - 1 : -1, x < width - 1 ? p + 1 : -1, y > 0 ? p - width : -1, y < height - 1 ? p + width : -1];
    for (const n of next) {
      if (n >= 0 && !backdrop[n] && distance(n) < BACKDROP_TOLERANCE) {
        backdrop[n] = 1;
        queue[tail++] = n;
      }
    }
  }

  // The fringe: shape pixels within FRINGE steps of the flooded backdrop.
  const fringe = new Uint8Array(pixels);
  let frontier = backdrop;
  for (let step = 0; step < FRINGE; step += 1) {
    const grown = new Uint8Array(pixels);
    for (let p = 0; p < pixels; p += 1) {
      if (backdrop[p] || fringe[p]) continue;
      const x = p % width;
      if ((x > 0 && frontier[p - 1]) || (x < width - 1 && frontier[p + 1]) || (p >= width && frontier[p - width]) || (p + width < pixels && frontier[p + width])) {
        grown[p] = 1;
      }
    }
    for (let p = 0; p < pixels; p += 1) if (grown[p]) fringe[p] = 1;
    frontier = grown;
  }

  const out = Buffer.alloc(pixels * 4);
  for (let p = 0; p < pixels; p += 1) {
    const i = p * 4;
    if (backdrop[p]) continue; // fully transparent
    if (!fringe[p]) {
      out[i] = data[i];
      out[i + 1] = data[i + 1];
      out[i + 2] = data[i + 2];
      out[i + 3] = 255;
      continue;
    }
    // Colour-to-alpha against the backdrop: the smallest alpha that explains this pixel as the
    // shape colour blended over the backdrop.
    let alpha = 0;
    for (let c = 0; c < 3; c += 1) {
      const value = data[i + c];
      const ratio = value >= bg[c] ? (value - bg[c]) / Math.max(1, 255 - bg[c]) : (bg[c] - value) / Math.max(1, bg[c]);
      alpha = Math.max(alpha, ratio);
    }
    alpha = Math.min(1, alpha);
    if (alpha < 0.03) continue;
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.max(0, Math.min(255, Math.round(bg[c] + (data[i + c] - bg[c]) / alpha)));
    }
    out[i + 3] = Math.round(alpha * 255);
  }

  // Trim to the visible shape.
  let left = width;
  let right = -1;
  let top = height;
  let bottom = -1;
  for (let p = 0; p < pixels; p += 1) {
    if (out[p * 4 + 3] > 8) {
      const x = p % width;
      const y = (p - x) / width;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  const image = sharp(out, { raw: { width, height, channels: 4 } }).extract({
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  });
  return sharp(await image.png().toBuffer());
}

/** PNG encoding for every output: a quantised palette with alpha, maximum compression. */
const PNG = { palette: true, quality: 92, effort: 10, compressionLevel: 9 };

/** A square icon: the mark contained in `size` with `pad` (a fraction) of clear space per side. */
async function square(mark, size, pad, background) {
  const inner = Math.round(size * (1 - pad * 2));
  const fitted = await mark.clone().resize(inner, inner, { fit: "contain", background: CLEAR }).png().toBuffer();
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: fitted, gravity: "center" }])
    .png(PNG)
    .toBuffer();
}

/** A minimal .ico holding PNG frames (supported by every browser that still asks for one). */
function ico(frames) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  const entries = [];
  let offset = 6 + frames.length * 16;
  for (const { size, png } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...frames.map((frame) => frame.png)]);
}

async function main() {
  const mark = await cutout(source("diggo-logo.png"));
  const wordmark = await cutout(source("diggo-banner.png"));

  // The transparent originals, sized for the UI (the header shows them at 30-40px tall).
  const markFull = await mark.clone().resize(1024, 1024, { fit: "inside" }).png(PNG).toBuffer();
  await writeFile(output("assets/brand/diggo-logo.png"), markFull);
  await writeFile(output("assets/brand/diggo-logo.webp"), await sharp(markFull).webp({ quality: 90 }).toBuffer());
  const markSmall = await mark.clone().resize(256, 256, { fit: "inside" }).png(PNG).toBuffer();
  await writeFile(output("assets/brand/diggo-logo-256.png"), markSmall);

  const wordFull = await wordmark.clone().resize(1600, null, { fit: "inside" }).png(PNG).toBuffer();
  await writeFile(output("assets/brand/diggo-wordmark.png"), wordFull);
  await writeFile(output("assets/brand/diggo-wordmark.webp"), await sharp(wordFull).webp({ quality: 90 }).toBuffer());
  const wordSmall = await wordmark.clone().resize(640, null, { fit: "inside" }).png(PNG).toBuffer();
  await writeFile(output("assets/brand/diggo-wordmark-640.png"), wordSmall);

  // Favicons and app icons: transparent where the platform allows it, the page colour where it
  // needs an opaque square (iOS home screen, Android maskable).
  const icon16 = await square(mark, 16, 0, CLEAR);
  const icon32 = await square(mark, 32, 0.02, CLEAR);
  const icon48 = await square(mark, 48, 0.03, CLEAR);
  await writeFile(output("assets/brand/favicon-16.png"), icon16);
  await writeFile(output("assets/brand/favicon-32.png"), icon32);
  await writeFile(output("assets/brand/favicon-48.png"), icon48);
  await writeFile(output("assets/brand/icon-192.png"), await square(mark, 192, 0.05, CLEAR));
  await writeFile(output("assets/brand/icon-512.png"), await square(mark, 512, 0.05, CLEAR));
  await writeFile(output("assets/brand/apple-touch-icon.png"), await square(mark, 180, 0.12, PAGE));
  await writeFile(output("assets/brand/maskable-512.png"), await square(mark, 512, 0.2, PAGE));
  await writeFile(output("favicon.ico"), ico([
    { size: 16, png: icon16 },
    { size: 32, png: icon32 },
    { size: 48, png: icon48 },
  ]));
  const svgPng = (await square(mark, 128, 0.02, CLEAR)).toString("base64");
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="128" height="128" viewBox="0 0 128 128">' +
    '<image width="128" height="128" href="data:image/png;base64,' + svgPng + '" xlink:href="data:image/png;base64,' + svgPng + '"/></svg>\n';
  await writeFile(output("favicon.svg"), svg);
  await writeFile(output("assets/brand/favicon.svg"), svg);

  // The social card: the wordmark on the page colour, 1200x630.
  const cardWord = await wordmark.clone().resize(940, 380, { fit: "inside" }).png().toBuffer();
  const card = await sharp({ create: { width: 1200, height: 630, channels: 4, background: PAGE } })
    .composite([{ input: cardWord, gravity: "center" }])
    .png(PNG)
    .toBuffer();
  await writeFile(output("og-image-v3.png"), card);

  const meta = async (buffer) => {
    const info = await sharp(buffer).metadata();
    return info.width + "x" + info.height;
  };
  console.log("mark", await meta(markFull), "wordmark", await meta(wordFull), "card 1200x630");
}

await main();
