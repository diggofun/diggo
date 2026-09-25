/** Number and time formatting shared by every screen. */

export function compact(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function money(value: number | null | undefined): string {
  const safe = value ?? 0;
  if (!Number.isFinite(safe) || safe <= 0) return "$0.00";
  if (safe < 0.000001) return `$${safe.toExponential(2)}`;
  if (safe < 0.01) return `$${safe.toFixed(8)}`;
  return `$${safe.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 4)}…${value.slice(-5)}`;
}

/** Countdown to a Unix-seconds deadline, refreshed by the caller's tick. */
export function countdown(target: number, now: number): string {
  const delta = Math.max(0, target * 1000 - now);
  const seconds = Math.floor(delta / 1_000);
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const secs = seconds % 60;
  if (days) return `${days}d ${hours}h ${minutes}m`;
  return [hours, minutes, secs].map((part) => String(part).padStart(2, "0")).join(":");
}

/** Human duration for a length of time that already elapsed ("6h 12m"). */
export function duration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const days = Math.floor(safe / 86_400);
  const hours = Math.floor((safe % 86_400) / 3_600);
  const minutes = Math.floor((safe % 3_600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m`;
  return `${safe % 60}s`;
}

/** ORE is a whole-number game currency; fractional spills belong to the overflow note. */
export function oreAmount(value: number): string {
  return Math.floor(Math.max(0, value)).toLocaleString();
}

export function tokenAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 1 ? 6 : 2 });
}

/**
 * A SOL figure, which ranges from the dust left in a bonding curve to six-figure market caps. Under
 * 1000 it keeps enough decimals to be real rather than a rounded zero, and above that it is compact.
 * Formatted in `en` rather than the visitor's locale, like compact(), so a SOL amount sits next to
 * the toFixed() figures the trading panel already prints without switching separators.
 */
export function solAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000) return compact(value);
  return value.toLocaleString("en", { maximumFractionDigits: value < 1 ? 6 : 2 });
}

export function percent(fraction: number): string {
  return `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(fraction >= 0.9995 ? 0 : 2)}%`;
}
