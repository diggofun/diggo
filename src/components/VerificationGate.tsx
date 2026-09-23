/**
 * Renders the extra check a gated action occasionally needs (spec 52).
 *
 * The screen only ever says "Additional verification required": the Worker's neutral copy, never
 * a score, signal or threshold (spec 62). Which strategy runs is decided server-side, and the
 * signed-message path needs no UI at all because it reuses the wallet the player already signed
 * in with.
 */
import { useCallback, useRef, useState, type ReactNode } from "react";
import { IconClose } from "../icons";
import { NEUTRAL_VERIFICATION_TEXT, VerificationRequiredError } from "../verification";
import { TurnstileBox } from "./TurnstileBox";

export interface VerificationGate {
  /** Resolves with a Turnstile token; rejects when the player closes the prompt. */
  requestTurnstileToken(): Promise<string>;
  /** The prompt to render while a check is pending; null the rest of the time. */
  verificationModal: ReactNode;
}

export function useVerificationGate(siteKey: string): VerificationGate {
  const resolverRef = useRef<((token: string) => void) | null>(null);
  const [visible, setVisible] = useState(false);

  const requestTurnstileToken = useCallback(
    () =>
      new Promise<string>((resolve, reject) => {
        resolverRef.current = (token) => {
          if (token) resolve(token);
          else reject(new VerificationRequiredError());
        };
        setVisible(true);
      }),
    [],
  );

  // A stable handler matters: TurnstileBox re-renders its widget whenever onToken changes.
  const handleToken = useCallback((token: string) => {
    setVisible(false);
    const resolver = resolverRef.current;
    resolverRef.current = null;
    resolver?.(token);
  }, []);

  const cancel = useCallback(() => {
    setVisible(false);
    const resolver = resolverRef.current;
    resolverRef.current = null;
    resolver?.("");
  }, []);

  const verificationModal = visible ? (
    <div className="modal-backdrop" role="presentation">
      <section className="verify-modal" role="dialog" aria-modal="true" aria-labelledby="verify-title">
        <button className="modal-close" onClick={cancel} aria-label="Close">
          <IconClose size={20} />
        </button>
        <div className="eyebrow">
          Security check
        </div>
        <h2 id="verify-title">{NEUTRAL_VERIFICATION_TEXT}</h2>
        <p className="modal-intro">
          Finish the check below and your action continues automatically. It stays cleared for a
          short while, so this will not appear on every click.
        </p>
        <TurnstileBox siteKey={siteKey} onToken={handleToken} />
      </section>
    </div>
  ) : null;

  return { requestTurnstileToken, verificationModal };
}
