/**
 * Notification bell (spec 75).
 *
 * The Worker decides which notifications exist — a mine expiring in three hours, the crew going
 * quiet, a rare discovery, a reduction coming, a mine nearly out of reserve. This component only
 * lists them and marks them read; it never invents a notification and never turns a missing one
 * into a claim about future rewards.
 */
import { useCallback, useEffect, useState } from "react";
import { Bell, BellRing, Check, RefreshCw } from "lucide-react";
import type { NotificationRecord } from "../../shared/types";
import { getNotifications, markNotificationsRead } from "../api";

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
    const timer = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(timer);
  }, [load, signedIn]);

  async function markAllRead(): Promise<void> {
    try {
      await markNotificationsRead();
      setUnread(0);
      setNotifications((current) => current.map((item) => ({ ...item, readAt: item.readAt ?? Math.floor(Date.now() / 1_000) })));
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
              <button onClick={() => void markAllRead()} aria-label="Mark all read" title="Mark all read">
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
                  <small>{new Date(notification.createdAt * 1_000).toLocaleString()}</small>
                </div>
                {payloadLines(notification).map((line) => (
                  <span key={line}>{line}</span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
