# Icon migration: lucide-react to src/icons

The v2 UI moves off icon packs and off vector drawing. Every icon in `src/icons` is now a raster
glyph: the component keeps its exported name and props API and renders a masked span whose mask
points at a PNG under `/assets/icons`. This document maps every `lucide-react` import that exists
in `src/` today to its replacement, and lists the asset names the art has to provide.

## How a glyph renders

`src/icons/icons.css` (imported once by `src/icons/index.ts`) defines `.icon`: a 1em box, a
`background-color` of `var(--icon-color, currentColor)`, and `mask-image: var(--icon)`. Each
component renders nothing but that span:

```html
<span class="icon" aria-hidden="true" data-icon="mine" style="--icon:url(/assets/icons/mine.png)"></span>
```

Because the PNG is used as a mask, one asset serves every ink colour and tint. The props are:

- `size` — number is px, or any CSS length. Without it the 1em box from `icons.css` applies.
- `className` — appended to `icon`, so layout classes compose normally.
- `title` — accessible name plus tooltip; without it the icon is decorative and renders
  `aria-hidden`, so it never lands in the accessibility tree twice next to a visible label.
- `filled` — asks for `watchlistFilled.png` on the watchlist, the only icon with a second asset;
  every other icon ignores it and keeps painting its single glyph.
- `accent` — `lime` or `orange`, paints the mask in that brand tint instead of currentColor.

Any other span attribute (`onClick`, `aria-*`, `data-*`) is forwarded. `strokeWidth` is gone: the
stroke weight is baked into the PNG.

Every `IconName` must have its own matching PNG. `src/icons/icons.test.tsx` fails if a registered
icon is missing its asset; the readable fallback is reserved for names outside the registry.

## Importing

```tsx
// before
import { Pickaxe, Coins, X } from "lucide-react";

// after
import { IconMine, IconBalance, IconClose } from "../icons";
```

## Asset naming

- One PNG per `IconName` in `public/assets/icons`, and the file name is the icon's registry key exactly,
  in camelCase: `arrowUpRight.png`, `externalLink.png`, `collapseSidebar.png`, `userGroup.png`.
- The 67 keys below are enforced by `src/icons/icons.test.tsx`, including `watchlistFilled` for the
  saved star.
- Square, transparent, one opaque shape (the colour is ignored — it is a mask), 96x96 minimum,
  glyph inside about 84% of the frame. Full brief in `public/assets/icons/README.md`.

The 67 keys, which are also the `ICON_REGISTRY` keys and the asset file names:

```
admin          arrowDownRight arrowUpRight   badge          balance        ban
bell           bellOff        bolt           check          chevronDown   close
chevronLeft    chevronRight   chevronUp      claim          collapseSidebar
copy           cosmetics      create         crew           dashboard      discoveries
explore        externalLink   eye            filter         fire           gauge
hammer         history        home           hourglass      info           landmark
layers         leaderboards   legal          lock           logout         menu
mine           mines          minus          ore            plus           portfolio
profile        radio          refresh        reject         rentReclaim    rocket         search
settings       snowflake      sort           streak         swap           timer
trade          unlock         userGroup      wallet         warning        watchlist
watchlistFilled
```

## Symbol map

All 53 lucide names currently imported in `src/`, plus the props type:

