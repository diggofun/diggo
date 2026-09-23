/**
 * Loading, empty and error states shared by every screen, so a slow network or an empty mine
 * reads the same everywhere instead of as a blank page.
 */
import type { ReactNode } from "react";
import { IconMine } from "../icons";

export function LoadingScreen({ label = "Digging up the data…" }: { label?: string }) {
  return (
    <div className="loading-screen" role="status" aria-live="polite">
      <span className="loading-pick" aria-hidden="true">
        <IconMine size={34} />
      </span>
      <span>{label}</span>
    </div>
  );
}

/** Skeleton shown while a lazily loaded screen downloads. */
export function RouteFallback({ rows = 3 }: { rows?: number }) {
  return (
    <section className="page-shell route-fallback" aria-busy="true" aria-label="Loading">
      <span className="skeleton skeleton-eyebrow" />
      <span className="skeleton skeleton-title" />
      <div className="skeleton-grid">
        {Array.from({ length: rows }, (_, index) => (
          <span className="skeleton skeleton-card" key={index} />
        ))}
      </div>
    </section>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden="true">{icon ?? <IconMine size={26} />}</span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ title, children, onRetry }: { title: string; children?: ReactNode; onRetry?(): void }) {
  return (
    <div className="error-state" role="alert">
      <div>
        <strong>{title}</strong>
        {children && <p>{children}</p>}
      </div>
      {onRetry && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}
