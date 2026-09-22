/**
 * Mine picker for SWITCH MINE (spec 30).
 *
 * Switching settles the previous position first and leaves activation and streak untouched, so this
 * dialog only has to answer one question: which mine should the crew work next. Fully mined mines
 * are not offered — there is nothing left in them to pay.
 */
import { Pickaxe, Repeat2, X } from "lucide-react";
import type { TokenSummary } from "../../shared/types";
import { compact } from "../format";
import { TokenOrb } from "./TokenOrb";

export interface SwitchMineModalProps {
  tokens: TokenSummary[];
  activeMint: string | null;
  switching: boolean;
  error: string;
  onSwitch(mint: string): void;
  onClose(): void;
}

function mineLine(token: TokenSummary): string {
  return (
    compact(token.networkPower) +
    " network power, " +
    compact(token.rewardPerBlock) +
    " $" +
    token.symbol +
    " per block"
  );
}

export function SwitchMineModal({
  tokens,
  activeMint,
  switching,
  error,
  onSwitch,
  onClose,
}: SwitchMineModalProps) {
  const available = tokens.filter((token) => token.status !== "FULLY_MINED");

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="switch-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Switch mine"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button className="modal-close" onClick={onClose} aria-label="Close">
          <X size={20} />
        </button>
        <div className="eyebrow">
          <Repeat2 size={14} /> Switch mine
        </div>
        <h2>Move the crew.</h2>
        <p className="modal-intro">
          Switching settles what the crew has already earned and moves its Mining Power. Activation
          and your streak stay exactly as they are.
        </p>
        {error && <p className="form-message">{error}</p>}
        <ul className="switch-list">
          {available.map((token) => {
            const isCurrent = token.mint === activeMint;
            return (
              <li key={token.mint} className={isCurrent ? "is-current" : ""}>
                <span className="switch-token">
                  <TokenOrb symbol={token.symbol} imageUrl={token.imageUrl} />
                  <span>
                    <strong>{token.name}</strong>
                    <small>{mineLine(token)}</small>
                  </span>
                </span>
                <button
                  className={isCurrent ? "outline-button" : "primary-button"}
                  disabled={isCurrent || switching}
                  onClick={() => onSwitch(token.mint)}
                >
                  {isCurrent ? (
                    "Current mine"
                  ) : (
                    <>
                      <Pickaxe size={14} /> Switch crew here
                    </>
                  )}
                </button>
              </li>
            );
          })}
          {available.length === 0 && (
            <li className="switch-empty">No mine is open for mining yet. Launch one to start digging.</li>
          )}
        </ul>
      </section>
    </div>
  );
}
