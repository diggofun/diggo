import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { awaitConfirmation, isPendingTransactionError, RejectedTransactionError } from "./tx";

interface PendingTransaction {
  signature: string;
  label: string;
  scope: string;
  mint?: string;
}

interface PendingTransactionContextValue {
  pending: PendingTransaction | null;
  resolution: string;
  canSubmit(): boolean;
  record(error: unknown, label: string): boolean;
  recordSubmission(signature: string, label: string, mint?: string): void;
  clear(): void;
  checkStatus(): Promise<void>;
  dismissResolution(): void;
}

const STORAGE_KEY = "diggo.pending-transaction.v1";
const PendingTransactionContext = createContext<PendingTransactionContextValue | null>(null);

function readPending(scope: string): PendingTransaction | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingTransaction> | null;
    if (
      value?.scope !== scope ||
      typeof value.signature !== "string" ||
      typeof value.label !== "string"
    ) {
      return null;
    }
    return { scope, signature: value.signature, label: value.label };
  } catch {
    return null;
  }
}

function writePending(pending: PendingTransaction | null): void {
  try {
    if (pending) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Session storage can be unavailable in private browsing. The in-memory guard still holds.
  }
}

export function PendingTransactionProvider({
  walletAddress,
  children,
}: {
  walletAddress: string | null;
  children: ReactNode;
}) {
  const scope = walletAddress ?? "none";
  const [pending, setPending] = useState<PendingTransaction | null>(() =>
    walletAddress ? readPending(scope) : null,
  );
  const [resolution, setResolution] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    setPending(walletAddress ? readPending(scope) : null);
    setResolution("");
  }, [scope, walletAddress]);

  const replacePending = useCallback((next: PendingTransaction | null) => {
    setPending(next);
    writePending(next);
  }, []);

  const clear = useCallback(() => {
    replacePending(null);
    setResolution("");
  }, [replacePending]);

  const record = useCallback((error: unknown, label: string): boolean => {
    if (!isPendingTransactionError(error)) return false;
    replacePending({
      signature: error.signature,
      label,
      scope,
      ...(error.mint ? { mint: error.mint } : {}),
    });
    setResolution("");
    return true;
  }, [replacePending, scope]);

  const recordSubmission = useCallback((signature: string, label: string, mint?: string) => {
    replacePending({ signature, label, scope, ...(mint ? { mint } : {}) });
    setResolution("");
  }, [replacePending, scope]);

  const checkStatus = useCallback(async (): Promise<void> => {
    if (!pending) return;
    setChecking(true);
    try {
      if (await awaitConfirmation(pending.signature)) {
        replacePending(null);
        setResolution(`${pending.label} is confirmed. Chain state can now be refreshed safely.`);
      } else {
        setResolution(`${pending.label} is still pending. Do not submit it again; check again shortly.`);
      }
    } catch (error) {
      if (error instanceof RejectedTransactionError) {
        replacePending(null);
        setResolution(
          `${pending.label} was rejected: ${error.message}. You can retry after refreshing.`,
        );
      } else {
        setResolution(
          `${pending.label} could not be checked because the RPC did not answer. The signature is still retained; try checking again shortly.`,
        );
      }
    } finally {
      setChecking(false);
    }
  }, [pending, replacePending]);

  const value = useMemo<PendingTransactionContextValue>(() => ({
    pending,
    resolution,
    canSubmit: () => pending === null,
    record,
    recordSubmission,
    clear,
    checkStatus,
    dismissResolution: () => setResolution(""),
  }), [checkStatus, clear, pending, record, recordSubmission, resolution]);

  return (
    <PendingTransactionContext.Provider value={value}>
      {children}
      {(pending || resolution) && (
        <aside className="page-shell page-alert" role="status" aria-live="polite">
          {pending ? (
            <div className="pending-transaction-banner">
              <div>
                <strong>{pending.label} is submitted but still pending.</strong>
                <p>
                  The network accepted this signature, but confirmation did not arrive before the deadline. It may still land.
                  New signed actions are blocked to prevent a duplicate transaction.
                </p>
                <a href={`https://explorer.solana.com/tx/${pending.signature}?cluster=devnet`} target="_blank" rel="noreferrer">
                  View signature {pending.signature.slice(0, 8)}…
                </a>
                {pending.mint && <p>Derived mint for launch recovery: <code>{pending.mint}</code></p>}
              </div>
              <button className="outline-button" disabled={checking} onClick={() => void checkStatus()}>
                {checking ? "Checking…" : "Check status"}
              </button>
            </div>
          ) : (
            <div className="pending-transaction-banner">
              <p>{resolution}</p>
              <button className="outline-button" onClick={() => setResolution("")}>Dismiss</button>
            </div>
          )}
        </aside>
      )}
    </PendingTransactionContext.Provider>
  );
}

export function usePendingTransaction(): PendingTransactionContextValue {
  const value = useContext(PendingTransactionContext);
  if (!value) throw new Error("usePendingTransaction must be used inside PendingTransactionProvider");
  return value;
}
