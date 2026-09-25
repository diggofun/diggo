/**
 * Notification bell (spec 75).
 *
 * The Worker decides which notifications exist — a mine expiring in three hours, the crew going
 * quiet, a rare discovery, a reduction coming, a mine nearly out of reserve. This component only
 * reads GET /api/notifications, lists what comes back and marks it read. It never invents a
 * notification, never derives one from local state and never turns a missing one into a claim about
 * future rewards.
 *
 * The list is refreshed on a timer, when the tab regains focus and when the page becomes visible
 * again. The timer is what makes the bell current while the tab sits in the background; the focus
 * and visibility handlers are what make it current the moment the player looks at it, which is also
 * when the server may have generated something in the meantime. Neither path generates anything
 * locally - the cron trigger does that whether or not this component is mounted.
 *
 * A failed read is reported, never swallowed and never softened. This panel is the only place a
 * player can see that the bell is not working, so the failure is listed where the alerts would have
 * been, carrying the reason the Worker or the browser gave: an expired session, a rate limit and a
 * Worker that answered 500 are three different problems with three different fixes, and one
 * friendly sentence covered none of them. Whatever the last successful read returned stays under
 * that row, because it is still the last thing the Worker actually said.
 *
 * The per-device push opt-in is rendered inside the dropdown, next to the alerts it controls, so
 * turning server-driven delivery on does not require finding another part of the page.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { NotificationRecord } from "../../shared/types";
import { ApiError, getNotifications, markNotificationsRead } from "../api";
import { IconCheck, IconRefresh } from "../icons";
import { PushToggle } from "./PushToggle";

export interface NotificationsBellProps {
  signedIn: boolean;
}

const KIND_LABELS: Record<string, string> = {
  MINE_EXPIRES_3H: "Mine expires soon",
  MINE_EXPIRED: "Crew paused",
  STREAK_AT_RISK: "Streak at risk",
  RARE_DISCOVERY_FOUND: "Rare discovery",
  STREAK_7_DAY: "Seven day streak",
  REWARD_REDUCTION_APPROACHING: "Reward reduction",
  TOKEN_ALMOST_FULLY_MINED: "Mine nearly empty",
};

const POLL_INTERVAL_MS = 60_000;

/** How the panel is being read: the first read, a click on Refresh, or a silent poll. */
type LoadMode = "initial" | "refresh" | "background";

/** One failure, as the panel states it: what could not be done, and why. */
interface Notice {
  readonly title: string;
  readonly detail: string;
}

function describe(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replaceAll("_", " ").toLowerCase();
}

/**
 * The reason a call failed, in the words the panel shows.
 *
 * The status the Worker answered with is the most useful thing the client has, so it is carried
 * through rather than replaced: 401 means the session has to be renewed, 429 means waiting, and a
 * 5xx means the service itself is broken and retrying later is the only move. Nothing here retries
 * on its own, and nothing downgrades an error into an empty list.
 */
function cause(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return "Your sign-in has expired — sign in again to see crew notifications.";
    if (error.status === 429) {
      return error.retryAfterSec === null
        ? "Too many requests — this browser is being rate limited."
        : "Too many requests — try again in " + error.retryAfterSec + "s.";
    }
    const code = error.code === null ? "" : " (" + error.code + ")";
    const answered = "The service answered " + error.status + code;
    // src/api.ts falls back to "Request failed (500)" when the answer carried no message of its own,
    // which is a proxy or a crash rather than a stated reason. The status alone says that better.
    return error.message === "Request failed (" + error.status + ")"
      ? answered + "."
      : answered + ": " + error.message;
  }
  // A rejected fetch - offline, a proxy that is not up, a blocked request - never becomes a
  // Response, so there is no status to report and only the browser's own message to repeat.
  if (error instanceof TypeError) return "The request never reached the service: " + error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The list the panel can render, from whatever the Worker answered.
 *
 * getNotifications() is typed, but its answer is untrusted input: a proxy that answered HTML, or a
 * payload from another deploy, would otherwise reach render and throw inside the list. A malformed
 * answer is reported as the failure it is instead of being shown as an empty bell.
 */
