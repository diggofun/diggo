/**
 * Cosmetics (spec 34).
 *
 * The catalog is earned-only in practice: every entry is either unlocked by gameplay or marked as
 * a display piece that is not for sale yet. Purchasable entries are shown with a "coming soon"
 * badge and cannot be equipped, because payments are not implemented and a cosmetic must never be
 * able to touch Mining Power, ORE or discovery odds.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, Lock, Shirt, Sparkles } from "lucide-react";
import type { CosmeticsView } from "../../shared/types";
import { equipCosmetic, getCosmetics, unequipCosmetic } from "../api";

export interface CosmeticsScreenProps {
  signedIn: boolean;
}

export function CosmeticsScreen({ signedIn }: CosmeticsScreenProps) {
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
      setView(await getCosmetics());
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
      {signedIn && loading && !view && <p className="board-empty">Loading your loadout…</p>}
      {error && <p className="form-message">{error}</p>}

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
                  <button className="ledger-token" disabled={busy === slot} onClick={() => void unequip(slot)}>
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
                      className={"cosmetic-card" + (item.equipped ? " is-equipped" : "") + (locked ? " is-locked" : "")}
                      key={item.id}
                    >
                      <header>
                        <strong>{item.name}</strong>
                        {comingSoon && <em className="cosmetic-soon">coming soon</em>}
                        {!comingSoon && locked && (
                          <em className="cosmetic-locked">
                            <Lock size={11} /> locked
                          </em>
                        )}
                        {item.equipped && (
                          <em className="cosmetic-equipped">
                            <Check size={11} /> equipped
                          </em>
                        )}
                      </header>
                      <p>{item.description}</p>
                      {item.unlockKind === "streak" && <small>Unlocks at a {item.unlockRef}-day streak</small>}
                      {item.unlockKind === "tier" && <small>Unlocks at crew tier {item.unlockRef}</small>}
                      {item.unlockKind === "achievement" && <small>Unlocks with {item.unlockRef}</small>}
                      <button
                        className="ledger-token"
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
