import { useEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { useConnect, useDisconnect, useWallets } from "@solana/kit-plugin-wallet/react";
import bs58 from "bs58";
import { getChallenge, verifyWallet, type PortfolioSummary } from "../api";
import { track } from "../analytics";
import { oreAmount, shortAddress, solAmount } from "../format";
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
  IconMines,
  IconOre,
  IconProfile,
  IconRocket,
  IconSearch,
  IconSettings,
  IconStreak,
  IconSwap,
  IconWallet,
  IconWatchlist,
  IconUserGroup,
  type IconProps,
} from "../icons";
import { solanaClient } from "../solana";
import { displayName, useUsername } from "../username";
import { OPEN_WALLET_EVENT, useDiggoWallet } from "../wallet";
import { disconnectWalletConnect, openWalletConnect } from "../walletConnect";
import { NotificationsBell } from "./NotificationsBell";
import { UsernameEditor } from "./UsernameEditor";

export type PageId =
  | "home"
  | "mine"
  | "crew"
  | "discoveries"
  | "explore"
  | "leaderboards"
  | "mines"
  | "cosmetics"
  | "trade"
  | "create"
  | "profile"
  | "referrals"
  | "admin"
  | "ui";

interface NavItem {
  page: PageId;
  href: string;
  label: string;
  icon?: ComponentType<IconProps>;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Play",
    items: [
      { page: "mine", href: "/mine", label: "Mine", icon: IconMine },
      { page: "crew", href: "/crew", label: "Crew", icon: IconCrew },
      { page: "discoveries", href: "/discoveries", label: "Discoveries", icon: IconDiscoveries },
    ],
  },
  {
    label: "Explore",
    items: [
      { page: "explore", href: "/explore", label: "Explore coins", icon: IconSearch },
      { page: "mines", href: "/mines", label: "Mines", icon: IconMines },
      { page: "trade", href: "/trade", label: "Trade", icon: IconSwap },
      { page: "leaderboards", href: "/leaderboards", label: "Leaderboards", icon: IconLeaderboards },
    ],
  },
  {
    label: "Diggo",
    items: [
      { page: "referrals", href: "/referrals", label: "Referrals", icon: IconUserGroup },
      { page: "cosmetics", href: "/cosmetics", label: "Cosmetics", icon: IconCosmetics },
      { page: "create", href: "/create", label: "Create coin", icon: IconRocket },
    ],
  },
];

const ALL_ITEMS = NAV_GROUPS.flatMap((group) => group.items);
const MOBILE_ITEMS: PageId[] = ["home", "mine", "crew", "explore", "trade"];

export function BrandMark() {
  return (
    <a className="brand" href="/" aria-label="Diggo.fun home">
      <img className="brand-art brand-art-icon" src="/assets/brand/icon-512.png" alt="" width={512} height={512} />
      <strong>Diggo</strong>
    </a>
  );
}

interface AppHeaderProps {
  page: PageId;
  session: string | null;
  signedIn: boolean;
  summary: PortfolioSummary | null;
  game: GameState | null;
  solBalance: number | null;
  onLaunch(): void;
  onAuthenticated(wallet: string): void;
}

