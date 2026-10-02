/**
 * One-off migration: repaints src/styles.css from the original light "ink on paper" palette to the
 * LowBot dark palette (zinc surfaces, white pill actions, coloured creature accents).
 *
 * The old sheet used one token, --ink, for three jobs (text, dark panels and hard borders), so a
 * token swap alone cannot flip it. This walks every declaration block and maps each colour by the
 * property it sits in and by whether the block paints a light accent background.
 *
 *   node scripts/dev/retheme-lowbot.mjs            rewrites src/styles.css in place
 *
 * Kept in the repo so the mapping is reviewable; running it twice is a no-op on an already
 * converted sheet because none of the old colours remain.
 */
import { readFileSync, writeFileSync } from "node:fs";

const FILE = new URL("../../src/styles.css", import.meta.url);
const css = readFileSync(FILE, "utf8");

const INK = ["var(--ink)", "#171813", "#1d1e19", "#050505", "#141510"];
const INK2 = ["var(--ink-2)", "#24251e", "#272820", "#20211c"];
const INK3 = ["var(--ink-3)", "#34362c", "#2e3028", "#2c2e25"];
const PAPER = ["var(--paper)", "#f1eee4", "#f4f0e6"];
const PAPER2 = ["var(--paper-2)", "#f8f5ec", "#faf8f1", "white", "#fff", "#ffffff"];
const PAPER3 = ["var(--paper-3)", "#e5e1d6", "#dddace", "#e6e1d5", "#ece8dc", "#ebe7dc", "#efebe0"];
const MUTED_LIGHT = ["#606158", "#66685f", "#6e7066", "#4d4f47", "#65675f", "#5f6057", "#79796e", "#55574f", "#74766e", "#7e8078", "#97998f", "#96988e", "#a2a49a", "#a9ab9f", "#b9bbb0"];
const LIGHT_BG = ["var(--acid)", "#d7ff3f", "var(--orange)", "#ff6138", "#ff865e", "#ffc83f", "#ffb627", "var(--rarity-", "#bfc0b4", "var(--success)", "#72b93c"];

const esc = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replaces whole colour words only, so "#fff" never eats the front of "#ffffff". */
function swap(value, from, to) {
  let out = value;
  for (const word of [...from].sort((a, b) => b.length - a.length)) {
    const tail = word.endsWith(")") ? "" : "(?![0-9a-zA-Z-])";
    out = out.replace(new RegExp("(?<![0-9a-zA-Z#-])" + esc(word) + tail, "gi"), to);
  }
  return out;
}

const TEXT_PROPS = /^(color|fill|stroke|caret-color|-webkit-text-fill-color|text-decoration-color|accent-color)$/;
const RADIUS = { 1: 6, 2: 8, 3: 10, 4: 12, 5: 14, 6: 16, 7: 18, 8: 22, 10: 22 };
const SOFT = "var(--shadow-soft)";

