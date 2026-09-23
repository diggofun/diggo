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
 * The per-device push opt-in is rendered inside the dropdown, next to the alerts it controls, so
 * turning server-driven delivery on does not require finding another part of the page.
 */
import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, Check, RefreshCw } from "lucide-react";
import type { NotificationRecord } from "../../shared/types";
import { getNotifications, markNotificationsRead } from "../api";
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

const ITEM_ACTIONS_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
} as const;

const ITEM_BUTTON_STYLE = {
  width: 20,
  height: 20,
  padding: 0,
  display: "grid",
  placeItems: "center",
  border: "1px solid var(--line)",
  background: "transparent",
  color: "inherit",
} as const;

function describe(kind: string): string {
  return KIND_LABELS[kind] ?? kind.replaceAll("_", " ").toLowerCase();
}

function payloadLines(notification: NotificationRecord): string[] {
  return Object.entries(notification.payload).map(([key, value]) => key.replaceAll("_", " ") + ": " + String(value));
}

export function NotificationsBell({ signedIn }: NotificationsBellProps) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!signedIn) {
      setNotifications([]);
      setUnread(0);
      return;
    }
    setLoading(true);
    try {
      const listed = await getNotifications();
      setNotifications(listed.notifications);
      setUnread(listed.unread);
      setError("");
    } catch {
      setError("Notifications are unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    void load();
    if (!signedIn) return undefined;
    const timer = window.setInterval(() => void load(), POLL_INTERVAL_MS);
    const onFocus = () => void load();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void load();
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
    try {
      const result = await markNotificationsRead(ids);
      setUnread(result.unread);
      setError("");
      const stamp = Math.floor(Date.now() / 1_000);
      setNotifications((current) =>
        current.map((item) =>
          (ids === undefined || ids.includes(item.id)) && item.readAt === null ? { ...item, readAt: stamp } : item,
        ),
      );
    } catch {
      setError("Could not mark notifications as read.");
    }
  }

  if (!signedIn) {
    return (
      <span className="notifications-bell is-disabled" title="Sign in to receive crew notifications">
        <Bell size={16} />
      </span>
    );
  }

  return (
    <div className="notifications">
      <button
        className={"notifications-bell" + (unread > 0 ? " has-unread" : "")}
        onClick={() => {
          setOpen((value) => !value);
          if (!open) void load();
        }}
        aria-label={unread > 0 ? unread + " unread notifications" : "Notifications"}
      >
        {unread > 0 ? <BellRing size={16} /> : <Bell size={16} />}
        {unread > 0 && <i className="notifications-count">{unread > 9 ? "9+" : unread}</i>}
      </button>

      {open && (
        <div className="notifications-menu">
          <header>
            <strong>Crew notifications</strong>
            <div>
              <button onClick={() => void load()} aria-label="Refresh notifications" title="Refresh">
                <RefreshCw size={13} className={loading ? "spin" : ""} />
              </button>
              <button onClick={() => void markRead()} aria-label="Mark all read" title="Mark all read">
                <Check size={13} />
              </button>
            </div>
          </header>
          {error && <p className="form-message">{error}</p>}
          {notifications.length === 0 && !error && <p className="notifications-empty">Nothing to report yet.</p>}
          <ul>
            {notifications.map((notification) => (
              <li key={notification.id} className={notification.readAt ? "is-read" : ""}>
                <div className="notifications-item-head">
                  <strong>{describe(notification.kind)}</strong>
                  <div style={ITEM_ACTIONS_STYLE}>
                    <small>{new Date(notification.createdAt * 1_000).toLocaleString()}</small>
                    {notification.readAt === null && (
                      <button
                        type="button"
                        style={ITEM_BUTTON_STYLE}
                        onClick={() => void markRead([notification.id])}
                        aria-label={"Mark " + describe(notification.kind) + " as read"}
                        title="Mark read"
                      >
                        <Check size={11} />
                      </button>
                    )}
                  </div>
                </div>
                {payloadLines(notification).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </li>
            ))}
          </ul>
          <PushToggle variant="inline" />
        </div>
      )}
    </div>
  );
}
