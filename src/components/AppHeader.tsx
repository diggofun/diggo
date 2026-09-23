/**
 * Site header, main navigation and the mobile tab bar.
 *
 * The game loop (Mine, Crew, Discoveries) comes first, the market (Explore, Mines, Trade) second
 * and the community screens last. Below 1180px the full list collapses into a Menu panel; below
 * 760px the five most used destinations also sit in a thumb-reachable tab bar.
 */
import { useEffect, useRef, useState, type ComponentType } from "react";
import { useConnect, useDisconnect, useWallets } from "@solana/kit-plugin-wallet/react";
import bs58 from "bs58";
import {
  Gem,
  Hammer,
  Home,
  LayoutDashboard,
  Menu,
  Pickaxe,
  Plus,
  Search,
  Sparkles,
  TrendingUp,
  Trophy,
  Wallet,
  X,
  type LucideProps,
} from "lucide-react";
import { getChallenge, verifyWallet } from "../api";
import { track } from "../analytics";
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
  | "admin"
  | "ui";

interface NavItem {
  page: PageId;
  href: string;
  label: string;
  short?: string;
  icon: ComponentType<LucideProps>;
}

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Play",
    items: [
      { page: "mine", href: "/mine", label: "Mine", icon: Pickaxe },
      { page: "crew", href: "/crew", label: "Crew", icon: Hammer },
      { page: "discoveries", href: "/discoveries", label: "Discoveries", short: "Finds", icon: Gem },
    ],
  },
  {
    label: "Market",
    items: [
      { page: "explore", href: "/explore", label: "Explore", icon: Search },
      { page: "mines", href: "/mines", label: "Mines", icon: LayoutDashboard },
      { page: "trade", href: "/trade", label: "Trade", icon: TrendingUp },
    ],
  },
  {
    label: "Community",
    items: [
      { page: "leaderboards", href: "/leaderboards", label: "Leaderboards", icon: Trophy },
      { page: "cosmetics", href: "/cosmetics", label: "Cosmetics", icon: Sparkles },
    ],
  },
];

const TAB_BAR: PageId[] = ["mine", "crew", "discoveries", "explore", "trade"];
const ALL_ITEMS = NAV_GROUPS.flatMap((group) => group.items);

export function BrandMark() {
  return (
    <a className="brand" href="/" aria-label="Diggo.fun home">
      {/* The lockup when there is room, the square mark in the narrow header. */}
      <span className="brand-slot brand-slot-wide">
        <img className="brand-art" src="/assets/brand/logo.svg" alt="Diggo" width={598} height={140} />
      </span>
      <span className="brand-slot brand-slot-icon">
        <img className="brand-art brand-art-icon" src="/assets/brand/logo-mark.svg" alt="Diggo" width={64} height={64} />
      </span>
    </a>
  );
}

export function AppHeader({
  page,
  session,
  signedIn,
  onAuthenticated,
}: {
  page: PageId;
  session: string | null;
  signedIn: boolean;
  onAuthenticated(wallet: string): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <>
      <header className="site-header">
        <BrandMark />
        <nav className="main-nav" aria-label="Main navigation">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label} role="group" aria-label={group.label}>
              {group.items.map((item) => (
                <NavLink key={item.page} item={item} active={page === item.page} />
              ))}
            </div>
          ))}
        </nav>
        <div className="header-actions">
          <a className="launch-button" href="/create" aria-current={page === "create" ? "page" : undefined}>
            <Plus size={16} /> Create coin
          </a>
          <NotificationsBell signedIn={signedIn} />
          <WalletControl session={session} onAuthenticated={onAuthenticated} />
          <button
            type="button"
            className="menu-button"
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            {menuOpen ? <X size={18} /> : <Menu size={18} />}
            <span className="sr-only">{menuOpen ? "Close menu" : "Open menu"}</span>
          </button>
        </div>
        {menuOpen && (
          <div className="site-menu" id="site-menu">
            <a className={"site-menu-link" + (page === "home" ? " active" : "")} href="/" aria-current={page === "home" ? "page" : undefined}>
              <Home size={16} /> Home
            </a>
            {NAV_GROUPS.map((group) => (
              <div className="site-menu-group" key={group.label}>
                <span>{group.label}</span>
                {group.items.map((item) => (
                  <NavLink key={item.page} item={item} active={page === item.page} className="site-menu-link" />
                ))}
              </div>
            ))}
            <a className="btn btn-primary site-menu-create" href="/create">
              <Plus size={16} /> Create a new coin
            </a>
          </div>
        )}
      </header>
      <nav className="tab-bar" aria-label="Game shortcuts">
        {TAB_BAR.map((id) => {
          const item = ALL_ITEMS.find((candidate) => candidate.page === id)!;
          const Icon = item.icon;
          return (
            <a key={id} href={item.href} className={page === id ? "active" : ""} aria-current={page === id ? "page" : undefined}>
              <Icon size={19} aria-hidden="true" />
              <span>{item.short ?? item.label}</span>
            </a>
          );
        })}
      </nav>
    </>
  );
}