export function AppHeader({ page, session, signedIn, summary, game, solBalance, onLaunch, onAuthenticated }: AppHeaderProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

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
          <div className="account-summary" aria-label="Wallet summary">
            <span title={game ? `${game.streak} day streak` : summary ? `${summary.mining.streak} day streak` : signedIn ? "Loading streak" : "Sign in to view streak"}>
              <IconStreak size={23} />
              <b>{game ? game.streak : summary ? summary.mining.streak : signedIn ? 0 : "—"}</b>
              <small>Streak</small>
            </span>
            <span title={game ? `${oreAmount(game.oreBalance)} ORE` : summary ? `${oreAmount(summary.mining.oreWhole)} ORE` : signedIn ? "Loading ORE" : "Sign in to view ORE"}>
              <IconOre size={23} />
              <b>{game ? oreAmount(game.oreBalance) : summary ? oreAmount(summary.mining.oreWhole) : signedIn ? oreAmount(0) : "—"}</b>
              <small>ORE</small>
            </span>
            <span title={solBalance === null ? (signedIn ? "Loading SOL balance" : "Sign in to view SOL balance") : `${solAmount(solBalance)} SOL`}>
              <IconBalance size={23} />
              <b>{solBalance === null ? (signedIn ? solAmount(0) : "—") : solAmount(solBalance)}</b>
              <small>SOL</small>
            </span>
          </div>
          <button type="button" className="launch-button" onClick={onLaunch}>
            <IconRocket size={23} /> <span>Create coin</span>
          </button>
          <span
            className="header-alerts-control"
            style={{ "--header-alerts-icon": "url(/assets/icons/alerts.png)" } as CSSProperties}
          >
            <NotificationsBell signedIn={signedIn} />
          </span>
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
          <NavLink item={{ page: "home", href: "/", label: "Home", icon: IconHome }} active={page === "home"} className="sidebar-link sidebar-home" onNavigate={() => setSidebarOpen(false)} />
          {NAV_GROUPS.map((group) => (
            <section className="sidebar-section" key={group.label} aria-labelledby={"sidebar-" + group.label.toLowerCase()}>
              <h2 id={"sidebar-" + group.label.toLowerCase()}>{group.label}</h2>
              {group.items.map((item) => item.page === "create" ? (
                <button key={item.page} type="button" className="sidebar-link" onClick={() => { setSidebarOpen(false); onLaunch(); }}>
                  {item.icon ? <item.icon size={26} /> : null}{item.label}
                </button>
              ) : (
                <NavLink key={item.page} item={item} active={page === item.page} className="sidebar-link" onNavigate={() => setSidebarOpen(false)} />
              ))}
            </section>
          ))}
        </nav>

        <div className="sidebar-shortcuts">
          <a className="sidebar-link" href="/#watchlist" onClick={() => setSidebarOpen(false)}>
            <IconWatchlist size={26} /> Watchlist
          </a>
          {signedIn && (
            <NavLink item={{ page: "admin", href: "/admin", label: "Admin", icon: IconAdmin }} active={page === "admin"} className="sidebar-link" onNavigate={() => setSidebarOpen(false)} />
          )}
          <a
            className={"sidebar-link sidebar-profile" + (page === "profile" ? " active" : "")}
            href="/profile"
            aria-current={page === "profile" ? "page" : undefined}
            onClick={() => setSidebarOpen(false)}
          >
            <IconProfile size={26} />
            <span>
              <small>Your profile</small>
              <b>{signedIn && session ? shortAddress(session) : "Connect wallet"}</b>
            </span>
          </a>
        </div>
      </aside>
      {sidebarOpen && <button className="sidebar-backdrop" type="button" aria-label="Close navigation" onClick={() => setSidebarOpen(false)} />}

      <nav className="tab-bar" aria-label="Game shortcuts">
        {MOBILE_ITEMS.map((id) => {
          const item = id === "home"
            ? { page: "home" as const, href: "/", label: "Home", icon: IconHome }
            : ALL_ITEMS.find((candidate) => candidate.page === id)!;
          const Icon = item.icon;
          return (
            <a key={id} href={item.href} className={page === id ? "active" : ""} aria-current={page === id ? "page" : undefined}>
              {Icon ? <Icon size={22} /> : null}
              <span>{item.label}</span>
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
      {Icon ? <Icon size={className.includes("sidebar") ? 26 : 18} /> : null} {item.label}
    </a>
  );
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

  useEffect(() => {
    const onRequest = () => {
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
      const referralCode = new URLSearchParams(window.location.search).get("ref");
      const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature), referralCode);
      onAuthenticated(verified.wallet);
      track("wallet_signed_in", { network: "solana-mainnet" });
    } catch {
      track("wallet_sign_in_failed", { network: "solana-mainnet" });
    } finally {
      setSigningIn(false);
    }
  }

  async function disconnectWallet() {
    if (connected?.kind === "walletconnect") await disconnectWalletConnect();
    else standardDisconnect.dispatch();
  }

  if (connected) {
    const isAuthenticated = session === connected.address;
    return (
      <div className="wallet-control signed-wallet" ref={rootRef}>
        <button
          className={"wallet-button" + (isAuthenticated ? " is-signed" : "")}
          disabled={signingIn}
          onClick={() => void signIn()}
          title={isAuthenticated ? "Signed in — sign again to refresh your session" : "Sign in with wallet"}
        >
          {/* Signed in, the control is an identity badge: the sidebar's own raster profile glyph
              replaces the connection dot. A connected-but-unsigned wallet keeps the dot, because
              there the dot is the "not signed in yet" signal the player acts on. */}
          {isAuthenticated ? (
            <IconProfile className="wallet-button-icon" size={23} />
          ) : (
            <i className="wallet-dot" aria-hidden="true" />
          )}
          {/* The label keeps its text for the accessible name; the 820px rule clips it visually so
              the 42px button centres the glyph instead of the name. */}
          <span className="wallet-button-label">
            {signingIn ? "Signing…" : isAuthenticated ? displayName(connected.address, viewer.username) : "Sign in"}
          </span>
        </button>
        <button className="wallet-disconnect" onClick={() => void disconnectWallet()} aria-label="Disconnect wallet" title="Disconnect wallet">
          <IconLogout size={18} />
        </button>
        {isAuthenticated && (
          <button
            className="wallet-disconnect"
            aria-expanded={identityOpen}
            aria-haspopup="true"
            aria-label={viewer.username === null ? "Set username" : "Public username: " + viewer.username}
            onClick={() => setIdentityOpen((value) => !value)}
            title={viewer.username === null ? "Set a public username" : "Your public username: " + viewer.username}
          >
            {/* The disclosure had no glyph, so it read as an empty bordered box next to the
                disconnect cross. Sliders say "edit your details", which is what the menu holds;
                the accessible name stays the sr-only text below. */}
            <IconSettings size={18} />
            <span className="sr-only">{viewer.username === null ? "Set username" : "Public username"}</span>
          </button>
        )}
        {isAuthenticated && identityOpen && (
          <div className="wallet-menu" role="group" aria-label="Public username">
            <strong>Public username</strong>
            <UsernameEditor key={connected.address} wallet={connected.address} onChanged={() => setIdentityOpen(false)} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-control" ref={rootRef}>
      <button className="wallet-button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((value) => !value)}>
        <IconWallet className="wallet-button-icon" size={23} /> <span className="wallet-button-label">Connect wallet</span>
      </button>
      {open && (
        <div className="wallet-menu" role="group" aria-label="Choose a wallet">
          <strong>Choose a Wallet Standard wallet</strong>
          {wallets.length > 0 ? wallets.map((wallet) => (
            <button
              key={wallet.name}
              disabled={connect.isRunning}
              onClick={() => {
                connect.dispatch(wallet);
                setOpen(false);
                track("wallet_connected", { network: "solana-mainnet" });
              }}
            >
              {wallet.icon && <img src={wallet.icon} alt="" />} {wallet.name}
            </button>
          )) : <p>No compatible browser wallet found on this device.</p>}
          <button
            type="button"
            className="wallet-walletconnect-button"
            onClick={() => {
              track("walletconnect_opened", { network: "solana-mainnet" });
              void openWalletConnect().then((opened) => {
                setWalletConnectError(opened ? "" : "Could not load WalletConnect. Check your connection and try again.");
                if (opened) setOpen(false);
              });
            }}
          >
            <IconWallet size={23} /> Connect WalletConnect
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