| lucide-react | replacement | notes |
| --- | --- | --- |
| `AlertOctagon` | `IconWarning` | one alert glyph for the whole set |
| `AlertTriangle` | `IconWarning` | |
| `ArrowDownRight` | `IconArrowDownRight` | |
| `ArrowUpRight` | `IconArrowUpRight` | |
| `Award` | `IconBadge` | rosette with a tick |
| `BadgeCheck` | `IconBadge` | |
| `Ban` | `IconBan` | |
| `Bell` | `IconBell` | one asset — `filled` repeats the outline |
| `BellOff` | `IconBellOff` | |
| `BellRing` | `IconBell` | no ringing asset; use `accent="orange"` |
| `Check` | `IconCheck` | |
| `ChevronRight` | `IconChevronRight` | left, up and down are exported too |
| `Clock3` | `IconHistory` | `IconTimer` when the meaning is a countdown |
| `Coins` | `IconBalance` | SOL coin: circle plus the three-bar mark |
| `Compass` | `IconExplore` | |
| `Copy` | `IconCopy` | |
| `ExternalLink` | `IconExternalLink` | |
| `Eye` | `IconEye` | |
| `Flame` | `IconFire` | `IconStreak` for the daily streak counter |
| `Gauge` | `IconGauge` | |
| `Gavel` | `IconAdmin` | no gavel glyph; moderation reads as the shield |
| `Gem` | `IconDiscoveries` | |
| `Hammer` | `IconHammer` | |
| `HardHat` | `IconCrew` | helmet with a front lamp |
| `Home` | `IconHome` | |
| `Hourglass` | `IconHourglass` | |
| `Landmark` | `IconLandmark` | |
| `Layers` | `IconLayers` | |
| `LayoutDashboard` | `IconDashboard` | |
| `Lock` | `IconLock` | |
| `LockKeyhole` | `IconLock` | |
| `Menu` | `IconMenu` | |
| `Minus` | `IconMinus` | |
| `OctagonAlert` | `IconWarning` | |
| `Pickaxe` | `IconMine` | |
| `Plus` | `IconPlus` | `IconCreate` when the plus sits in a square |
| `Radio` | `IconRadio` | live dot with signal arcs |
| `RefreshCw` | `IconRefresh` | |
| `Repeat2` | `IconSwap` | |
| `Search` | `IconSearch` | |
| `ShieldAlert` | `IconWarning` | `IconAdmin` when the shield itself is the point |
| `ShieldCheck` | `IconAdmin` | |
| `Shirt` | `IconCosmetics` | |
| `Snowflake` | `IconSnowflake` | |
| `Sparkles` | `IconCosmetics` | |
| `Timer` | `IconTimer` | |
| `TrendingUp` | `IconTrade` | for inline deltas prefer `IconArrowUpRight` |
| `Trophy` | `IconLeaderboards` | three-step podium |
| `Unlock` | `IconUnlock` | |
| `Users` | `IconUserGroup` | |
| `Wallet` | `IconWallet` | |
| `X` | `IconClose` | |
| `Zap` | `IconBolt` | |
| `type LucideProps` | `type IconProps` | from `src/icons` |

## Per file

Every file that imports `lucide-react` today, with its symbols in place:

