/**
 * The legal documents, as plain data so they can be rendered, linked and reviewed without JSX.
 *
 * Every fact this file could not establish from the codebase is left as a bracketed placeholder
 * rather than guessed, so an operator can fill it in: nothing here is legal advice.
 *
 * The descriptions of what the Service stores are written against the implementation, not from
 * memory: the session cookie and its lifetime (worker/http.ts), the random device id
 * (src/device.ts), the salted fingerprints (worker/signals.ts), the notification list cap
 * (worker/notifications.ts), the push subscription fields and the 180 day sweep of disabled
 * subscriptions (worker/push.ts, migrations/0015_push_subscriptions.sql), the analytics settings
 * (src/analytics.ts) and the fair-launch rules in shared/config.ts.
 */
import type { LegalDocId } from "./routes";

export interface LegalSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
}

export interface LegalDocument {
  readonly id: LegalDocId;
  readonly title: string;
  readonly summary: string;
  readonly updated: string;
  readonly sections: readonly LegalSection[];
}

export const OPERATOR_PLACEHOLDER =
  "[OPERATING COMPANY LEGAL NAME], [REGISTERED ADDRESS], [COUNTRY], company number [NUMBER]";
export const LEGAL_CONTACT = "[legal@example.com - replace with a monitored address]";
export const PRIVACY_CONTACT = "[privacy@example.com - replace with a monitored address]";
export const GOVERNING_LAW_PLACEHOLDER = "[GOVERNING LAW AND COURTS - to be confirmed]";

export const UPDATED = "22 September 2026";