function readListing(view: unknown): { notifications: NotificationRecord[]; unread: number } {
  const listed = view as { notifications?: unknown; unread?: unknown } | null;
  if (listed === null || typeof listed !== "object" || !Array.isArray(listed.notifications)) {
    throw new Error("The service answered without a notification list.");
  }
  const notifications = listed.notifications.filter(
    (item): item is NotificationRecord =>
      item !== null && typeof item === "object" && typeof (item as NotificationRecord).id === "number",
  );
  return {
    notifications,
    unread:
      typeof listed.unread === "number"
        ? listed.unread
        : notifications.filter((item) => item.readAt === null).length,
  };
}

function payloadLines(notification: NotificationRecord): string[] {
  const payload = notification.payload;
  if (payload === null || typeof payload !== "object") return [];
  if (notification.kind === "RARE_DISCOVERY_FOUND") {
    const name = typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : null;
    const symbol = typeof payload.symbol === "string" && payload.symbol.trim() ? payload.symbol.trim() : null;
    const rarity = typeof payload.rarity === "string" && payload.rarity.trim() ? payload.rarity.trim().toLowerCase() : "rare";
    if (name) return [symbol ? `${name} ($${symbol})` : name];
    // The Worker uses this display-safe fallback when indexed token metadata is unavailable.
    return [`Memecoin ($${symbol ?? "MEME"}) · ${rarity} · accrued in Discoveries`];
  }
  return Object.entries(payload).map(([key, value]) => key.replaceAll("_", " ") + ": " + String(value));
}

/** The Worker's seconds-since-epoch as local time, or a dash when the row carries something else. */
function formatStamp(seconds: number): string {
  return Number.isFinite(seconds) ? new Date(seconds * 1_000).toLocaleString() : "—";
}

