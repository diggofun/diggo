# Telegram Mini App

Diggo runs inside Telegram as a Mini App. The web app detects Telegram (`src/telegram.ts`), loads
Telegram's WebApp script, expands to full height and reads the launch parameter; the bot
(`worker/push.ts`) answers `/start` with a **Play Diggo** button that opens the Mini App.

## One-time setup in @BotFather

Use the bot that already sends Diggo alerts (`TELEGRAM_BOT_TOKEN`).

1. `/mybots` → your bot → **Bot Settings** → **Menu Button** → set URL `https://diggo.fun/mine`,
   title `Play`.
2. `/newapp` → choose the bot → title `Diggo`, a short description, a 640×360 image (use
   `public/og-image-v4.jpg` resized), URL `https://diggo.fun/mine`, short name `play`.
   This gives the direct link `https://t.me/<bot>/play`.
3. Optional: `/setdescription` and `/setabouttext` with one line about mining memecoins.

## Links to share

| Link | Opens |
| --- | --- |
| `https://t.me/<bot>/play` | the mine page |
| `https://t.me/<bot>/play?startapp=m_<mint>` | a mine link: the player's crew digs that coin |
| `https://t.me/<bot>/play?startapp=r_<code>` | a referral |
| `https://t.me/<bot>?start=m_<mint>` | the bot chat, with a Play button to that mine |

## Notes

- Inside Telegram there is no browser wallet extension. Players connect with WalletConnect
  (Phantom, Solflare and others) from the wallet menu; this already works in the app.
- `public/_headers` allows Telegram Web (`https://web.telegram.org`) to frame the app and loads
  `https://telegram.org/js/telegram-web-app.js`. Mobile and desktop Telegram open it directly.
