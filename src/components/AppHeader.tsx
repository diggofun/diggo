import { useEffect, useRef, useState, type ComponentType } from "react";
import { useConnect, useDisconnect, useWallets } from "@solana/kit-plugin-wallet/react";
import bs58 from "bs58";
import { fetchSolUsd, getChallenge, verifyWallet, type PortfolioSummary } from "../api";
import { resetAnalyticsIdentity, track } from "../analytics";
import { clearRememberedReferral, readRememberedReferral } from "../referralLink";
import { oreAmount, shortAddress, solAmount, usdApprox } from "../format";
import type { GameState } from "../api";
import {
  IconClose,
  IconBalance,
  IconAdmin,
  IconCosmetics,
  IconCrew,
  IconDiscoveries,
  IconHome,
  IconLeaderboards,
  IconLogout,
  IconMenu,
  IconMine,
  IconOre,
  IconPlus,
  IconSearch,
  IconSettings,
  IconStreak,
  IconWallet,
  IconWatchlist,
  IconUserGroup,
  type IconProps,
} from "../icons";
import { solanaClient } from "../solana";
import { displayName, useUsername } from "../username";
import { OPEN_WALLET_EVENT, useDiggoWallet } from "../wallet";
import { disconnectWalletConnect, openWalletConnect } from "../walletConnect";
import { Bot } from "./Bot";
import { useProfileBot } from "../preferences";
import { NotificationsBell } from "./NotificationsBell";
import { UsernameEditor } from "./UsernameEditor";

export type PageId =
  | "home"
  | "mine"
  | "crew"
  | "discoveries"
  | "explore"
  | "diggo"
  | "leaderboards"
  | "mines"
  | "cosmetics"
  | "trade"
  | "create"
  | "profile"
  | "referrals"
  | "settings"
  | "admin"
  | "ui";

interface NavItem {
  page: PageId;
  href: string;
  label: string;
  icon?: ComponentType<IconProps>;
  /** The brand mark instead of an icon (the official coin's link). */
  image?: string;
}

/** The game: where a player spends a session. */
const PLAY_ITEMS: NavItem[] = [
  { page: "home", href: "/", label: "Home", icon: IconHome },
  { page: "mine", href: "/mine", label: "Mine", icon: IconMine },
  { page: "crew", href: "/crew", label: "Crew", icon: IconCrew },
  { page: "discoveries", href: "/discoveries", label: "Discoveries", icon: IconDiscoveries },
  { page: "explore", href: "/explore", label: "Explore coins", icon: IconSearch },
  { page: "leaderboards", href: "/leaderboards", label: "Leaderboards", icon: IconLeaderboards },
  { page: "diggo", href: "/diggo", label: "$DIGGO", image: "/assets/brand/diggo-logo-256.png" },
];

/** Everything else, a step down in the drawer. */
const MORE_ITEMS: NavItem[] = [
  { page: "referrals", href: "/referrals", label: "Referrals", icon: IconUserGroup },
  { page: "cosmetics", href: "/cosmetics", label: "Cosmetics", icon: IconCosmetics },
  { page: "settings", href: "/settings", label: "Settings", icon: IconSettings },
];

const MOBILE_ITEMS: PageId[] = ["home", "mine", "crew", "discoveries", "explore"];

/**
 * The tab bar gets one line for five labels inside 360px, so any label longer than a word or two
 * has a short form for it. The full text stays on `aria-label` and in the title, so the link still
 * announces "Explore coins" to a screen reader even though the bar reads "Explore".
 */
const TAB_BAR_SHORT_LABELS: Partial<Record<PageId, string>> = {
  explore: "Explore",
  discoveries: "Finds",
};

/**
 * The brand: the "diggo" wordmark spelled in bots, and the orange bot alone where the row is tight.
 * Both are cut-outs on transparent backgrounds (scripts/brand/make-bot-brand.mjs).
 */
export function BrandMark() {
  return (
    <a className="brand" href="/" aria-label="Diggo.fun home">
      <img className="brand-wordmark" src="/assets/brand/diggo-wordmark-640.png" alt="" width={640} height={190} />
      <img className="brand-mark" src="/assets/brand/diggo-logo-256.png" alt="" width={256} height={213} />
    </a>
  );
}