export function NotificationsBell({ signedIn }: NotificationsBellProps) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unread, setUnread] = useState(0);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [mode, setMode] = useState<LoadMode>("initial");
  /** True once a read has actually answered, so "nothing to report" is never shown before one has. */
  const [loaded, setLoaded] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markingId, setMarkingId] = useState<number | null>(null);
  /** The read whose answer the panel is still waiting for, so a slow one cannot overwrite a newer. */
  const latest = useRef(0);

  const load = useCallback(
    async (requested: LoadMode = "background") => {
      if (!signedIn) {
        setNotifications([]);
        setUnread(0);
        setNotice(null);
        setMode("initial");
        setLoaded(false);
        return;
      }
      // A poll runs every minute and on every focus, so it stays silent: only a first read or a
      // click on Refresh puts the panel into a visible busy state.
      if (requested !== "background") setMode(requested);
      const read = latest.current + 1;
      latest.current = read;
      try {
        const listing = readListing(await getNotifications());
        // A click on Refresh while the minute poll was in flight: the answer that arrived last is
        // not the answer that was asked for last, and the panel shows what the Worker said now.
        if (read !== latest.current) return;
        setNotifications(listing.notifications);
        setUnread(listing.unread);
        setNotice(null);
        setLoaded(true);
      } catch (error) {
        if (read !== latest.current) return;
        setNotice({ title: "Notifications could not be loaded.", detail: cause(error) });
      } finally {
        if (requested !== "background" && read === latest.current) setMode("initial");
      }
    },
    [signedIn],
  );

  useEffect(() => {
    void load("initial");
    if (!signedIn) return undefined;
    const timer = window.setInterval(() => void load("background"), POLL_INTERVAL_MS);
    const onFocus = () => void load("background");
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load("background");
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [load, signedIn]);

  /** Marks the given ids read, or everything unread when ids are omitted. */
  async function markRead(ids?: number[]): Promise<void> {
    const single = ids?.[0] ?? null;
    if (single === null) setMarking(true);
    else setMarkingId(single);
    try {
      const result = await markNotificationsRead(ids);
      setUnread(typeof result?.unread === "number" ? result.unread : unread);
      setNotice(null);
      const stamp = Math.floor(Date.now() / 1_000);
      setNotifications((current) =>
        current.map((item) =>
          (ids === undefined || ids.includes(item.id)) && item.readAt === null ? { ...item, readAt: stamp } : item,
        ),
      );
    } catch (error) {
      setNotice({ title: "Could not mark notifications as read.", detail: cause(error) });
    } finally {
      setMarking(false);
      setMarkingId(null);
    }
  }

  if (!signedIn) {
    return (
      <span
        className="notifications-bell is-disabled"
        role="img"
        aria-label="Alerts, sign in to receive crew notifications"
        title="Sign in to receive crew notifications"
      >
        <span className="notifications-bell-label">Alerts</span>
      </span>
    );
  }

  // Only a click on Refresh spins: the minute poll and the focus reads stay silent.
  const refreshing = mode === "refresh";
  const checking = !loaded && notice === null && notifications.length === 0 && mode !== "background";

  return (
    <div className="notifications">
      <button
        className={"notifications-bell" + (unread > 0 ? " has-unread" : "")}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load("initial");
        }}
        aria-expanded={open}
        aria-label={unread > 0 ? unread + " unread notifications" : "Notifications"}
      >
        <span className="notifications-bell-label">Alerts</span>
        {unread > 0 && <i className="notifications-count">{unread > 9 ? "9+" : unread}</i>}
      </button>

      {open && (
        <div className="notifications-menu">
          <header className="notifications-head">
            <span className="notifications-title">
              <i className="notifications-title-glyph" aria-hidden="true" />
              <strong>Crew notifications</strong>
            </span>
            <div className="notifications-head-actions">
              <button
                type="button"
                className="notifications-action"
                onClick={() => void load("refresh")}
                disabled={refreshing}
                aria-busy={refreshing}
                aria-label="Refresh notifications"
                title="Refresh"
              >
                <IconRefresh size={16} className={refreshing ? "spin" : undefined} />
              </button>
              <button
                type="button"
                className="notifications-action"
                onClick={() => void markRead()}
                disabled={marking || unread === 0}
                aria-label="Mark all notifications as read"
                title="Mark all read"
              >
                <IconCheck size={16} />
              </button>
            </div>
          </header>

          {checking && <p className="notifications-empty">Checking for crew alerts…</p>}
          {loaded && notice === null && notifications.length === 0 && (
            <p className="notifications-empty">Nothing to report yet.</p>
          )}

          <ul className="notifications-list">
            {notice !== null && (
              <li className="notifications-notice">
                <div className="notifications-notice-body" role="alert">
                  <strong>{notice.title}</strong>
                  <span>{notice.detail}</span>
                </div>
                <button
                  type="button"
                  className="notifications-retry"
                  onClick={() => void load("refresh")}
                  disabled={refreshing}
                >
                  Try again
                </button>
              </li>
            )}
            {notifications.map((notification) => {
              const lines = payloadLines(notification);
              return (
                <li key={notification.id} className={notification.readAt ? "is-read" : ""}>
                  <div className="notifications-item-head">
                    <strong>{describe(notification.kind)}</strong>
                    <div className="notifications-item-actions">
                      <small>{formatStamp(notification.createdAt)}</small>
                      {notification.readAt === null && (
                        <button
                          type="button"
                          className="notifications-item-read"
                          onClick={() => void markRead([notification.id])}
                          disabled={markingId === notification.id}
                          aria-label={"Mark " + describe(notification.kind) + " as read"}
                          title="Mark read"
                        >
                          <IconCheck size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  {lines.length > 0 && (
                    <div className="notifications-payload">
                      {lines.map((line) => (
                        <span key={line}>{line}</span>
                      ))}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <PushToggle variant="inline" />
        </div>
      )}
    </div>
  );
}