function mapDecl(prop, value, lightBg) {
  let v = value;
  if (TEXT_PROPS.test(prop)) {
    v = swap(v, INK3, lightBg ? "var(--on-accent)" : "var(--fg-2)");
    v = swap(v, [...INK, ...INK2], lightBg ? "var(--on-accent)" : "var(--fg)");
    v = swap(v, MUTED_LIGHT, "var(--muted)");
    v = swap(v, ["#32772b", "#267536", "#2f9e5b", "#3f8f3a"], "var(--success)");
    v = swap(v, ["#a43222", "#a92920", "#c7361f", "#b8401f"], "var(--danger)");
    v = swap(v, ["var(--orange-ink)"], lightBg ? "var(--on-accent)" : "var(--accent)");
    if (lightBg) v = swap(v, ["white", "#fff", "#ffffff"], "var(--on-accent)");
    v = swap(v, ["var(--acid)", "#d7ff3f"], lightBg ? "var(--on-accent)" : "var(--accent)");
    v = v.replace(/rgba\(\s*23\s*,\s*24\s*,\s*19\s*,/g, lightBg ? "rgba(0,0,0," : "rgba(244,244,245,");
    return v;
  }
  if (/shadow/.test(prop)) {
    if (v.includes("var(--shadow-hard") || v.includes("var(--shadow-acid")) return SOFT;
    // A hard offset shadow (x y 0 colour, both offsets non-zero) becomes the soft LowBot lift.
    if (/(^|,)\s*-?[1-9]\d*px\s+-?[1-9]\d*px\s+0(px)?\s/.test(v)) return SOFT;
    v = v.replace(/rgba\(\s*23\s*,\s*24\s*,\s*19\s*,\s*[\d.]+\)/g, "rgba(0,0,0,.45)");
    v = swap(v, INK, "rgba(0,0,0,.5)");
    v = swap(v, ["var(--acid)"], "rgba(255,255,255,.18)");
    return v;
  }
  if (/^border|^outline/.test(prop)) {
    if (/radius/.test(prop)) {
      return v.replace(/(^|\s)(\d+)px/g, (m, sp, n) => sp + (RADIUS[n] ?? n) + "px");
    }
    v = swap(v, [...INK, ...INK2], "var(--line-strong)");
    v = swap(v, PAPER, "var(--bg)");
    v = swap(v, PAPER2, "var(--line)");
    v = v.replace(/rgba\(\s*23\s*,\s*24\s*,\s*19\s*,\s*([\d.]+)\)/g, (m, a) => "rgba(255,255,255," + Math.min(0.16, Number(a) * 0.6).toFixed(2) + ")");
    v = swap(v, ["var(--acid)", "#d7ff3f"], "var(--accent)");
    return v;
  }
  if (/^background/.test(prop)) {
    v = swap(v, INK, "var(--surface-deep)");
    v = swap(v, INK2, "var(--surface-2)");
    v = swap(v, INK3, "var(--control)");
    v = swap(v, PAPER, "var(--bg)");
    v = swap(v, PAPER2, "var(--card)");
    v = swap(v, PAPER3, "var(--control)");
    v = swap(v, ["#e1f8cf"], "rgba(16,185,129,.14)");
    v = swap(v, ["#ffe1dc"], "rgba(244,63,94,.14)");
    v = v.replace(/rgba\(\s*241\s*,\s*238\s*,\s*228\s*,\s*([\d.]+)\)/g, "rgba(9,9,11,$1)");
    v = v.replace(/rgba\(\s*23\s*,\s*24\s*,\s*19\s*,\s*([\d.]+)\)/g, (m, a) => "rgba(255,255,255," + Math.min(0.12, Number(a) * 0.5).toFixed(2) + ")");
    return v;
  }
  if (prop === "font" || prop === "font-family") {
    v = v.replace(/"?Arial Black"?(,\s*Impact)?(,\s*sans-serif)?/g, "var(--font-display)");
    v = v.replace(/(^|\s)(?:Inter|Arial),\s*sans-serif/g, "$1var(--font-sans)");
    v = v.replace(/(^|\s)monospace\b/g, "$1var(--font-mono)");
    if (v.includes("var(--font-display)")) v = v.replace(/^(9[05]0|900)\b/, "700");
    return v;
  }
  return swap(v, ["var(--acid)"], "var(--accent)");
}

/** Walks innermost { } blocks; selectors and at-rules pass through untouched. */
function convert(source) {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const open = source.indexOf("{", i);
    if (open === -1) {
      out += source.slice(i);
      break;
    }
    const nextOpen = source.indexOf("{", open + 1);
    const close = source.indexOf("}", open + 1);
    if (nextOpen !== -1 && nextOpen < close) {
      out += source.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    out += source.slice(i, open + 1);
    out += convertBlock(source.slice(open + 1, close));
    out += "}";
    i = close + 1;
  }
  return out;
}

function convertBlock(body) {
  if (body.includes("--paper:")) return body; // :root tokens are rewritten by hand
  const bg = (body.match(/background(?:-color)?\s*:\s*([^;]+)/) || [])[1] || "";
  const lightBg = LIGHT_BG.some((token) => bg.includes(token));
  return body.replace(/([a-z-]+)\s*:\s*([^;{}]+)/g, (whole, prop, value) => {
    if (prop.startsWith("--")) return whole;
    let next = mapDecl(prop, value, lightBg);
    if (prop === "text-transform" && /uppercase/.test(value) && /var\(--font-display\)|Arial Black/.test(body)) next = "none";
    return whole.slice(0, whole.indexOf(":") + 1) + (whole[whole.indexOf(":") + 1] === " " ? " " : "") + next.trimStart();
  });
}

writeFileSync(FILE, convert(css));
console.log("rethemed", FILE.pathname);