function NavLink({ item, active, className = "" }: { item: NavItem; active: boolean; className?: string }) {
  const Icon = item.icon;
  return (
    <a className={(className + (active ? " active" : "")).trim()} href={item.href} aria-current={active ? "page" : undefined}>
      <Icon size={14} aria-hidden="true" /> {item.label}
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
  // The signed-in wallet's public username (src/username.ts), so the header can show it where it
  // shows the wallet and fall back to the shortened address when the player never set one.
  const viewer = useUsername(connected && session !== null && session === connected.address ? connected.address : null);

  // Any "Connect wallet" call to action on the page opens this menu.
  useEffect(() => {
    const onRequest = () => {
      setOpen(true);
      rootRef.current?.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener(OPEN_WALLET_EVENT, onRequest);
    return () => window.removeEventListener(OPEN_WALLET_EVENT, onRequest);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function signIn(): Promise<void> {
    if (!connected) return;
    setSigningIn(true);
    try {
      const challenge = await getChallenge(connected.address);
      const signature = await connected.signMessage(new TextEncoder().encode(challenge.message));
      const verified = await verifyWallet(connected.address, challenge.nonce, bs58.encode(signature));
      onAuthenticated(verified.wallet);
      track("wallet_signed_in", { network: "solana-devnet" });
    } catch {
      track("wallet_sign_in_failed", { network: "solana-devnet" });
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
      <div className="wallet-control signed-wallet">
        <button
          className={"wallet-button" + (isAuthenticated ? " is-signed" : "")}
          disabled={signingIn}
          onClick={() => void signIn()}
          title={isAuthenticated ? "Signed in — sign again to refresh your session" : "Sign in with wallet"}
        >
          <i className="wallet-dot" aria-hidden="true" />
          {signingIn ? "Signing…" : isAuthenticated ? displayName(connected.address, viewer.username) : "Sign in"}
        </button>
        <button
          className="wallet-disconnect"
          onClick={() => void disconnectWallet()}
          aria-label="Disconnect wallet"
          title="Disconnect wallet (your secure session stays active)"
        >
          <X size={14} />
        </button>
        {isAuthenticated && (
          <button
            className="wallet-disconnect"
            aria-expanded={identityOpen}
            aria-haspopup="true"
            onClick={() => setIdentityOpen((value) => !value)}
            title={viewer.username === null ? "Set a public username" : "Your public username: " + viewer.username}
          >
            <span className="sr-only">{viewer.username === null ? "Set username" : "Public username"}</span>
            <Sparkles size={14} />
          </button>
        )}
        {isAuthenticated && identityOpen && (
          <div className="wallet-menu" role="group" aria-label="Public username">
            <strong>Public username</strong>
            <UsernameEditor
              key={connected.address}
              wallet={connected.address}
              onChanged={() => setIdentityOpen(false)}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="wallet-control" ref={rootRef}>
      <button className="wallet-button" aria-expanded={open} aria-haspopup="true" onClick={() => setOpen((value) => !value)}>
        <Wallet size={15} aria-hidden="true" /> <span>Connect wallet</span>
      </button>
      {open && (
        <div className="wallet-menu" role="group" aria-label="Choose a wallet">
          <strong>Choose a Wallet Standard wallet</strong>
          {wallets.length > 0 ? (
            wallets.map((wallet) => (
              <button
                key={wallet.name}
                disabled={connect.isRunning}
                onClick={() => {
                  connect.dispatch(wallet);
                  setOpen(false);
                  track("wallet_connected", { network: "solana-devnet" });
                }}
              >
                {wallet.icon && <img src={wallet.icon} alt="" />} {wallet.name}
              </button>
            ))
          ) : (
            <p>No compatible browser wallet found on this device.</p>
          )}
          <button
            type="button"
            className="wallet-walletconnect-button"
            onClick={() => {
              track("walletconnect_opened", { network: "solana-devnet" });
              // The AppKit chunk is fetched here, on first use, rather than with the main bundle.
              void openWalletConnect().then((opened) => {
                setWalletConnectError(
                  opened ? "" : "Could not load WalletConnect. Check your connection and try again.",
                );
                if (opened) setOpen(false);
              });
            }}
          >
            <Wallet size={16} /> Connect Wallet
          </button>
          <small>WalletConnect covers phones and any wallet not detected above.</small>
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
