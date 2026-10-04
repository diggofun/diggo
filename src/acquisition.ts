import { hasAnalyticsConsent } from "./components/legal/consent";

export const ACQUISITION_STORAGE_KEY = "diggo.acquisition.v1";
export const ACQUISITION_MEMORY_DAYS = 30;
const MEMORY_MS = ACQUISITION_MEMORY_DAYS * 86_400_000;
const TAG = /^[a-zA-Z0-9][a-zA-Z0-9 ._~-]*$/;
const DOMAIN = /^[a-z0-9.-]+$/;
const SOCIAL = new Set(["tiktok", "x", "youtube", "instagram", "facebook", "telegram", "discord", "reddit"]);
const PAID_MEDIA = new Set(["cpc", "ppc", "cpm", "paid", "paid_social", "paid_search", "paid_video", "display", "ads", "sponsored"]);

export interface AcquisitionTouch {
  source: string;
  medium: string;
  campaign: string;
  content: string;
  term: string;
  referringDomain: string;
  paid: boolean;
}

interface AcquisitionRecord {
  version: 1;
  expiresAt: number;
  first: AcquisitionTouch;
  last: AcquisitionTouch;
}

let landing: AcquisitionTouch | null = null;
let current: AcquisitionRecord | null = null;

function tag(value: string | null): string {
  const clean = (value ?? "").trim();
  // Campaign labels only: never persist arbitrary URLs, emails, ad-click IDs or query strings.
  return clean.length <= 120 && TAG.test(clean) ? clean : "";
}

function normalizeSource(value: string): string {
  const source = value.toLowerCase().replace(/\s+/g, "_");
  const aliases: Record<string, string> = {
    twitter: "x", "twitter.com": "x", "x.com": "x", "t.co": "x", twitter_ads: "x",
    "tik-tok": "tiktok", tik_tok: "tiktok", "tiktok.com": "tiktok", tiktok_ads: "tiktok",
    yt: "youtube", "youtu.be": "youtube", "youtube.com": "youtube", youtube_ads: "youtube",
    ig: "instagram", "instagram.com": "instagram", fb: "facebook", "facebook.com": "facebook",
    "t.me": "telegram", tg: "telegram", "google.com": "google",
  };
  return aliases[source] ?? source;
}

function domainSource(domain: string): string {
  const hosts: Record<string, readonly string[]> = {
    tiktok: ["tiktok.com"], x: ["x.com", "twitter.com", "t.co"],
    youtube: ["youtube.com", "youtu.be", "com.google.android.youtube"],
    instagram: ["instagram.com"], facebook: ["facebook.com", "fb.com"],
    telegram: ["t.me", "telegram.org"], discord: ["discord.com", "discord.gg"],
    reddit: ["reddit.com"], google: ["google.com", "google.pl", "google.co.uk"], bing: ["bing.com"],
  };
  return Object.entries(hosts).find(([, domains]) => domains.some((host) => domain === host || domain.endsWith("." + host)))?.[0] ?? domain;
}

/** UTM source wins over click IDs and referrer. A Facebook click ID alone does not prove an ad. */
export function parseAcquisition(href: string, referrer = ""): AcquisitionTouch {
  const url = new URL(href);
  let referringDomain = "";
  try {
    const previous = new URL(referrer);
    if (previous.hostname.replace(/^www\./, "") !== url.hostname.replace(/^www\./, "")) {
      referringDomain = previous.hostname.toLowerCase();
    }
  } catch { /* Missing or suppressed referrer is an ordinary direct visit. */ }
  const clickSource = url.searchParams.has("ttclid") ? "tiktok"
    : url.searchParams.has("twclid") ? "x"
    : ["gclid", "gbraid", "wbraid"].some((key) => url.searchParams.has(key)) ? "google" : "";
  const campaign = tag(url.searchParams.get("utm_campaign"));
  const explicitSource = tag(url.searchParams.get("utm_source"));
  const source = normalizeSource(explicitSource || clickSource || (referringDomain ? domainSource(referringDomain) : "")
    || (url.searchParams.has("fbclid") ? "facebook" : "")
    || (url.searchParams.has("ref") || /^\/r\/[^/]+\/?$/.test(url.pathname) ? "referral" : "")
    || (campaign ? "unknown" : "direct"));
  const explicitMedium = tag(url.searchParams.get("utm_medium")).toLowerCase();
  const medium = explicitMedium || (clickSource ? "paid" : SOCIAL.has(source) ? "social"
    : source === "google" || source === "bing" ? "organic" : source === "direct" ? "none"
    : referringDomain || source === "referral" ? "referral" : "unknown");
  return {
    source, medium, campaign,
    content: tag(url.searchParams.get("utm_content")), term: tag(url.searchParams.get("utm_term")),
    referringDomain, paid: PAID_MEDIA.has(medium) || (!explicitMedium && clickSource !== ""),
  };
}