const TERMS: LegalDocument = {
  id: "terms",
  title: "Terms of Service",
  summary: "The rules for using Diggo.fun: your wallet, your crown, and what ORE is and is not.",
  updated: UPDATED,
  sections: [
    {
      heading: "1. Who we are",
      paragraphs: [
        "Diggo.fun (the 'Service') is operated by " +
          OPERATOR_PLACEHOLDER +
          " ('we', 'us', 'our'). You can reach us about these Terms at " +
          LEGAL_CONTACT +
          ".",
        "By connecting a wallet, signing in or playing, you accept these Terms. If you do not accept them, do not use the Service.",
      ],
    },
    {
      heading: "2. What the Service is",
      paragraphs: [
        "Diggo.fun is a browser game built on the Solana blockchain. You activate a mine, grow a crew, collect mining reports, roll for discoveries and claim rewards that are paid from the reserve a mine's creator committed at launch.",
        "The Service is not a bank, exchange, broker, investment fund, custodian or financial adviser. We do not hold your assets, we do not take deposits, and we do not offer securities. Tokens created through the Service are created by their own creators, not by us.",
      ],
    },
    {
      heading: "3. Eligibility",
      paragraphs: [
        "You must be at least 18 years old and legally able to enter into these Terms. You must not be in a jurisdiction where using the Service would be unlawful, and you must not be subject to sanctions or acting for someone who is.",
        "The Service is a game with fictional framing, not a promise of income. If you are looking for a guaranteed return, the Service is not for you.",
      ],
    },
    {
      heading: "4. Your wallet, your keys, your responsibility",
      paragraphs: [
        "The Service has no passwords and no accounts in the ordinary sense: your wallet address is your identifier, and you prove control of it by signing a message. We never ask for your seed phrase or private key, and anyone who does is not us.",
        "You are responsible for everything signed from your wallet and for keeping your keys safe. If you lose access to your wallet, we cannot recover it, your ORE or your rewards - nobody can.",
      ],
      bullets: [
        "Signing in costs nothing and transfers nothing. A signature proves control; it never grants us the ability to move your funds.",
        "Never sign a transaction you have not read. We never ask you to sign a transfer of your own tokens except in the flows the interface shows you.",
      ],
    },
    {
      heading: "5. Mining Power and ORE are earned, never bought",
      paragraphs: [
        "Mining Power and ORE are earned through play: daily activation, streaks, crew upgrades, achievements, quests, seasonal progress and discoveries. There is no way to buy them. No payment, deposit, purchase, trade, subscription or donation can purchase Mining Power, ORE, rarity, or a better chance of any outcome.",
        "ORE is non-transferable. It stays attached to the wallet that earned it, cannot be sent to another wallet, cannot be traded on any market, and cannot be withdrawn, redeemed or exchanged for fiat money or for any cryptoasset. It confers no ownership, equity, dividend, revenue share or profit participation in anything.",
        "Mining Power and ORE have no monetary value. Treat them as a score in a game, because that is what they are.",
      ],
    },
    {
      heading: "6. Rewards, reserves and claims",
      paragraphs: [
        "Every mine has a reward reserve that its creator committed at launch. That reserve is finite and its size is public. Rewards are paid only out of it, and the reserve leaves it only through a valid mining report or discovery claim that passes the checks described below. There is no other path.",
        "Reward rates step down as the reserve is depleted, according to the published schedule. A larger reserve does not mean a promised return, and a reward rate is not a yield, an interest rate or a forecast. In most mines the reserve will be mined out, and the mine will then be finished.",
        "A claim is idempotent and replay-safe: each eligible earnings event can be claimed at most once. A claim that has already been paid, a duplicated claim, a claim for a period that has not matured, or a claim whose accounting does not reconcile with the on-chain mine pays nothing. We may pause claims for a mine whose accounting does not reconcile until it does.",
      ],
    },
    {
      heading: "7. Fairness and randomness",
      paragraphs: [
        "Outcomes that involve chance or payout size - discovery rolls, rarities, reward amounts - are decided on the server and settled on-chain. The browser never decides an outcome and never sees the seed in advance.",
        "Each rolling epoch is committed in advance as a hash and revealed once the epoch has ended, so any player can recompute the rolls after the fact (see docs/ARCHITECTURE.md for the commitment and reveal flow). If a commitment is missing, the affected rolls do not happen.",
      ],
    },
    {
      heading: "8. Anti-abuse, restrictions and appeals",
      paragraphs: [
        "To protect the reserves and everyone playing honestly, the Service scores activity for abuse: many wallets on one device or network, automation, scripted play, coordinated claiming and similar patterns. Signals are stored as salted hashes, never as raw addresses of other people.",
        "A flagged account can be placed under review, held, or blocked from earning. Where that happens the interface shows a neutral status message, and you can file an appeal in the app for a human to look at. Appeals are reviewed by a person; a decision can lift a restriction but never moves value by itself.",
        "We do not publish the details of detection methods, because doing so would defeat them. We do not use them to take anything you already hold.",
      ],
    },
    {
      heading: "9. No advice, no expectation of profit",
      paragraphs: [
        "Nothing in the Service or in any of our communications is financial, investment, legal or tax advice. We do not recommend any token, including tokens created through Diggo.fun. Tokens created here are memecoins: they can go to zero. Read the Risk Disclosure before you trade anything.",
        "You are solely responsible for your own decisions, for complying with the law where you live, and for any tax arising from anything you do.",
      ],
    },
    {
      heading: "10. Prohibited conduct",
      paragraphs: ["Do not do any of the following, and do not help anyone else do them:"],
      bullets: [
        "Operate multiple accounts to farm rewards, or coordinate wallets to defeat the anti-abuse rules.",
        "Automate play, use bots or scripts, or otherwise interact with the Service through anything other than the interface we provide.",
        "Exploit bugs, attempt to manipulate reward accounting or the reserve, or submit claims you are not entitled to.",
        "Interfere with, overload, scrape, reverse engineer or attempt to gain unauthorised access to the Service or other players' accounts.",
        "Use the Service to launder money, evade sanctions, or infringe anyone's rights.",
        "Buy, sell or transfer accounts, or offer ORE or Mining Power for sale - they are not transferable and such a 'sale' transfers nothing.",
      ],
    },
    {
      heading: "11. Availability, changes and termination",
      paragraphs: [
        "The Service is under active development and is offered on an as-available basis. Features can change, be suspended or be withdrawn; a cluster can be reset; nothing is guaranteed to be available at any particular time.",
        "We may change these Terms. A material change will be announced in the interface before it takes effect, and the revised date at the top of this page will change. Continuing to use the Service after that means you accept the change.",
        "You may stop using the Service at any time. We may restrict or end your access if you breach these Terms or if we are required to by law.",
      ],
    },
    {
      heading: "12. Disclaimers and liability",
      paragraphs: [
        "The Service is provided 'as is' and 'as available', without warranties of any kind, express or implied, including fitness for a particular purpose, uninterrupted availability, or that any token will retain any value. We do not warrant that a mine's reserve, a reward rate or ORE will be worth anything.",
        "To the fullest extent permitted by law, we are not liable for indirect, incidental, special or consequential losses, for lost profits, for lost tokens or for losses caused by third parties, wallets, RPC providers, blockchains, exchanges or your own key management. Our total aggregate liability is limited to [LIABILITY CAP - to be confirmed]. Nothing in these Terms excludes liability that cannot lawfully be excluded, and nothing affects mandatory consumer rights you have where you live.",
      ],
    },
    {
      heading: "13. Governing law and disputes",
      paragraphs: [
        "These Terms are governed by " +
          GOVERNING_LAW_PLACEHOLDER +
          ", and the courts there have jurisdiction, without affecting any right you have to bring proceedings where you live.",
        "Before starting proceedings, write to " + LEGAL_CONTACT + " and give us a chance to resolve it.",
      ],
    },
  ],
};

