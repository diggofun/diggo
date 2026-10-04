# Marketing sources and funnels

Dashboard: [Diggo — źródła i kampanie](https://eu.posthog.com/project/274077/dashboard/996329).

Diggo's marketing dashboard uses the same PostHog EU project as the existing product funnels
(project `274077`). Campaign attribution starts only after the visitor allows analytics. It
applies to automatic pageviews and every tracked product action, including wallet connection,
mining activation, launch and swap confirmation.

## Campaign links

Use a tagged destination URL in every ad, profile bio, video description and sponsored post.
An in-app browser may hide its referrer, so explicit UTM tags are the reliable way to distinguish
ads from organic traffic. These examples can be pasted as ad destination URLs:

| Source | Example |
| --- | --- |
| TikTok ads | `https://diggo.fun/?utm_source=tiktok&utm_medium=paid_social&utm_campaign=launch_october&utm_content=video_01` |
| X ads | `https://diggo.fun/?utm_source=x&utm_medium=paid_social&utm_campaign=launch_october&utm_content=post_01` |
| YouTube ads | `https://diggo.fun/?utm_source=youtube&utm_medium=paid_video&utm_campaign=launch_october&utm_content=video_01` |
| Instagram ads | `https://diggo.fun/?utm_source=instagram&utm_medium=paid_social&utm_campaign=launch_october&utm_content=reel_01` |
| Facebook ads | `https://diggo.fun/?utm_source=facebook&utm_medium=paid_social&utm_campaign=launch_october&utm_content=post_01` |
| Google ads | `https://diggo.fun/?utm_source=google&utm_medium=cpc&utm_campaign=launch_october&utm_content=search_01` |
| Telegram post | `https://diggo.fun/?utm_source=telegram&utm_medium=social&utm_campaign=community_october&utm_content=post_01` |

For organic TikTok, X or YouTube posts, use `utm_medium=social`. Use a separate `utm_campaign`
for each campaign and `utm_content` for each creative. `utm_term` is optional. Labels may contain
letters, digits, spaces, dots, underscores, hyphens and tildes, up to 120 characters. Do not put
emails, wallet secrets, private URLs or other personal data in these labels.

Tags work on other paths too, including `/mine`, `/create` and `/r/<referral-code>`. Attribution
is read before the app cleans up referral URLs; the player referral and marketing source remain
separate concepts.

## Attribution properties

| Event property | Meaning |
| --- | --- |
| `traffic_source` | Latest non-direct source; `twitter` and `t.co` normalize to `x`, `yt` to `youtube`, `ig` to `instagram`, `fb` to `facebook` |
| `traffic_medium` | Tagged medium, or an inferred value such as `social`, `organic`, `referral`, `paid` or `none` |
| `traffic_campaign` | Campaign name, or `(none)` |
| `traffic_content` | Creative label, or `(none)` |
| `traffic_term` | Optional keyword label, or `(none)` |
| `traffic_referring_domain` | External referring domain without its path or query, or `(none)` |
| `traffic_paid` | Paid medium, or a recognized advertising click parameter without an explicit medium |
| `first_traffic_*` | The corresponding first-touch properties within the 30-day attribution window |

UTM source takes precedence over inferred click source and referrer. TikTok `ttclid`, X `twclid`
and Google `gclid`/`gbraid`/`wbraid` can identify an ad source; the custom attribution record does
not retain their values. `fbclid` alone is not treated as proof of a paid ad. Direct visits and
navigation between Diggo pages preserve the latest non-direct campaign until the record expires.
Custom sources such as `newsletter`, `reddit` or an influencer's label also work.

Before consent, the initial source exists only in page memory. Optional browser persistence is
created after consent, expires after 30 days and is removed on withdrawal. Visitors who deny
analytics are absent from PostHog funnels, and device/browser changes cannot be reliably joined
until the same wallet is identified.

## Creating your own funnel

Duplicate a source funnel in the marketing dashboard or create an insight with these steps:

- Player activation: `$pageview` → `wallet_connected` → `crew_activated`.
- Coin launch: `$pageview` → `launch_started` → `launch_form_submitted` → `launch_confirmed`.

Filter the **entry step only** by `traffic_source`, `traffic_campaign`, `traffic_content` and/or
`traffic_paid`. Later actions can occur on another page or visit without losing the entry cohort.
For a comparison insight, use an event-property breakdown at **step 0**, such as `traffic_source`
or `traffic_campaign`. The saved funnels use ordered steps, unique people, a 14-day conversion
window and the last 30 days, with project test accounts excluded.

New custom attribution starts with this deployment. Older events are not relabeled, and an empty
source funnel means no matching consented traffic has arrived yet. Funnel visits count actual
site visitors, not the advertising platform's impression or ad-click totals. This implementation
does not send conversion pixels to ad platforms or import advertising spend.

References: [PostHog UTM segmentation](https://posthog.com/docs/data/utm-segmentation),
[campaign attribution troubleshooting](https://posthog.com/docs/web-analytics/campaign-attribution-troubleshooting)
and [funnels](https://posthog.com/docs/product-analytics/funnels).