/** Snapshot before referral routing can remove a query string. Before consent this is memory only. */
export function captureAcquisition(href?: string, referrer?: string): void {
  try {
    const location = href ?? window.location?.href;
    if (!location) return;
    landing = parseAcquisition(location, referrer ?? (typeof document === "undefined" ? "" : document.referrer));
    current = null;
  } catch { /* Invalid URLs or unavailable browser globals must not break the app. */ }
}

function validTouch(value: unknown): value is AcquisitionTouch {
  if (!value || typeof value !== "object") return false;
  const touch = value as AcquisitionTouch;
  return ["source", "medium", "campaign", "content", "term"].every((key) => {
    const field = touch[key as keyof AcquisitionTouch];
    return typeof field === "string" && field.length <= 120 && (field === "" || TAG.test(field));
  }) && touch.source !== "" && touch.medium !== "" && typeof touch.paid === "boolean"
    && typeof touch.referringDomain === "string" && touch.referringDomain.length <= 253
    && (touch.referringDomain === "" || DOMAIN.test(touch.referringDomain));
}

function readRecord(now: number): AcquisitionRecord | null {
  try {
    const raw = window.localStorage.getItem(ACQUISITION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AcquisitionRecord;
    if (parsed.version === 1 && Number.isFinite(parsed.expiresAt) && parsed.expiresAt > now
      && parsed.expiresAt <= now + MEMORY_MS && validTouch(parsed.first) && validTouch(parsed.last)) return parsed;
  } catch { /* Blocked or damaged storage falls back to this page's source. */ }
  return null;
}

export function clearAcquisition(): void {
  current = null;
  try { window.localStorage.removeItem(ACQUISITION_STORAGE_KEY); } catch { /* Optional storage. */ }
}

/** Attach the last non-direct source and first touch to every consented event, across page loads. */
export function acquisitionProperties(now = Date.now()): Record<string, string | boolean> {
  if (!hasAnalyticsConsent()) return {};
  if (!landing) captureAcquisition();
  if (!landing) return {};
  if (!current || current.expiresAt <= now) {
    const stored = readRecord(now);
    current = stored ? {
      ...stored,
      last: landing.source === "direct" ? stored.last : landing,
    } : { version: 1, expiresAt: now + MEMORY_MS, first: landing, last: landing };
    try { window.localStorage.setItem(ACQUISITION_STORAGE_KEY, JSON.stringify(current)); } catch { /* Memory-only fallback. */ }
  }
  const properties: Record<string, string | boolean> = {};
  for (const [prefix, touch] of [["traffic", current.last], ["first_traffic", current.first]] as const) {
    properties[prefix + "_source"] = touch.source;
    properties[prefix + "_medium"] = touch.medium;
    properties[prefix + "_campaign"] = touch.campaign || "(none)";
    properties[prefix + "_content"] = touch.content || "(none)";
    properties[prefix + "_term"] = touch.term || "(none)";
    properties[prefix + "_referring_domain"] = touch.referringDomain || "(none)";
    properties[prefix + "_paid"] = touch.paid;
  }
  return properties;
}