const PRIVACY: LegalDocument = {
  id: "privacy",
  title: "Privacy Policy",
  summary:
    "What Diggo.fun processes, why, for how long, and how to exercise your rights under the GDPR.",
  updated: UPDATED,
  sections: [
    {
      heading: "1. Who is responsible for your data",
      paragraphs: [
        "The controller is " +
          OPERATOR_PLACEHOLDER +
          ". Privacy questions and requests go to " +
          PRIVACY_CONTACT +
          ". A data protection officer is [NOT APPOINTED / NAME AND CONTACT].",
        "This policy covers diggo.fun and everything served from it. It does not cover the Solana network itself, your wallet provider, exchanges or any third-party site you reach from ours.",
      ],
    },
    {
      heading: "2. What we process",
      paragraphs: [
        "We deliberately collect very little, and the Service works without analytics cookies. In detail:",
      ],
      bullets: [
        "Your wallet address (a public identifier on the Solana blockchain). It is your account identifier: gameplay, ORE, rewards and claims are keyed to it.",
        "A signature you produce when signing in. It is verified and then discarded; we do not store your signature.",
        "A session identifier, stored in a cookie named diggo_session. It is HttpOnly, so page scripts cannot read it, and it expires after 7 days.",
        "A random 128-bit device id, generated in your browser, kept in localStorage under diggo.device.v1, and sent as a request header. It is not a fingerprint: there is no canvas, WebGL or audio probing, nothing derived from your machine, and clearing site data replaces it. It exists so that many wallets on one browser can be recognised as one operator for anti-abuse purposes.",
        "Salted hashes of your IP address, network and the device id, stored with your account's activity signals. The raw IP address is used transiently to rate-limit requests; the stored value is a hash we cannot reverse. The salt is a server secret.",
        "Gameplay data: mine activations, streaks, crew levels, ORE and Mining Power, mining reports, discoveries and their rarities, reward and discovery claims, achievements, cosmetics, seasonal points, referral-free 'crew' state, and the risk state and restriction history of your account.",
        "Notification data: the notifications generated for your wallet. The list keeps the 50 most recent per wallet.",
        "Push notification data, only if you switch alerts on: the push service endpoint your browser uses, your browser's public key and auth secret for that endpoint, and a truncated User-Agent string. They let us encrypt an alert so only that device can read it. They are removed when you switch alerts off.",
        "A Telegram chat identifier, only if you link a chat to your wallet with a one-time code. It is removed when you send /stop to the bot.",
        "Operational data: structured logs, alert and metric counters, and error reports. We aim to keep these free of personal data, and inside the Service we never log wallet keys.",
        "Correspondence you send us, including appeals, which record the message, the state you were in when you filed it, and the reviewer's decision.",
      ],
    },
    {
      heading: "3. Why we process it, and on what legal basis",
      paragraphs: ["Each purpose below is tied to one legal basis under Article 6 GDPR."],
      bullets: [
        "Providing the game and settling rewards - performance of a contract: your wallet address, session, gameplay data, claims and notifications.",
        "Protecting the Service and its players from abuse, multi-accounting, bots and reserve manipulation - our legitimate interests, and those of everyone playing honestly: the device id, salted IP/network/device hashes, activity signals and risk state.",
        "Keeping the Service secure, available and debuggable - our legitimate interests: logs, metrics and error reports.",
        "Understanding how the game is used - your consent only: analytics (see section 4).",
        "Sending push alerts and Telegram messages - your consent, given by switching the channel on: push subscription data, Telegram chat id.",
        "Meeting legal obligations - legal obligation: records we must keep where applicable, such as responding to lawful requests or tax duties.",
      ],
    },
    {
      heading: "4. Analytics",
      paragraphs: [
        "Analytics is off by default and only starts after you choose 'Allow analytics' in the consent banner. Until then, nothing is loaded from our analytics provider and nothing is sent to it.",
        "When it is on, we use PostHog: page views and the product events we explicitly record (for example launching a mine or opening a screen), with autocapture, session recording and surveys all switched off. You can withdraw consent at any time from the Cookie & Storage Notice or the banner, and analytics stops on the next page load.",
      ],
    },
    {
      heading: "5. Automated decisions and anti-abuse",
      paragraphs: [
        "Some restrictions on earning are produced by an automated risk score that combines the signals listed above. Where the score places an account under review or on hold, the interface shows a status message but never the detection details, because publishing them would let abusers route around them.",
        "You have the right to object to this processing and to obtain human intervention. Every restriction can be appealed in the app, an appeal is decided by a person, and a decision can only lift a restriction - it never moves value. Automated scoring never decides what you have already earned, and it never moves funds.",
      ],
    },
    {
      heading: "6. On-chain data",
      paragraphs: [
        "Solana is a public, permanent, append-only ledger. Transactions you sign, the mine accounts you create or interact with, and the amounts involved are public and cannot be deleted, altered or hidden by us or by anyone else. That includes your wallet address and its activity.",
        "We do not write anything else about you on-chain. Erasure requests cannot extend to the blockchain itself, because nobody can rewrite it.",
      ],
    },
    {
      heading: "7. Who we share it with",
      paragraphs: [
        "We do not sell personal data and we do not share it for advertising. We use service providers who process it on our behalf under contract:",
      ],
      bullets: [
        "A cloud infrastructure provider for hosting, the database, bot protection (Turnstile) and rate limiting.",
        "A Solana RPC provider, to read and verify on-chain state.",
        "A product analytics provider, only after you consent.",
        "An error monitoring provider, to receive crash reports that we work to keep free of personal data.",
        "The Telegram Bot API, only if you link a chat.",
        "Lawyers, accountants and auditors where necessary, and public authorities where we are legally required to respond.",
      ],
    },
    {
      heading: "8. International transfers",
      paragraphs: [
        "Our providers are mainly in the United States, so using the Service involves a transfer of personal data outside the European Economic Area. Those transfers rely on an adequacy decision or on the European Commission's Standard Contractual Clauses with the provider. You can ask us for the relevant safeguards at " +
          PRIVACY_CONTACT +
          ".",
      ],
    },
    {
      heading: "9. How long we keep it",
      paragraphs: [
        "We keep data only as long as the purpose needs it, and these are the current periods. [CONFIRM EACH PERIOD WITH OPERATIONS BEFORE LAUNCH]",
      ],
      bullets: [
        "Session: 7 days from sign-in, then it expires.",
        "Device id: until you clear site data or reset it in the Service.",
        "Anti-abuse signals and risk state: [RETENTION PERIOD - to be confirmed with operations; the sweeps that prune them are configured by the operator].",
        "Gameplay data, claims and appeals: for as long as your wallet has an account, then [POST-CLOSURE PERIOD - to be confirmed].",
        "Notifications: the 50 most recent per wallet.",
        "Push subscription: until you switch alerts off, plus up to 180 days after a subscription is disabled for repeated delivery failures.",
        "Telegram link: until you send /stop, or until the bot is blocked.",
        "Logs, metrics and alerts: [LOG RETENTION - to be confirmed].",
      ],
    },
    {
      heading: "10. Your rights",
      paragraphs: [
        "Under the GDPR you can ask for access to your data, rectification, erasure, restriction of processing, portability, and you can object to processing based on our legitimate interests, including the anti-abuse scoring. Where we rely on consent you can withdraw it at any time, without affecting what happened before.",
        "Write to " +
          PRIVACY_CONTACT +
          ". We answer within one month. Note that anything recorded on the Solana blockchain cannot be erased, and that we may have to keep a minimum of data to comply with the law or to defend legal claims.",
        "If you think we have handled your data badly you can complain to your supervisory authority - in Poland, the Prezes Urzędu Ochrony Danych Osobowych (UODO).",
      ],
    },
    {
      heading: "11. Security, children and changes",
      paragraphs: [
        "We store as little as possible, hash what we can, keep browser sessions in HttpOnly cookies, validate everything at the server boundary and use prepared statements for every database access. No system is perfect, and no internet service can promise absolute security.",
        "The Service is for adults. We do not knowingly process data of anyone under 18; if you believe a child has used it, contact us and we will remove the data we can.",
        "We will update this policy when what we process changes, and the date at the top will change with it.",
      ],
    },
  ],
};

