/**
 * Diggo.fun icon set.
 *
 * Every icon is a raster glyph masked into a span: the PNG under public/assets/icons paints in
 * currentColor (or an accent tint) through icons.css, so one asset serves every ink colour and a
 * missing asset leaves an empty box instead of shifting the layout. Import icons from here,
 * never from an icon pack.
 */
import "./icons.css";
import type { ComponentType } from "react";
import type { IconName } from "./names";
import type { IconProps } from "./types";

export { IconAdmin } from "./IconAdmin";
export { IconArrowDownRight } from "./IconArrowDownRight";
export { IconArrowUpRight } from "./IconArrowUpRight";
export { IconBadge } from "./IconBadge";
export { IconBalance } from "./IconBalance";
export { IconBan } from "./IconBan";
export { IconBell } from "./IconBell";
export { IconBellOff } from "./IconBellOff";
export { IconBolt } from "./IconBolt";
export { IconCheck } from "./IconCheck";
export { IconChevronDown } from "./IconChevronDown";
export { IconChevronLeft } from "./IconChevronLeft";
export { IconChevronRight } from "./IconChevronRight";
export { IconChevronUp } from "./IconChevronUp";
export { IconClaim } from "./IconClaim";
export { IconClose } from "./IconClose";
export { IconCollapseSidebar } from "./IconCollapseSidebar";
export { IconCopy } from "./IconCopy";
export { IconCosmetics } from "./IconCosmetics";
export { IconCreate } from "./IconCreate";
export { IconCrew } from "./IconCrew";
export { IconDashboard } from "./IconDashboard";
export { IconDiscoveries } from "./IconDiscoveries";
export { IconExplore } from "./IconExplore";
export { IconExternalLink } from "./IconExternalLink";
export { IconEye } from "./IconEye";
export { IconFilter } from "./IconFilter";
export { IconFire } from "./IconFire";
export { IconGauge } from "./IconGauge";
export { IconHammer } from "./IconHammer";
export { IconHistory } from "./IconHistory";
export { IconHome } from "./IconHome";
export { IconHourglass } from "./IconHourglass";
export { IconInfo } from "./IconInfo";
export { IconLandmark } from "./IconLandmark";
export { IconLayers } from "./IconLayers";
export { IconLeaderboards } from "./IconLeaderboards";
export { IconLegal } from "./IconLegal";
export { IconLock } from "./IconLock";
export { IconLogout } from "./IconLogout";
export { IconMenu } from "./IconMenu";
export { IconMine } from "./IconMine";
export { IconMines } from "./IconMines";
export { IconMinus } from "./IconMinus";
export { IconOre } from "./IconOre";
export { IconPlus } from "./IconPlus";
export { IconPortfolio } from "./IconPortfolio";
export { IconProfile } from "./IconProfile";
export { IconRadio } from "./IconRadio";
export { IconRefresh } from "./IconRefresh";
export { IconReject } from "./IconReject";
export { IconRentReclaim } from "./IconRentReclaim";
export { IconRocket } from "./IconRocket";
export { IconSearch } from "./IconSearch";
export { IconSettings } from "./IconSettings";
export { IconSnowflake } from "./IconSnowflake";
export { IconSort } from "./IconSort";
export { IconStreak } from "./IconStreak";
export { IconSwap } from "./IconSwap";
export { IconTimer } from "./IconTimer";
export { IconTrade } from "./IconTrade";
export { IconUnlock } from "./IconUnlock";
export { IconUserGroup } from "./IconUserGroup";
export { IconWallet } from "./IconWallet";
export { IconWarning } from "./IconWarning";
export { IconWatchlist } from "./IconWatchlist";
export { IconWatchlistFilled } from "./IconWatchlistFilled";

