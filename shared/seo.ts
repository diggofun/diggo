export const SITE_URL = "https://diggo.fun";

export interface PageSeo {
  path: string;
  title: string;
  description: string;
  heading: string;
  index: boolean;
}

function page(path: string, title: string, description: string, heading: string, index = true): PageSeo {
  return { path, title: title + " | Diggo.fun", description, heading, index };
}

/** Public landing pages are indexable; wallet-specific screens stay out of search results. */
export const SEO_PAGES: readonly PageSeo[] = [
  page("/", "Earn Real Solana Memecoins for Free", "Earn real Solana memecoins while you're away. Start mining for free, upgrade your mining power and claim eligible rewards to your wallet.", "Earn real memecoins for free."),
  page("/explore", "Explore Solana Memecoins", "Explore memecoins launched on Diggo.fun. Compare coins, view their mining reserves and discover Solana tokens to trade or earn by mining.", "Explore coins"),
  page("/create", "Launch a Solana Memecoin", "Create a fixed-supply Solana memecoin on Diggo.fun with Meteora trading and a mining game. Configure your coin and review launch costs before signing.", "Launch a coin"),
  page("/mine", "Earn Solana Memecoins", "Earn Solana memecoins while you're away. Activate a 24-hour mining shift, upgrade your mining power with ORE and claim eligible rewards to your wallet.", "Earn memecoins"),
  page("/diggo", "Trade Diggo.fun ($DIGGO) on Solana", "View the official Diggo.fun ($DIGGO) coin on Solana. Check its market, explore the Meteora trading pool and swap from your own wallet.", "Trade Diggo.fun ($DIGGO)"),
  page("/leaderboards", "Mining Leaderboards", "Explore the Diggo.fun mining leaderboards and compare player progress in the Solana memecoin mining game.", "Mining leaderboards"),
  page("/terms", "Terms of Service", "Read the Diggo.fun Terms of Service, including eligibility, wallet responsibilities and the rules for using the Solana memecoin launchpad and mining game.", "Terms of Service"),
  page("/privacy", "Privacy Policy", "Learn how Diggo.fun handles wallet addresses, game data and analytics, and how to manage your privacy choices.", "Privacy Policy"),
  page("/risk", "Risk Disclosure", "Understand the risks of using Diggo.fun, including volatile memecoins, wallet transactions, mining reserves and game progress with no monetary value.", "Risk Disclosure"),
  page("/cookies", "Cookie & Storage Notice", "Review the cookies and browser storage used by Diggo.fun and learn how to manage your analytics and storage preferences.", "Cookie & Storage Notice"),
  page("/trade", "Trade Solana Memecoins", "View a selected Diggo.fun coin and trade from your Solana wallet.", "Trade", false),
  page("/mines", "Mine Details", "View mining details for your selected Diggo.fun coin.", "Mine details", false),
  page("/crew", "Your Mining Crew", "Manage your Diggo.fun bot crew and upgrade game progress with ORE.", "Your mining crew", false),
  page("/discoveries", "Your Discoveries", "View your Diggo.fun mining discoveries and eligible token claims.", "Your discoveries", false),
  page("/profile", "Your Profile", "View your Diggo.fun profile, portfolio and mining rewards.", "Your profile", false),
  page("/referrals", "Referrals", "Manage your Diggo.fun referral link and referral progress.", "Referrals", false),
  page("/settings", "Settings", "Manage your Diggo.fun preferences and account settings.", "Settings", false),
  page("/admin", "Admin", "Diggo.fun administration panel.", "Admin", false),
];

export function normalizePagePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function getPageSeo(pathname: string): PageSeo {
  const path = normalizePagePath(pathname);
  const canonicalPath = path === "/portfolio" ? "/profile" : path;
  return SEO_PAGES.find((entry) => entry.path === canonicalPath) ?? { ...SEO_PAGES[0]!, index: false };
}

export function pageCanonical(seo: PageSeo): string {
  return SITE_URL + seo.path;
}