const RISK: LegalDocument = {
  id: "risk",
  title: "Risk Disclosure",
  summary: "What can go wrong: volatile memecoins, a finite reserve, and a game token with no monetary value.",
  updated: UPDATED,
  sections: [
    {
      heading: "1. This is not investment advice",
      paragraphs: [
        "Nothing on Diggo.fun is financial, investment, legal or tax advice, and nothing here should be read as a recommendation to buy, sell or hold anything. You are making your own decisions with your own money.",
        "Do not use the Service with money you cannot afford to lose completely.",
      ],
    },
    {
      heading: "2. Memecoins are extremely volatile",
      paragraphs: [
        "Tokens created through Diggo.fun are memecoins. They have no underlying business, cash flow or asset backing, their price is driven almost entirely by sentiment and liquidity, and they can lose most or all of their value within minutes. Many go to zero, and most add no lasting value to anyone who buys late.",
        "Liquidity can disappear. Being unable to sell at any price is a normal outcome in this market, not an exception. Trading, creating or holding these tokens is entirely at your own risk.",
      ],
    },
    {
      heading: "3. ORE and Mining Power have no monetary value",
      paragraphs: [
        "ORE and Mining Power are game items. They cannot be bought with money, they cannot be transferred, and they cannot be withdrawn, redeemed or exchanged for fiat money or for any cryptoasset. There is no market for them and we will not create one.",
        "They confer no ownership, equity, dividend, revenue share or claim on anything we or anyone else holds. Their only use is inside the game, and if the game changes or ends they may cease to be useful entirely.",
      ],
    },
    {
      heading: "4. Rewards come from a finite reserve and taper",
      paragraphs: [
        "Rewards are paid from the reserve a mine's creator committed at launch. That reserve is limited and public, and reward rates step down as it is depleted. Once it is exhausted, that mine pays nothing more.",
        "There is no guaranteed rate, no guaranteed amount, no guaranteed timing and no guaranteed payout at all. Nothing in the interface is an interest rate, a yield or a forecast, and any number you see is a description of the current rule rather than a promise about your future balance.",
      ],
    },
    {
      heading: "5. Fairness does not mean profit",
      paragraphs: [
        "Discovery rolls are committed in advance and revealed afterwards so that anyone can recompute them, and reward outcomes are decided server-side rather than in your browser. That is a guarantee about how outcomes are produced, not about whether they are worth anything.",
        "A rare discovery is a rare discovery in a game. It is not an asset with a floor price.",
      ],
    },
    {
      heading: "6. Smart contract and platform risk",
      paragraphs: [
        "The protocol is a Solana program. Smart contracts can contain bugs, can be exploited, and can behave differently from their documentation. Audits, where they exist, reduce but never remove that risk. Upgrades, network congestion, RPC outages or a cluster reset can interrupt or permanently change what the Service can do.",
        "The Service may run on a development network, in which case nothing on it has any real-world value and all state can be wiped without notice.",
      ],
    },
    {
      heading: "7. Custody risk is yours",
      paragraphs: [
        "We never hold your keys and never take custody of your tokens. You are the only person who can sign for your wallet, and you are solely responsible for its security. Lost keys, a compromised device, a malicious transaction you approved, or a wallet provider that fails are all losses we cannot reverse or reimburse.",
      ],
    },
    {
      heading: "8. Availability, restrictions and halts",
      paragraphs: [
        "Anti-abuse controls can slow down or restrict an account, including an account that did nothing wrong. Claims can be paused for a mine whose accounting does not reconcile. Maintenance, incidents and changes to reward rules can interrupt play.",
        "You can appeal any restriction and a person will review it, but an appeal takes time, and there is no compensation for time lost while an account is under review.",
      ],
    },
    {
      heading: "9. Regulatory, tax and third-party risk",
      paragraphs: [
        "The rules for cryptoassets differ by country and are changing. Using the Service may be restricted or unlawful where you live, and it is your responsibility to know which applies to you. Taxes on anything you do are yours to declare and pay.",
      ],
      bullets: [
        "Nothing here is a promise of profit, of liquidity, of a listing, of a buyer, or of a price.",
        "Nothing here obliges us to keep any feature, mine, reward rule or token trading available.",
        "Nothing here obliges us to compensate you for a bug, an outage, a restriction, a token that went to zero, or your own mistake.",
        "Nothing here transfers any responsibility for your wallet, your keys or your decisions to us.",
      ],
    },
  ],
};