import { IconAdmin } from "./IconAdmin";
import { IconArrowDownRight } from "./IconArrowDownRight";
import { IconArrowUpRight } from "./IconArrowUpRight";
import { IconBadge } from "./IconBadge";
import { IconBalance } from "./IconBalance";
import { IconBan } from "./IconBan";
import { IconBell } from "./IconBell";
import { IconBellOff } from "./IconBellOff";
import { IconBolt } from "./IconBolt";
import { IconCheck } from "./IconCheck";
import { IconChevronDown } from "./IconChevronDown";
import { IconChevronLeft } from "./IconChevronLeft";
import { IconChevronRight } from "./IconChevronRight";
import { IconChevronUp } from "./IconChevronUp";
import { IconClaim } from "./IconClaim";
import { IconClose } from "./IconClose";
import { IconCollapseSidebar } from "./IconCollapseSidebar";
import { IconCopy } from "./IconCopy";
import { IconCosmetics } from "./IconCosmetics";
import { IconCreate } from "./IconCreate";
import { IconCrew } from "./IconCrew";
import { IconDashboard } from "./IconDashboard";
import { IconDiscoveries } from "./IconDiscoveries";
import { IconExplore } from "./IconExplore";
import { IconExternalLink } from "./IconExternalLink";
import { IconEye } from "./IconEye";
import { IconFilter } from "./IconFilter";
import { IconFire } from "./IconFire";
import { IconGauge } from "./IconGauge";
import { IconHammer } from "./IconHammer";
import { IconHistory } from "./IconHistory";
import { IconHome } from "./IconHome";
import { IconHourglass } from "./IconHourglass";
import { IconInfo } from "./IconInfo";
import { IconLandmark } from "./IconLandmark";
import { IconLayers } from "./IconLayers";
import { IconLeaderboards } from "./IconLeaderboards";
import { IconLegal } from "./IconLegal";
import { IconLock } from "./IconLock";
import { IconLogout } from "./IconLogout";
import { IconMenu } from "./IconMenu";
import { IconMine } from "./IconMine";
import { IconMines } from "./IconMines";
import { IconMinus } from "./IconMinus";
import { IconOre } from "./IconOre";
import { IconPlus } from "./IconPlus";
import { IconPortfolio } from "./IconPortfolio";
import { IconProfile } from "./IconProfile";
import { IconRadio } from "./IconRadio";
import { IconRefresh } from "./IconRefresh";
import { IconReject } from "./IconReject";
import { IconRentReclaim } from "./IconRentReclaim";
import { IconRocket } from "./IconRocket";
import { IconSearch } from "./IconSearch";
import { IconSettings } from "./IconSettings";
import { IconSnowflake } from "./IconSnowflake";
import { IconSort } from "./IconSort";
import { IconStreak } from "./IconStreak";
import { IconSwap } from "./IconSwap";
import { IconTimer } from "./IconTimer";
import { IconTrade } from "./IconTrade";
import { IconUnlock } from "./IconUnlock";
import { IconUserGroup } from "./IconUserGroup";
import { IconWallet } from "./IconWallet";
import { IconWarning } from "./IconWarning";
import { IconWatchlist } from "./IconWatchlist";
import { IconWatchlistFilled } from "./IconWatchlistFilled";

/** Every icon in the set, keyed by its asset name. */
export const ICON_REGISTRY: Record<IconName, ComponentType<IconProps>> = {
  admin: IconAdmin,
  arrowDownRight: IconArrowDownRight,
  arrowUpRight: IconArrowUpRight,
  badge: IconBadge,
  balance: IconBalance,
  ban: IconBan,
  bell: IconBell,
  bellOff: IconBellOff,
  bolt: IconBolt,
  check: IconCheck,
  chevronDown: IconChevronDown,
  chevronLeft: IconChevronLeft,
  chevronRight: IconChevronRight,
  chevronUp: IconChevronUp,
  claim: IconClaim,
  close: IconClose,
  collapseSidebar: IconCollapseSidebar,
  copy: IconCopy,
  cosmetics: IconCosmetics,
  create: IconCreate,
  crew: IconCrew,
  dashboard: IconDashboard,
  discoveries: IconDiscoveries,
  explore: IconExplore,
  externalLink: IconExternalLink,
  eye: IconEye,
  filter: IconFilter,
  fire: IconFire,
  gauge: IconGauge,
  hammer: IconHammer,
  history: IconHistory,
  home: IconHome,
  hourglass: IconHourglass,
  info: IconInfo,
  landmark: IconLandmark,
  layers: IconLayers,
  leaderboards: IconLeaderboards,
  legal: IconLegal,
  lock: IconLock,
  logout: IconLogout,
  menu: IconMenu,
  mine: IconMine,
  mines: IconMines,
  minus: IconMinus,
  ore: IconOre,
  plus: IconPlus,
  portfolio: IconPortfolio,
  profile: IconProfile,
  radio: IconRadio,
  refresh: IconRefresh,
  reject: IconReject,
  rentReclaim: IconRentReclaim,
  rocket: IconRocket,
  search: IconSearch,
  settings: IconSettings,
  snowflake: IconSnowflake,
  sort: IconSort,
  streak: IconStreak,
  swap: IconSwap,
  timer: IconTimer,
  trade: IconTrade,
  unlock: IconUnlock,
  userGroup: IconUserGroup,
  wallet: IconWallet,
  warning: IconWarning,
  watchlist: IconWatchlist,
  watchlistFilled: IconWatchlistFilled,
};

export {
  FILLED_VARIANTS,
  ICON_ASSET_NAMES,
  ICON_NAMES,
  hasIconAsset,
  iconAsset,
  iconAssetStem,
  iconFallbackText,
  type IconName,
} from "./names";
export { ACCENT_FILL, accentFill, type AccentName, type IconProps, type IconStyle } from "./types";
export { IconGlyph, type IconGlyphProps } from "./Glyph";