interface AppHeaderProps {
  page: PageId;
  session: string | null;
  signedIn: boolean;
  /** True only for a wallet the Worker lists in ADMIN_WALLETS; hides the Admin link otherwise. */
  isAdmin?: boolean;
  summary: PortfolioSummary | null;
  game: GameState | null;
  solBalance: number | null;
  onLaunch(): void;
  onAuthenticated(wallet: string): void;
}

export function AppHeader({ page, session, signedIn, isAdmin = false, summary, game, solBalance, onLaunch, onAuthenticated }: AppHeaderProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  /*
   * SOL/USD for the balance chip. Fetched here rather than lifted into App because it is purely a
   * header ornament: no screen, no balance and no settlement depends on it. The Worker already
   * caches the Jupiter quote for five minutes, so one call per mount is enough and re-polling on
   * every render would only add load. A failed or unavailable price leaves this null, and the chip
   * then shows the SOL amount alone instead of a fabricated dollar figure.
   */
  const [solUsd, setSolUsd] = useState<number | null>(null);
  useEffect(() => {
    let current = true;
    void fetchSolUsd().then((price) => {
      if (current) setSolUsd(price);
    });
    return () => { current = false; };
  }, []);
  const solBalanceUsd = solBalance === null || solUsd === null ? null : usdApprox(solBalance * solUsd);

  useEffect(() => {
    if (!sidebarOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSidebarOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sidebarOpen]);

  return (
    <>
      <header className="site-header">
        <div className="header-brand-group">
          <button
            type="button"
            className="sidebar-toggle"
            aria-label="Open navigation"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <IconMenu size={22} />
          </button>
          <BrandMark />
        </div>

        <div className="header-actions">
          {signedIn && (
            <div className="account-summary" aria-label="Wallet summary">
              <span title={(game ? game.streak : summary?.mining.streak ?? 0) + " day streak"}>
                <IconStreak size={16} />
                <b>{game ? game.streak : summary ? summary.mining.streak : 0}</b>
              </span>
              <span title={(game ? oreAmount(game.oreBalance) : summary ? oreAmount(summary.mining.oreWhole) : oreAmount(0)) + " ORE"}>
                <IconOre size={16} />
                <b>{game ? oreAmount(game.oreBalance) : summary ? oreAmount(summary.mining.oreWhole) : oreAmount(0)}</b>
              </span>
              <span title={solBalance === null ? "Loading SOL balance" : solAmount(solBalance) + " SOL" + (solBalanceUsd ? " (≈ " + solBalanceUsd + ")" : "")}>
                <IconBalance size={16} />
                <b>{solBalance === null ? solAmount(0) : solAmount(solBalance)}</b>
                <small>SOL</small>
              </span>
            </div>
          )}
          <button type="button" className="btn btn-dark header-launch" onClick={onLaunch}>
            <IconPlus size={18} /> <span>Launch</span>
          </button>
          {signedIn && <NotificationsBell signedIn />}
          <WalletControl session={session} onAuthenticated={onAuthenticated} />
        </div>
      </header>

      <aside className={"app-sidebar" + (sidebarOpen ? " is-open" : "")} aria-label="Main navigation">
        <div className="sidebar-head">
          <button type="button" className="sidebar-close" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>
            <IconClose size={24} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="Primary">
          {PLAY_ITEMS.map((item) => (
            <NavLink key={item.page} item={item} active={page === item.page} className="sidebar-link" onNavigate={() => setSidebarOpen(false)} />
          ))}
        </nav>

        <nav className="sidebar-nav sidebar-more" aria-label="More">
          {MORE_ITEMS.map((item) => (
            <NavLink key={item.page} item={item} active={page === item.page} className="sidebar-link" onNavigate={() => setSidebarOpen(false)} />
          ))}
          <a className="sidebar-link" href="/explore#watchlist" onClick={() => setSidebarOpen(false)}>
            <IconWatchlist size={22} /> Watchlist
          </a>
          <button type="button" className="sidebar-link" onClick={() => { setSidebarOpen(false); onLaunch(); }}>
            <IconPlus size={22} /> Create coin
          </button>
        </nav>

        <div className="sidebar-shortcuts">
          {isAdmin && (
            <NavLink item={{ page: "admin", href: "/admin", label: "Admin", icon: IconAdmin }} active={page === "admin"} className="sidebar-link" onNavigate={() => setSidebarOpen(false)} />
          )}
          <a
            className={"sidebar-link sidebar-profile" + (page === "profile" ? " active" : "")}
            href="/profile"
            aria-current={page === "profile" ? "page" : undefined}
            onClick={() => setSidebarOpen(false)}
          >
            {signedIn && session ? <ProfileBot wallet={session} size={32} /> : <IconWallet size={22} />}
            <span>{signedIn && session ? shortAddress(session) : "Connect wallet"}</span>
          </a>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <nav className="tab-bar" aria-label="Game shortcuts">
        {MOBILE_ITEMS.map((id) => {
          const item = PLAY_ITEMS.find((candidate) => candidate.page === id)!;
          const Icon = item.icon;
          const shortLabel = TAB_BAR_SHORT_LABELS[id];
          return (
            <a
              key={id}
              href={item.href}
              className={page === id ? "active" : ""}
              aria-current={page === id ? "page" : undefined}
              aria-label={shortLabel ? item.label : undefined}
              title={item.label}
            >
              {Icon ? <Icon size={22} /> : null}
              <span>{shortLabel ?? item.label}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}

function NavLink({
  item,
  active,
  className = "",
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  className?: string;
  onNavigate?(): void;
}) {
  const Icon = item.icon;
  return (
    <a
      className={(className + (active ? " active" : "")).trim()}
      href={item.href}
      aria-current={active ? "page" : undefined}
      onClick={onNavigate}
    >
      {item.image ? (
        <img className="nav-mark" src={item.image} alt="" width={256} height={213} />
      ) : (
        Icon ? <Icon size={22} /> : null
      )} {item.label}
   </a>
  );
}

/** The player's own bot: the look picked in settings, or the default for their wallet. */
function ProfileBot({ wallet, size, className }: { wallet: string; size: number; className?: string }) {
  const { look } = useProfileBot(wallet);
  return <Bot {...look} size={size} still className={className} />;
}

function WalletControl({ session, onAuthenticated }: { session: string | null; onAuthenticated(wallet: string): void }) {
  const wallets = useWallets(solanaClient);
  const connected = useDiggoWallet();
  const connect = useConnect(solanaClient);
  const standardDisconnect = useDisconnect(solanaClient);
  const [open, setOpen] = useState(false);
  const [walletConnectError, setWalletConnectError] = useState("");
  const [signingIn, setSigningIn] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const viewer = useUsername(connected && session === connected.address ? connected.address : null);
  /** The wallet the player picked in this menu, reported once the connection actually lands. */
  const chosenWallet = useRef<string | null>(null);
  const connectedAddress = connected?.address ?? null;

  useEffect(() => {
    if (!connectedAddress || !chosenWallet.current) return;
    track("wallet_connected", { wallet_name: chosenWallet.current });
    chosenWallet.current = null;
  }, [connectedAddress]);

  useEffect(() => {
    const onRequest = (event: Event) => {
      const detail = (event as CustomEvent<{ location?: string } | null>).detail;
      track("wallet_connect_clicked", { location: detail?.location ?? "unknown" });
      setOpen(true);
      rootRef.current?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener(OPEN_WALLET_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_WALLET_EVENT, onRequest);
  }, []);

  useEffect(() => {
    // Both menus in this control dismiss the same way: a click outside it, or Escape. The username
    // menu used to answer to neither, because the ref that says where "outside" begins was only on
    // the disconnected branch, so the one way out of it was to find the disclosure again.
    if (!open && !identityOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
        setIdentityOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setIdentityOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, identityOpen]);

  async function signIn(): Promise<void> {
    if (!connected) return;
    setSigningIn(true);
    try {
      const challenge = await getChallenge(connected.address);
      const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
      const referralCode = readRememberedReferral();
      const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature), referralCode);
      clearRememberedReferral();
      onAuthenticated(verified.wallet);
      track("wallet_signed_in");
      if (referralCode && verified.referralCaptured) track("referral_signup", { ref_code: referralCode });
    } catch {
      // The button stays available; a refused or failed signature simply leaves the player signed out.
    } finally {
      setSigningIn(false);
    }
  }

  async function disconnectWallet() {
    resetAnalyticsIdentity();
    if (connected?.kind === "walletconnect") await disconnectWalletConnect();
    else standardDisconnect.dispatch();
  }

  if (connected) {
    const isAuthenticated = session === connected.address;
    return (
      <div className="wallet-control signed-wallet" ref={rootRef}>
        {isAuthenticated ? (
          // Signed in, the control is one identity badge: the player's bot. It opens the account
          // menu (username, settings, disconnect), so the header carries one button, not three,
          // and still fits a 360px phone next to the balance and the bell.
          <button
            className="wallet-button is-signed"
            aria-expanded={identityOpen}
            aria-haspopup="true"
            onClick={() => setIdentityOpen((value) => !value)}
            title={"Your account: " + displayName(connected.address, viewer.username)}
          >
            <ProfileBot wallet={connected.address} size={26} className="wallet-button-icon" />
            <span className="wallet-button-label">{displayName(connected.address, viewer.username)}</span>
          </button>
        ) : (
          <>
            {/* A connected-but-unsigned wallet keeps the dot: it is the "not signed in yet" signal. */}
            <button className="wallet-button" disabled={signingIn} onClick={() => void signIn()} title="Sign in with wallet">
              <i className="wallet-dot" aria-hidden="true" />
              <span className="wallet-button-label">{signingIn ? "Signing…" : "Sign in"}</span>
            </button>
            <button className="wallet-disconnect" onClick={() => void disconnectWallet()} aria-label="Disconnect wallet" title="Disconnect wallet">
              <IconLogout size={18} />
            </button>
          </>
        )}
        {isAuthenticated && identityOpen && (
          <div className="wallet-menu account-menu" role="group" aria-label="Your account">
            <strong>Public username</strong>
            <UsernameEditor key={connected.address} wallet={connected.address} onChanged={() => setIdentityOpen(false)} />
            <a className="account-menu-link" href="/settings" onClick={() => setIdentityOpen(false)}>
              <IconSettings size={18} /> Settings and your bot
            </a>
            <button type="button" onClick={() => void disconnectWallet()}>
              <IconLogout size={18} /> Disconnect wallet
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-control" ref={rootRef}>
      <button
        className="wallet-button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => {
          if (!open) track("wallet_connect_clicked", { location: "header" });
          setOpen((value) => !value);
        }}
      >
        <IconWallet className="wallet-button-icon" size={20} /> <span className="wallet-button-label">Connect wallet</span>
      </button>
      {open && (
        <div className="wallet-menu" role="group" aria-label="Choose a wallet">
          <strong>Choose a Wallet Standard wallet</strong>
          {wallets.length > 0 ? wallets.map((wallet) => (
            <button
              key={wallet.name}
              disabled={connect.isRunning}
              onClick={() => {
                chosenWallet.current = wallet.name;
                connect.dispatch(wallet);
                setOpen(false);
              }}
            >
              {wallet.icon && <img src={wallet.icon} alt="" />} {wallet.name}
            </button>
          )) : <p>No compatible browser wallet found on this device.</p>}
          <button
            type="button"
            className="wallet-walletconnect-button"
            onClick={() => {
              chosenWallet.current = "WalletConnect";
              void openWalletConnect().then((opened) => {
                setWalletConnectError(opened ? "" : "Could not load WalletConnect. Check your connection and try again.");
                if (opened) setOpen(false);
              });
            }}
          >
            <IconWallet size={20} /> Connect WalletConnect
          </button>
          <small>WalletConnect covers phones and wallets not detected above.</small>
          <small className="wallet-menu-legal">
            By connecting you confirm you are not in a restricted jurisdiction (see{" "}
            <a href="/terms">Terms</a>).
          </small>
          {walletConnectError && <p className="wallet-menu-error" role="alert">{walletConnectError}</p>}
        </div>
      )}
    </div>
  );
}