const COOKIES: LegalDocument = {
  id: "cookies",
  title: "Cookie & Storage Notice",
  summary: "Every cookie, local storage item and service worker the site uses, and why.",
  updated: UPDATED,
  sections: [
    {
      heading: "1. What this notice covers",
      paragraphs: [
        "Browsers give a site three kinds of storage, and this notice lists all of them that Diggo.fun uses: cookies, the localStorage key/value store, and the push service worker. There are no advertising cookies, no third-party tracking pixels, no cross-site identifiers and no data sold to anyone.",
        "Storage is either strictly necessary or optional. Optional storage only happens after you allow it, and the two choices in the banner are equally easy to make.",
      ],
    },
    {
      heading: "2. Strictly necessary: always on",
      paragraphs: [
        "These are needed for the site to work or to keep the game honest, and they are covered by your request for the service and by our legitimate interest in protecting it. They are disclosed here rather than hidden behind a switch.",
      ],
      bullets: [
        "diggo_session (cookie, HttpOnly, 7 days) - the signed-in session. Without it you cannot activate a mine, collect a report or claim a reward.",
        "diggo.device.v1 (localStorage) - the random 128-bit device id described in the Privacy Policy. It groups wallets on one browser for anti-abuse only. It is not a fingerprint, and clearing site data replaces it.",
        "diggo.consent.v1 (localStorage) - the record of the choice you made in the banner, including its date, so we do not ask you on every page.",
        "Wallet connection data (localStorage) - only if you connect a wallet, the connection metadata your wallet provider (WalletConnect or the injected provider) keeps so you do not have to pair again. Removing it is the 'disconnect' flow in your wallet.",
      ],
    },
    {
      heading: "3. Optional: only with your permission",
      paragraphs: ["Each of these is off until you turn it on, and each can be turned off again."],
      bullets: [
        "Analytics (PostHog) - starts only after 'Allow analytics'. It records page views and the product events the site explicitly sends, with autocapture, session recording and surveys disabled. Withdraw it at any time; analytics stops on the next page load.",
        "Push alerts (service worker and subscription) - if you switch alerts on, your browser registers the push-only service worker at /sw.js and creates a subscription with your browser vendor's push service. Switching alerts off removes the registration and the server-side record.",
        "Telegram alerts - if you link a chat with a one-time code. Send /stop to the bot, or turn it off in the app, to unlink.",
      ],
    },
    {
      heading: "4. How to control and withdraw",
      paragraphs: [
        "Use the banner to make or change your choice, or the 'Change your analytics choice' button on this page and the Privacy Policy. Clearing site data in your browser removes the cookie and every localStorage item; the device id and this choice will then be recreated as needed.",
        "Your browser settings can block storage and notifications entirely. Blocking the session cookie means you cannot sign in; blocking notifications only means you will not receive alerts.",
      ],
    },
    {
      heading: "5. How long these items last",
      paragraphs: [
        "The session cookie expires after 7 days. localStorage items last until you clear them or reset them in the app. A push subscription lasts until you switch alerts off, and a subscription that keeps failing to deliver is disabled and then deleted after 180 days. The service worker is removed when you unregister it or clear site data.",
      ],
    },
    {
      heading: "6. Questions",
      paragraphs: [
        "Anything unclear about storage, or a request about your data, goes to " +
          PRIVACY_CONTACT +
          ". See also the Privacy Policy for your rights under the GDPR and the Risk Disclosure for what the tokens here are not.",
      ],
    },
  ],
};

export const LEGAL_DOCUMENTS: Readonly<Record<LegalDocId, LegalDocument>> = Object.freeze({
  terms: TERMS,
  privacy: PRIVACY,
  risk: RISK,
  cookies: COOKIES,
});
