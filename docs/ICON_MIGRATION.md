# Icons, bots and brand files

The UI draws everything it shows: one rounded icon set, the bots, and the rocks they dig. There are
no icon packs and no raster game art.

## Icons (`src/icons`)

Every icon is a drawn SVG glyph in `src/icons/glyphs.tsx`, on a 24x24 grid with a 2.4 stroke,
round caps and round joins; parts that read better solid set `fill="currentColor"`. The components
(`IconMine`, `IconHome`, ...) keep their names and props:

- `size` — number is px, or any CSS length. Without it the 1em box from `icons.css` applies.
- `className` — appended to `icon`, so layout classes compose normally.
- `title` — accessible name plus tooltip; without it the icon is decorative and renders
  `aria-hidden`, so it never lands in the accessibility tree twice next to a visible label.
- `filled` — draws `watchlistFilled` for the watchlist star, the only icon with a filled variant.
- `accent` — `lime` or `orange`, paints the glyph in that tint instead of currentColor.

`src/icons/icons.test.tsx` fails if a registered name has no drawing, or if a glyph loses the
shared round stroke. To add an icon: add the name to `ICON_NAMES`, draw it in `glyphs.tsx`, add an
`Icon*.tsx` wrapper and export it from `index.ts`.

## Bots (`src/components/Bot.tsx`)

The bots come from LowBot's bot characters: sixteen shapes, sixteen colours, a hat (hard hat, cap,
beanie, crown, party hat, bow, top hat) and eyewear (glasses, shades, goggles). Outlines are drawn
with a stroke in the body colour and round joins, so every corner is soft. Moods: `idle` (float,
look around, turn round now and then), `busy` (hop), `dig` (pickaxe loop), `work` (the mine
routine: swings at a rock, a hop, a look the other way) and `attention` (wiggle). `botFor(seed)`
and `botAt(index)` pick stable looks, so the same coin, wallet or slot always shows the same bot.

`src/components/BotMine.tsx` draws the mine: bots beside rocks, crystals and nuggets, chips flying
on every strike. `MineScene` sizes the crew from the crew tier.

## Brand files (`public/assets/brand`)

`scripts/brand/make-bot-brand.mjs` builds every brand file from `scripts/brand/source`: the
transparent mark and wordmark (the backdrop is removed by flooding inward from the image border,
so the bots' eyes stay), the favicons, the app icons and the social card `public/og-image-v4.jpg` (the banner, shown when a link is shared).
`/assets/*` is served as immutable, so a changed icon needs a new `?v=` in `index.html` and the
manifest.
