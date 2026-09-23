# Icon glyphs

Raster glyphs for `src/icons`. Every icon component renders a masked span whose mask points at one
of these PNGs, so the glyph paints in `currentColor` (or the lime/orange accent tint) instead of
shipping a colour variant per file.

## Contract

- One PNG per `IconName`. The file name is the icon's registry key, exactly, in camelCase plus `.png`:
  `home.png`, `mine.png`, `arrowUpRight.png`, `externalLink.png`, `collapseSidebar.png`.
- The 67 names below are enforced by `src/icons/icons.test.tsx`: every `IconName` must have its own
  matching PNG.
- Served at `/assets/icons/<name>.png`. Vite copies `public/` verbatim, so dev and production use
  the same path.
- Transparent background, one opaque shape. The colour in the file does not matter — the PNG is
  used as a CSS mask and repainted, so draw it in flat black or white.
- Canvas: square, 96x96 minimum, 192x192 preferred for retina. Keep the glyph inside roughly 84%
  of the frame (about 8% padding per side) so nothing clips at 16px.
- Chunky flat art to match the game and brand art: heavy strokes (4-6px at 96px) or solid shapes,
  round-ish caps, no gradients, no drop shadows, no text, and nothing traced from an icon pack.
- A missing PNG fails the icon asset audit. A known `IconName` must always resolve to its own file;
  the readable fallback is only for names outside the registry.

## The 67 names

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

## The saved star

`watchlistFilled.png` is the watchlist's second asset: `<IconWatchlist filled />` and
`<IconWatchlistFilled />` both point at it. It is the only icon with two assets — every other
component ignores `filled` and repaints its single glyph, so a missing variant can never blank an
icon out. Keep the star's outline identical to `watchlist.png` so the toggle does not jump.

## Reviewing the set

- `node scripts/dev/icon-sheet.mjs` writes a contact sheet of every asset at 2x (48px) and prints
  the names that are still missing.
- `src/dev/IconGallery.tsx` renders the same set in the browser with both accent tints, the filled
  variants and the 16/24/32/48 size scale.
- `npm test` covers the contract: every component must request `/assets/icons/<name>.png`.