| file | replacements |
| --- | --- |
| `src/App.tsx` | `ArrowUpRight` → `IconArrowUpRight`, `Hammer` → `IconHammer`, `Plus` → `IconPlus` |
| `src/components/AdminScreen.tsx` | `AlertOctagon`/`OctagonAlert`/`ShieldAlert`/`AlertTriangle`-style alerts → `IconWarning` (three of them collapse; separate severity with colour), `Ban` → `IconBan`, `Check` → `IconCheck`, `Eye` → `IconEye`, `Gavel` → `IconAdmin`, `Lock` → `IconLock`, `RefreshCw` → `IconRefresh`, `X` → `IconClose`, `Zap` → `IconBolt` |
| `src/components/AppHeader.tsx` | `Gem` → `IconDiscoveries`, `Hammer` → `IconHammer`, `Home` → `IconHome`, `LayoutDashboard` → `IconDashboard`, `Menu` → `IconMenu`, `Pickaxe` → `IconMine`, `Plus` → `IconPlus`, `Search` → `IconSearch`, `Sparkles` → `IconCosmetics`, `TrendingUp` → `IconTrade`, `Trophy` → `IconLeaderboards`, `Wallet` → `IconWallet`, `X` → `IconClose`; the nav item type becomes `ComponentType<IconProps>` |
| `src/components/ConsentBanner.tsx` | `X` → `IconClose` |
| `src/components/CosmeticsScreen.tsx` | `Check` → `IconCheck`, `Lock` → `IconLock`, and `Shirt`/`Sparkles` both → `IconCosmetics` (use it once per heading) |
| `src/components/CrewScreen.tsx` | `ArrowUpRight` → `IconArrowUpRight`, `Gem` → `IconDiscoveries`, `Hammer` → `IconHammer`, `Hourglass` → `IconHourglass`, `Lock` → `IconLock`, `X` → `IconClose` |
| `src/components/DashboardPanel.tsx` | `Clock3` → `IconHistory`, `Coins` → `IconBalance`, `Flame` → `IconFire`, `Gauge` → `IconGauge`, `Hammer` → `IconHammer`, `Hourglass` → `IconHourglass`, `Pickaxe` → `IconMine`, `Repeat2` → `IconSwap`, `Snowflake` → `IconSnowflake`, `Timer` → `IconTimer`, `Users` → `IconUserGroup`, `Wallet` → `IconWallet` |
| `src/components/DiscoveriesPanel.tsx` | `Compass` → `IconExplore`, `ExternalLink` → `IconExternalLink`, `Gem` → `IconDiscoveries`, `Pickaxe` → `IconMine`, `Repeat2` → `IconSwap`, `Sparkles` → `IconCosmetics`, `TrendingUp` → `IconTrade` |
| `src/components/EconomyPanels.tsx` | `Award` → `IconBadge`, `Coins` → `IconBalance`, `ExternalLink` → `IconExternalLink`, `Gem` → `IconDiscoveries`, `Layers` → `IconLayers`, `Sparkles` → `IconCosmetics`, `TrendingUp` → `IconTrade` |
| `src/components/HomeSections.tsx` | `ArrowDownRight` → `IconArrowDownRight`, `ArrowUpRight` → `IconArrowUpRight`, `Check` → `IconCheck`, `ChevronRight` → `IconChevronRight`, `Clock3` → `IconHistory`, `Coins` → `IconBalance`, `Copy` → `IconCopy`, `Flame` → `IconFire`, `Gauge` → `IconGauge`, `Gem` → `IconDiscoveries`, `Hammer` → `IconHammer`, `HardHat` → `IconCrew`, `LockKeyhole` → `IconLock`, `Minus` → `IconMinus`, `Pickaxe` → `IconMine`, `Plus` → `IconPlus`, `Radio` → `IconRadio`, `ShieldCheck` → `IconAdmin`, `TrendingUp` → `IconTrade`, `Users` → `IconUserGroup`; drop `strokeWidth={1.25}` from the hero pickaxe — use `size` and let the PNG carry the weight |
| `src/components/LaunchModal.tsx` | `BadgeCheck` → `IconBadge`, `Check` → `IconCheck`, `Pickaxe` → `IconMine`, `Sparkles` → `IconCosmetics`, `X` → `IconClose` |
| `src/components/LeaderboardsScreen.tsx` | `Trophy` → `IconLeaderboards` |
| `src/components/MineInfoPanel.tsx` | `AlertTriangle` → `IconWarning`, `Clock3` → `IconHistory`, `Gauge` → `IconGauge`, `Layers` → `IconLayers`, `Pickaxe` → `IconMine`, `Repeat2` → `IconSwap`, `TrendingUp` → `IconTrade`, `Users` → `IconUserGroup` |
| `src/components/MiningReportModal.tsx` | `Coins` → `IconBalance`, `Compass` → `IconExplore`, `Hammer` → `IconHammer`, `Repeat2` → `IconSwap`, `Sparkles` → `IconCosmetics`, `X` → `IconClose` |
| `src/components/NotificationsBell.tsx` | `Bell` → `IconBell`, `BellRing` → `IconBell` with `filled`, `Check` → `IconCheck`, `RefreshCw` → `IconRefresh` |
| `src/components/PlayerOnboarding.tsx` | `Coins` → `IconBalance`, `Lock` → `IconLock`, `Pickaxe` → `IconMine`, `ShieldCheck` → `IconAdmin`, `Unlock` → `IconUnlock` |
| `src/components/PushToggle.tsx` | `Bell` → `IconBell`, `BellOff` → `IconBellOff` |
| `src/components/SponsorEventsPanel.tsx` | `Coins` → `IconBalance`, `Copy` → `IconCopy`, `Landmark` → `IconLandmark`, `Plus` → `IconPlus`, `ShieldCheck` → `IconAdmin`, `X` → `IconClose` |
| `src/components/StatusViews.tsx` | `AlertTriangle` → `IconWarning`, `Pickaxe` → `IconMine`, `RefreshCw` → `IconRefresh`; drop `strokeWidth={2.4}` |
| `src/components/SwapPanel.tsx` | `Check` → `IconCheck`, `Radio` → `IconRadio`, `TrendingUp` → `IconTrade`, `Wallet` → `IconWallet`, `Zap` → `IconBolt` |
| `src/components/SwitchMineModal.tsx` | `Pickaxe` → `IconMine`, `Repeat2` → `IconSwap`, `X` → `IconClose` |
| `src/components/VerificationGate.tsx` | `ShieldCheck` → `IconAdmin`, `X` → `IconClose` |
| `src/dev/UiGallery.tsx` | `BadgeCheck` → `IconBadge` |

## Accent tints

The old set could only fill one shape per icon. A mask can tint the whole glyph, so every icon now
takes `accent`: `accent="lime"` or `accent="orange"` paints the mask in that brand token instead
of currentColor. The tokens live in `ACCENT_FILL` in `src/icons/types.ts` and are the only
hard-coded colours left in the set — re-point them at the CSS custom properties once the icon
layer is wired up.

## After the migration

1. Update the 24 files above, then `rg -n lucide-react src` must come back empty.
2. Remove `lucide-react` from `package.json` and reinstall so `package-lock.json` drops it.
3. `npm run check` (types, typecheck, lint, tests, build, dry-run deploy).

## Verifying the set

- `npm test` runs `src/icons/icons.test.tsx`: every registry entry must render a span whose
  `--icon` points at `/assets/icons/<name>.png`, the registry is compared against the `Icon*.tsx`
  files on disk, and the title, size, accent and filled props are asserted.
- `node scripts/dev/icon-sheet.mjs` writes a contact sheet of every asset at 2x (48px) and lists
  the PNGs that are still missing, so it doubles as the art checklist.
- `src/dev/IconGallery.tsx` exports `<IconGallery />` for a dev-only review page (not routed yet):
  the full grid with asset names, both accent columns, the filled variants and the size scale.
