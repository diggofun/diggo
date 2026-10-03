/**
 * The drawn glyph for every icon name, in one style: a 24x24 grid, a 2.4 stroke with round caps
 * and round joins, and soft filled shapes where a shape reads better than an outline. Nothing has a
 * sharp corner, so the icons sit next to the bots without looking like a different family.
 *
 * Each entry is the inside of an <svg viewBox="0 0 24 24"> that Glyph.tsx draws with
 * stroke="currentColor" and fill="none"; a part that should be solid sets fill="currentColor".
 */
import type { ReactNode } from "react";
import type { IconName } from "./names";

const solid = { fill: "currentColor" } as const;
const dot = { fill: "currentColor", stroke: "none" } as const;

const STAR = "M12 3.8l2.5 5.2l5.6.7l-4.1 3.9l1 5.6L12 16.5l-5 2.7l1-5.6l-4.1-3.9l5.6-.7z";
const FLAME =
  "M12 21c3.9 0 7-2.8 7-6.6c0-3.6-2.6-6.1-4.4-8.4c-.4 2-1.4 3.2-2.6 3.8C12 6.8 10.6 4.2 8.3 3c.4 3.4-3.3 6-3.3 11.4C5 18.2 8.1 21 12 21z";

export const ICON_GLYPHS: Record<IconName, ReactNode> = {
  admin: (
    <>
      <path d="M12 3.2l7 3v5c0 4.4-3 8-7 10c-4-2-7-5.6-7-10v-5z" />
      <path d="M9 12l2 2l4-4" />
    </>
  ),
  arrowDownRight: <path d="M7 7l10 10M17 9v8H9" />,
  arrowUpRight: <path d="M7 17L17 7M9 7h8v8" />,
  badge: (
    <>
      <circle cx="12" cy="9" r="5" />
      <path d="M9.2 13.5L8.2 20.5l3.8-2l3.8 2l-1-7" />
    </>
  ),
  balance: (
    <>
      <path d="M12 4.5v15M8.5 19.5h7M5 7.5h14" />
      <path d="M5 7.5l-2.5 6h5z M19 7.5l-2.5 6h5z" {...solid} />
    </>
  ),
  ban: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M6.2 6.2l11.6 11.6" />
    </>
  ),
  bell: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15z" />
      <path d="M10 21h4" />
    </>
  ),
  bellOff: (
    <>
      <path d="M6 16v-5a6 6 0 0 1 9.4-4.9M18 11v5l1.5 2H9" />
      <path d="M10 21h4M4 4l16 16" />
    </>
  ),
  bolt: <path d="M13 2.5L5.5 13h6l-1 8.5L18.5 11h-6z" {...solid} />,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  chevronDown: <path d="M6 9.5l6 6l6-6" />,
  chevronLeft: <path d="M14.5 6l-6 6l6 6" />,
  chevronRight: <path d="M9.5 6l6 6l-6 6" />,
  chevronUp: <path d="M6 14.5l6-6l6 6" />,
  claim: (
    <>
      <path d="M12 4v9.5M8 9.5l4 4l4-4" />
      <path d="M4.5 15v2.5a2.5 2.5 0 0 0 2.5 2.5h10a2.5 2.5 0 0 0 2.5-2.5V15" />
    </>
  ),
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  collapseSidebar: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="4" />
      <path d="M9 4.5v15M15.5 10l-2 2l2 2" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11.5" height="11.5" rx="3.5" />
      <path d="M15.5 8.5V7A3 3 0 0 0 12.5 4H7a3 3 0 0 0-3 3v5.5a3 3 0 0 0 3 3h1.5" />
    </>
  ),
  cosmetics: (
    <>
      <path d="M11 3.5c.6 4.2 2.8 6.4 7 7c-4.2.6-6.4 2.8-7 7c-.6-4.2-2.8-6.4-7-7c4.2-.6 6.4-2.8 7-7z" {...solid} />
      <path d="M18.5 16v4M16.5 18h4" />
    </>
  ),
  create: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="5" />
      <path d="M12 8.5v7M8.5 12h7" />
    </>
  ),
  crew: (
    <>
      <path d="M3.5 18.5v-4.2a4.6 4.6 0 0 1 9.2 0v4.2z" />
      <path d="M14.5 18.5v-3a3.3 3.3 0 0 1 6.6 0v3z" {...solid} />
      <circle cx="8.6" cy="14" r="1.1" {...dot} />
      <circle cx="10.6" cy="14" r="1.1" {...dot} />
    </>
  ),
  dashboard: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="2.4" />
      <rect x="13" y="4" width="7" height="7" rx="2.4" />
      <rect x="4" y="13" width="7" height="7" rx="2.4" />
      <rect x="13" y="13" width="7" height="7" rx="2.4" />
    </>
  ),
  discoveries: (
    <>
      <path d="M7.5 4.5h9l4 5L12 19.5L3.5 9.5z" />
      <path d="M3.5 9.5h17" />
    </>
  ),
  explore: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M15.5 8.5l-2 5l-5 2l2-5z" {...solid} />
    </>
  ),
  externalLink: (
    <>
      <path d="M14 4h6v6M20 4l-8 8" />
      <path d="M18 14v3a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h3" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12s3.5-6.5 9.5-6.5s9.5 6.5 9.5 6.5s-3.5 6.5-9.5 6.5S2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="2.8" {...solid} />
    </>
  ),
  filter: <path d="M4.5 6.5h15M7.5 12h9M10.5 17.5h3" />,
  fire: <path d={FLAME} />,
  gauge: (
    <>
      <path d="M4.5 17a8.5 8.5 0 1 1 15 0" />
      <path d="M12 14l3.5-4.5" />
      <circle cx="12" cy="14" r="1.8" {...dot} />
    </>
  ),
  hammer: (
    <>
      <path d="M13.5 9.5L5 18a1.9 1.9 0 0 0 2.7 2.7l8.5-8.5" />
      <path d="M10 5.5h5.5l4 4l-2.5 2.5l-3.5-3.5H10z" {...solid} />
    </>
  ),
  history: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
      <path d="M4.5 4.5V9H9M12 8.5V12l2.5 1.5" />
    </>
  ),
  home: <path d="M4 11l8-6.5l8 6.5v7.5a2 2 0 0 1-2 2h-3.5v-5h-5v5H6a2 2 0 0 1-2-2z" />,
  hourglass: (
    <>
      <path d="M7 3.5h10M7 20.5h10" />
      <path d="M8 3.5c0 4.5 8 4.2 8 8.5s-8 4-8 8.5M16 3.5c0 4.5-8 4.2-8 8.5s8 4 8 8.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5" />
      <circle cx="12" cy="7.8" r="1.4" {...dot} />
    </>
  ),
  landmark: (
    <>
      <path d="M3.5 9.5L12 4l8.5 5.5z" {...solid} />
      <path d="M6.5 12.5v5M10.5 12.5v5M13.5 12.5v5M17.5 12.5v5M4 20.5h16" />
    </>
  ),
  layers: (
    <>
      <path d="M12 4l8.5 4.5L12 13L3.5 8.5z" {...solid} />
      <path d="M3.5 12.5L12 17l8.5-4.5M3.5 16.5L12 21l8.5-4.5" />
    </>
  ),
  leaderboards: (
    <>
      <path d="M8 4.5h8v4a4 4 0 0 1-8 0z" {...solid} />
      <path d="M8 6.5H5.5a3 3 0 0 0 3 4M16 6.5h2.5a3 3 0 0 1-3 4M12 12.5v6M8.5 19.5h7" />
    </>
  ),
  legal: (
    <>
      <path d="M7 3.5h7l4.5 4.5v10.5a2.5 2.5 0 0 1-2.5 2.5H7a2.5 2.5 0 0 1-2.5-2.5V6A2.5 2.5 0 0 1 7 3.5z" />
      <path d="M8.5 12.5h7M8.5 16.5h5" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="3.5" {...solid} />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </>
  ),
  logout: (
    <>
      <path d="M10 4.5H7A2.5 2.5 0 0 0 4.5 7v10A2.5 2.5 0 0 0 7 19.5h3" />
      <path d="M14 8l4 4l-4 4M18 12H9.5" />
    </>
  ),
  menu: <path d="M5 7h14M5 12h14M5 17h14" />,
  mine: (
    <>
      <path d="M5 19.5l10-10" />
      <path d="M4.5 9.5C8.5 5 14.5 3.8 20 4.5c.7 5.5-.5 11.5-5 15.5c1.3-4.3 1.2-8.6-.5-10.7c-2.4-1.5-6.4-1.4-10 .2z" {...solid} />
    </>
  ),
  mines: <path d="M3.5 19l6-9.5l4 5.5l2.5-3l4.5 7z" {...solid} />,
  minus: <path d="M6 12h12" />,
  ore: <path d="M8 5.5h7l4.5 5l-2 7.5H7l-3-6z" {...solid} />,
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  portfolio: (
    <>
      <rect x="3.5" y="7" width="17" height="12.5" rx="3.5" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 12.5h17" />
    </>
  ),
  profile: (
    <>
      <circle cx="12" cy="8.5" r="3.8" {...solid} />
      <path d="M5 20c.8-3.6 3.6-6 7-6s6.2 2.4 7 6" />
    </>
  ),
  radio: (
    <>
      <circle cx="12" cy="12" r="2" {...dot} />
      <path d="M8.5 15.5a5 5 0 0 1 0-7M15.5 8.5a5 5 0 0 1 0 7M5.6 18.4a9 9 0 0 1 0-12.8M18.4 5.6a9 9 0 0 1 0 12.8" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  reject: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
    </>
  ),
  rentReclaim: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.5 9.5H11a1.8 1.8 0 0 0 0 3.6h2a1.8 1.8 0 0 1 0 3.6H9.5M12 7.5v1.8M12 16.7v1.8" />
    </>
  ),
  rocket: (
    <>
      <path d="M12 3c3.5 2 5.5 5.5 5.5 9.5L15 16H9l-2.5-3.5C6.5 8.5 8.5 5 12 3z" />
      <circle cx="12" cy="10" r="1.8" {...dot} />
      <path d="M10 19.5c.6.7 1.3 1.1 2 1.3c.7-.2 1.4-.6 2-1.3M6.5 12.5L4.5 16l2.5.5M17.5 12.5l2 3.5l-2.5.5" />
    </>
  ),
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15 15l4.5 4.5" />
    </>
  ),
  settings: (
    <>
      <path d="M5 7h7.5M17.5 7H19M5 17h1.5M11.5 17H19" />
      <circle cx="15" cy="7" r="2.5" />
      <circle cx="9" cy="17" r="2.5" />
    </>
  ),
  snowflake: (
    <>
      <path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9" />
      <path d="M9.5 4.5L12 6l2.5-1.5M9.5 19.5L12 18l2.5 1.5" />
    </>
  ),
  sort: <path d="M8 5v14M5 16l3 3l3-3M16 19V5M13 8l3-3l3 3" />,
  streak: <path d={FLAME} {...solid} />,
  swap: <path d="M5 8.5h13M15 5l3.5 3.5L15 12M19 15.5H6M9 12l-3.5 3.5L9 19" />,
  timer: (
    <>
      <circle cx="12" cy="13" r="7.5" />
      <path d="M12 9.5V13l2.5 1.5M10 3h4" />
    </>
  ),
  trade: (
    <>
      <path d="M7 4v16M17 4v16" />
      <rect x="5" y="8" width="4" height="7" rx="1.5" {...solid} />
      <rect x="15" y="6" width="4" height="9" rx="1.5" {...solid} />
    </>
  ),
  unlock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="3.5" {...solid} />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.8-1.2" />
    </>
  ),
  userGroup: (
    <>
      <circle cx="12" cy="8" r="3.2" {...solid} />
      <circle cx="5.5" cy="10" r="2.2" />
      <circle cx="18.5" cy="10" r="2.2" />
      <path d="M7 19c.7-3 2.6-4.8 5-4.8s4.3 1.8 5 4.8M2.5 17.5c.4-1.8 1.6-3 3.2-3.2M21.5 17.5c-.4-1.8-1.6-3-3.2-3.2" />
    </>
  ),
  wallet: (
    <>
      <rect x="3.5" y="6" width="17" height="13.5" rx="4" />
      <path d="M16.5 12.75h1" />
      <path d="M6.5 6l8.5-2.5a1.5 1.5 0 0 1 1.9 1.4V6" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 4.6a2 2 0 0 1 3.4 0l7.5 13a2 2 0 0 1-1.7 3H4.5a2 2 0 0 1-1.7-3z" />
      <path d="M12 9.5V14" />
      <circle cx="12" cy="17.2" r="1.3" {...dot} />
    </>
  ),
  watchlist: <path d={STAR} />,
  watchlistFilled: <path d={STAR} {...solid} />,
};
