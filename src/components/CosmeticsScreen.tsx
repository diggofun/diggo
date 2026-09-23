/**
 * Cosmetics (spec 34).
 *
 * The catalog is earned-only in practice: every entry is either unlocked by gameplay or marked as
 * a display piece that is not for sale yet. Purchasable entries are shown with a "coming soon"
 * badge and cannot be equipped, because payments are not implemented and a cosmetic must never be
 * able to touch Mining Power, ORE or discovery odds.
 *
 * Equipping something is visible immediately: the preview below the header is the real MineScene
 * rendered with the server's equipped map, so an outfit, a cart or a mine theme shows up exactly
 * where it will be seen while digging.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Lock, Shirt, Sparkles } from "lucide-react";
import type { CosmeticsView } from "../../shared/types";
import { equipCosmetic, getCosmetics, unequipCosmetic } from "../api";
import { setEquippedCosmetics } from "../cosmetics";
import { MineScene } from "./MineScene";

export interface CosmeticsScreenProps {
  signedIn: boolean;
  /** Crew tier the preview mine is drawn at; the real scene uses the player's own tier. */
  previewTier?: number;
}

export function CosmeticsScreen({ signedIn, previewTier = 3 }: CosmeticsScreenProps) {
  const [view, setView] = useState<CosmeticsView | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!signedIn) {
      setView(null);
      return;
    }
    setLoading(true);
    try {
      const loaded = await getCosmetics();
      setView(loaded);
      // Publish to src/cosmetics.ts so the dashboard and crew board draw the same loadout without
      // asking the Worker for it a second time.
      setEquippedCosmetics(loaded.equipped);
      setError("");
    } catch {
      setError("Your cosmetics are unavailable right now.");
    } finally {
      setLoading(false);
    }
  }, [signedIn]);

  useEffect(() => {
    void load();
  }, [load]);

  async function equip(cosmeticId: string, slot: string): Promise<void> {
    setBusy(cosmeticId);
    setError("");
    try {
      const result = await equipCosmetic(cosmeticId);
      setEquippedCosmetics(result.equipped);
      setView((current) =>
        current
          ? {
              ...current,
              equipped: result.equipped,
              catalog: current.catalog.map((item) =>
                item.slot === slot
                  ? { ...item, equipped: item.id === cosmeticId }
                  : item,
              ),
            }
          : current,
      );
    } catch {
      setError("Could not equip that cosmetic.");
    } finally {
      setBusy("");
    }
  }

  async function unequip(slot: string): Promise<void> {
    setBusy(slot);
    try {
      const result = await unequipCosmetic(slot);
      setEquippedCosmetics(result.equipped);
      setView((current) =>
        current
          ? {
              ...current,
              equipped: result.equipped,
              catalog: current.catalog.map((item) => (item.slot === slot ? { ...item, equipped: false } : item)),
            }
          : current,
      );
    } catch {
      setError("Could not clear that slot.");
    } finally {
      setBusy("");
    }
  }

  const slots = view?.slots ?? [];
  const earned = view?.catalog.filter((item) => item.unlocked).length ?? 0;
  const total = view?.catalog.length ?? 0;
  const equippedCount = view ? Object.keys(view.equipped).length : 0;

  return (
    <section className="cosmetics page-shell" id="cosmetics">
      <div className="section-heading">
        <div>
          <div className="eyebrow">
            <Shirt size={14} /> Cosmetics
          </div>
          <h2>
            DRESS THE
            <br />
            SHIFT.
          </h2>
        </div>
        <div className="cosmetics-summary">
          <strong>
            {earned} / {total}
          </strong>
          <small>unlocked by playing</small>
        </div>
      </div>

      <p className="cosmetics-rule">
        Cosmetics are visual only. They never change Mining Power, ORE or discovery odds, and nothing
        here can be bought with money.
      </p>

      {!signedIn && <p className="board-empty">Sign in to unlock and equip your cosmetics.</p>}
      {signedIn && loading && !view && (
        <div className="cosmetics-loading" aria-busy="true">
          <span className="skeleton skeleton-card" />
          <span className="skeleton skeleton-card" />
          <span className="skeleton skeleton-card" />
        </div>
      )}
      {error && (
        <p className="form-message" role="alert">
          {error}
        </p>
      )}

      {signedIn && view && (
        <div className="cosmetics-preview">
          <div className="mine-info-subhead">
            <span>
              <Sparkles size={13} aria-hidden="true" /> PREVIEW · TIER {previewTier}
            </span>
            <small>
              {equippedCount === 0
                ? "nothing equipped yet — the mine is wearing its defaults"
                : equippedCount + (equippedCount === 1 ? " slot equipped" : " slots equipped")}
            </small>
          </div>
          <MineScene tier={previewTier} active cosmetics={view.equipped} label="Your loadout" />
          <p>
            This is the mine your crew digs in. Colours and themes only — the preview has no effect
            on Mining Power, block rewards or discovery odds.
          </p>
        </div>
      )}

      {signedIn &&
        view &&
        slots.map((slot) => {
          const items = view.catalog.filter((item) => item.slot === slot);
          if (items.length === 0) return null;
          const equippedId = view.equipped[slot];
          return (
            <div className="cosmetic-slot" key={slot}>
              <div className="cosmetic-slot-head">
                <span>{slot.replaceAll("_", " ")}</span>
                {equippedId && (
                  <button className="btn btn-ghost btn-sm" disabled={busy === slot} onClick={() => void unequip(slot)}>
                    Clear slot
                  </button>
                )}
              </div>
              <div className="cosmetic-grid">
                {items.map((item) => {
                  const comingSoon = item.source === "purchasable" || item.status === "coming_soon";
                  const locked = !item.unlocked;
                  return (
                    <article
                      className={"card cosmetic-card" + (item.equipped ? " is-equipped" : "") + (locked ? " is-locked" : "")}
                      key={item.id}
                    >
                      <header>
                        <strong>{item.name}</strong>
                        {comingSoon && <em className="badge badge-idle">coming soon</em>}
                        {!comingSoon && locked && (
                          <em className="badge badge-idle">
                            <Lock size={11} aria-hidden="true" /> locked
                          </em>
                        )}
                        {item.equipped && (
                          <em className="badge badge-active">
                            <Check size={11} aria-hidden="true" /> equipped
                          </em>
                        )}
                      </header>
                      <p>{item.description}</p>
                      {item.unlockKind === "streak" && <small>Unlocks at a {item.unlockRef}-day streak</small>}
                      {item.unlockKind === "tier" && <small>Unlocks at crew tier {item.unlockRef}</small>}
                      {item.unlockKind === "achievement" && <small>Unlocks with {item.unlockRef}</small>}
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={comingSoon || locked || item.equipped || busy === item.id}
                        onClick={() => void equip(item.id, slot)}
                      >
                        {comingSoon ? "Not for sale" : item.equipped ? "Equipped" : locked ? "Keep digging" : "Equip"}
                      </button>
                    </article>
                  );
                })}
              </div>
            </div>
          );
        })}

      {signedIn && view && !view.purchasesEnabled && (
        <p className="cosmetics-note">
          <Sparkles size={12} /> Display items stay marked "coming soon": the game does not sell
          anything, and no purchase will ever grant power or rewards.
        </p>
      )}
    </section>
  );
}
