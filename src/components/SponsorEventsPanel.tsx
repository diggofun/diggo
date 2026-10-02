/**
 * Sponsor vaults and events, managed by the vault's owner.
 *
 * This is the only admin surface that is not governance, and it is deliberately narrow. A sponsor
 * event can pay rent and fees, and it can never change power, rewards, discovery odds, rarity,
 * caps or eligibility. The vault belongs to the owner's own wallet rather than to the Squads
 * configuration, it holds lamports, and it has no program authority of any kind. Withdrawal is
 * capped at what the vault has not spent, and unspent lamports are never the protocol's.
 *
 * Two ways out, both offered here:
 *
 * - **Direct**, when the vault owner is a single hot key — which is what a temporary deploy looks
 *   like. The transaction is signed and sent immediately.
 * - **As a proposal**, when the owner is a multisig. The same instructions are serialized into a
 *   base64 legacy message, which is the form Squads v4's import accepts; nothing here is signed,
 *   so the copy button cannot move a lamport on its own.
 */
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { IconBalance, IconClose, IconLandmark, IconPlus } from "../icons";
import {
  SPONSOR_EVENT_RENT_LAMPORTS,
  SPONSOR_KIND_OPTIONS,
  SPONSOR_VAULT_RENT_LAMPORTS,
  address,
  closeSponsorEventInstructions,
  createSponsorEventInstructions,
  fetchLatestBlockhash,
  fundSponsorVaultInstructions,
  initSponsorVaultInstructions,
  loadSponsorAdminState,
  sponsorEventActive,
  sponsorEventRemaining,
  sponsorKindLabel,
  sponsorProposalMessage,
  submitSponsorInstructions,
  withdrawSponsorVaultInstructions,
  type DiggoWallet,
  type SponsorAdminState,
} from "../solanaProgram";
import { usePendingTransaction } from "../onchain";

const LAMPORTS_PER_SOL = 1_000_000_000n;
const solToLamports = (sol: number) => BigInt(Math.round(sol * 1_000_000_000));
const lamportsToSol = (lamports: bigint) => Number(lamports) / 1_000_000_000;

/** A budget as a whole percent, clamped so a bar can never overflow. */
export function budgetUsedPercent(spent: bigint, budget: bigint): number {
  if (budget <= 0n) return 0;
  const percent = Number((spent * 10_000n) / budget) / 100;
  return Math.min(100, Math.max(0, percent));
}

export function SponsorEventsPanel({
  programAddress,
  wallet,
  onChanged,
}: {
  programAddress: string;
  wallet: DiggoWallet | null;
  onChanged?(): void;
}) {
  const [state, setState] = useState<SponsorAdminState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [fundAmount, setFundAmount] = useState("1");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [proposal, setProposal] = useState("");
  const pendingTransaction = usePendingTransaction();

  const [kind, setKind] = useState<number>(SPONSOR_KIND_OPTIONS[0].kind);
  const [days, setDays] = useState("30");
  const [budgetSol, setBudgetSol] = useState("1");
  const [perCoinSol, setPerCoinSol] = useState("0.0092");
  // A per-wallet cap rather than a bond: it defaults to a round figure that covers the largest
  // single per-wallet cost in the game (a launch's rent, 0.00952128 SOL), and a wallet no longer
  // has anything to post before it can play.
  const [perWalletSol, setPerWalletSol] = useState("0.01");

  const owner = wallet?.address ?? null;

  const refresh = useCallback(async () => {
    if (!owner || !programAddress) {
      setState(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setState(await loadSponsorAdminState(address(programAddress), address(owner)));
      setError("");
    } catch {
      setError("Could not read the sponsor vault from chain.");
    } finally {
      setLoading(false);
    }
  }, [programAddress, owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nowSeconds = Math.floor(Date.now() / 1000);
  const activeKind = useMemo(
    () => SPONSOR_KIND_OPTIONS.find((option) => option.kind === kind) ?? SPONSOR_KIND_OPTIONS[0],
    [kind],
  );

  /** Builds the instructions, then either sends them or turns them into a proposal. */
  async function dispatch(
    label: string,
    build: () => Promise<ReturnType<typeof initSponsorVaultInstructions>>,
    mode: "direct" | "proposal",
    done: string,
  ) {
    if (!wallet) {
      setError("Connect the sponsor owner's wallet first.");
      return;
    }
    if (mode === "direct" && !pendingTransaction.canSubmit()) return;
    setBusy(label);
    setError("");
    setNotice("");
    setProposal("");
    try {
      const instructions = await build();
      if (mode === "proposal") {
        const message = await sponsorProposalMessage({
          feePayer: address(wallet.address),
          instructions,
          recentBlockhash: await fetchLatestBlockhash(),
        });
        setProposal(message.messageBase64);
        setNotice("Proposal message ready — copy it into Squads as an imported transaction.");
      } else {
        await submitSponsorInstructions({ wallet, instructions });
        setNotice(done);
        await refresh();
        onChanged?.();
      }
    } catch (failure) {
      if (!pendingTransaction.record(failure, done.replace(/\.$/, "") || "Sponsor action")) {
        setError(failure instanceof Error ? failure.message : "That sponsor action failed.");
      } else setError("");
    } finally {
      setBusy(null);
    }
  }

  async function copyProposal(): Promise<void> {
    try {
      await navigator.clipboard.writeText(proposal);
      setNotice("Copied. Paste it into Squads under Import transaction.");
    } catch {
      setError("Clipboard access was refused — select the message text and copy it by hand.");
    }
  }

  function submitCreateEvent(event: FormEvent): void {
    event.preventDefault();
    void dispatch(
      "create",
      async () => {
        if (!state?.vault) throw new Error("Initialise and fund the sponsor vault first.");
        const nowSecondsNow = Math.floor(Date.now() / 1000);
        const lengthDays = Math.max(1, Number(days) || 1);
        return createSponsorEventInstructions({
          programAddress: address(programAddress),
          sponsorOwner: address(owner!),
          kind,
          startAt: BigInt(nowSecondsNow),
          endAt: BigInt(nowSecondsNow + lengthDays * 86_400),
          budgetLamports: solToLamports(Math.max(0, Number(budgetSol) || 0)),
          perCoinLimitLamports: solToLamports(Math.max(0, Number(perCoinSol) || 0)),
          perWalletLimitLamports: solToLamports(Math.max(0, Number(perWalletSol) || 0)),
          // The event's PDA is keyed on the vault's own event_count, read here immediately before
          // building: an id the caller invented would fail the seeds check on chain.
          eventId: state.vault.eventCount,
        });
      },
      "direct",
      "Event created. Fund the vault if the budget is not covered yet.",
    );
  }

  return (
    <section className="sponsor-panel">
      <div className="section-heading">
        <div>
          <div className="eyebrow"><IconLandmark size={14} /> Sponsorship</div>
          <h2>Sponsor<br />events.</h2>
        </div>
      </div>
      <p className="sponsor-intro">
        A sponsor event pays rent and trading fees for other people. It can never change power,
        rewards, discovery odds, rarity, caps or eligibility, and the vault is your own wallet's —
        not the protocol's and not part of any multisig configuration.
      </p>

      {loading ? (
        <p className="form-message">Reading the sponsor vault from chain…</p>
      ) : !state?.vault ? (
        <div className="sponsor-empty">
          <p>You have no sponsor vault yet. Creating one costs {lamportsToSol(SPONSOR_VAULT_RENT_LAMPORTS).toFixed(6)} SOL of rent, which stays in the account.</p>
          <button
            className="primary-button"
            disabled={busy !== null || !wallet}
            onClick={() =>
              void dispatch(
                "init",
                async () =>
                  initSponsorVaultInstructions({
                    programAddress: address(programAddress),
                    sponsorOwner: address(owner!),
                  }),
                "direct",
                "Sponsor vault created.",
              )
            }
          >
            {busy === "init" ? "Creating…" : "Create sponsor vault"} <IconPlus size={16} />
          </button>
        </div>
      ) : (
        <>
          <dl className="sponsor-vault-stats">
            <div><dt>Funded</dt><dd>{lamportsToSol(state.vault.totalFunded).toFixed(4)} SOL</dd></div>
            <div><dt>Spent</dt><dd>{lamportsToSol(state.vault.totalSpent).toFixed(4)} SOL</dd></div>
            <div><dt>Withdrawn</dt><dd>{lamportsToSol(state.vault.totalWithdrawn).toFixed(4)} SOL</dd></div>
            <div><dt>Withdrawable</dt><dd>{lamportsToSol(state.withdrawableLamports).toFixed(4)} SOL</dd></div>
            <div><dt>Events created</dt><dd>{state.vault.eventCount}</dd></div>
          </dl>

          <div className="sponsor-forms">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void dispatch(
                  "fund",
                  async () =>
                    fundSponsorVaultInstructions({
                      programAddress: address(programAddress),
                      sponsorOwner: address(owner!),
                      amountLamports: solToLamports(Math.max(0, Number(fundAmount) || 0)),
                    }),
                  "direct",
                  "Vault funded.",
                );
              }}
            >
              <label>Fund the vault (SOL)
                <input type="number" min="0" step="0.01" value={fundAmount} onChange={(event) => setFundAmount(event.target.value)} />
              </label>
              <button className="outline-button" disabled={busy !== null}>
                <IconBalance size={15} /> {busy === "fund" ? "Funding…" : "Fund"}
              </button>
            </form>

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void dispatch(
                  "withdraw",
                  async () =>
                    withdrawSponsorVaultInstructions({
                      programAddress: address(programAddress),
                      sponsorOwner: address(owner!),
                      amountLamports: solToLamports(
                        Math.min(Number(withdrawAmount) || 0, lamportsToSol(state.withdrawableLamports)),
                      ),
                    }),
                  "direct",
                  "Withdrawn. Unspent lamports were never the protocol's.",
                );
              }}
            >
              <label>Withdraw unspent (SOL)
                <input type="number" min="0" step="0.01" value={withdrawAmount} placeholder={lamportsToSol(state.withdrawableLamports).toFixed(4)} onChange={(event) => setWithdrawAmount(event.target.value)} />
              </label>
              <button className="outline-button" disabled={busy !== null || state.withdrawableLamports === 0n}>
                {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
              </button>
            </form>
          </div>

          <form className="sponsor-event-form" onSubmit={submitCreateEvent}>
            <h3>New event</h3>
            <label>Kind
              <select value={kind} onChange={(event) => setKind(Number(event.target.value))}>
                {SPONSOR_KIND_OPTIONS.map((option) => (
                  <option key={option.kind} value={option.kind}>{option.label}</option>
                ))}
              </select>
            </label>
            <p className="sponsor-kind-detail">{activeKind.detail}</p>
            <div className="form-grid">
              <label>Days<input type="number" min="1" step="1" value={days} onChange={(event) => setDays(event.target.value)} /></label>
              <label>Budget (SOL)<input type="number" min="0" step="0.01" value={budgetSol} onChange={(event) => setBudgetSol(event.target.value)} /></label>
              <label>Per coin limit (SOL)<input type="number" min="0" step="0.0001" value={perCoinSol} onChange={(event) => setPerCoinSol(event.target.value)} /></label>
              <label>Per wallet limit (SOL)<input type="number" min="0" step="0.01" value={perWalletSol} onChange={(event) => setPerWalletSol(event.target.value)} /></label>
            </div>
            <p className="onboarding-fine">
              Creating the event costs {lamportsToSol(SPONSOR_EVENT_RENT_LAMPORTS).toFixed(6)} SOL of rent, paid by you.
              The limits are checked before every spend and a grant is created at most once per subject.
            </p>
            <div className="sponsor-event-actions">
              <button className="primary-button" disabled={busy !== null}>
                {busy === "create" ? "Creating…" : "Create event"}
              </button>
              <button
                type="button"
                className="outline-button"
                disabled={busy !== null}
                onClick={() =>
                  void dispatch(
                    "create",
                    async () => {
                      if (!state?.vault) throw new Error("Initialise the sponsor vault first.");
                      const now = Math.floor(Date.now() / 1000);
                      const lengthDays = Math.max(1, Number(days) || 1);
                      return createSponsorEventInstructions({
                        programAddress: address(programAddress),
                        sponsorOwner: address(owner!),
                        kind,
                        startAt: BigInt(now),
                        endAt: BigInt(now + lengthDays * 86_400),
                        budgetLamports: solToLamports(Math.max(0, Number(budgetSol) || 0)),
                        perCoinLimitLamports: solToLamports(Math.max(0, Number(perCoinSol) || 0)),
                        perWalletLimitLamports: solToLamports(Math.max(0, Number(perWalletSol) || 0)),
                        eventId: state.vault.eventCount,
                      });
                    },
                    "proposal",
                    "",
                  )
                }
              >
                Build Squads proposal
              </button>
            </div>
          </form>

          {proposal && (
            <div className="sponsor-proposal">
              <p>Unsigned message, ready to import into Squads:</p>
              <textarea readOnly value={proposal} rows={4} />
              <button className="outline-button" type="button" onClick={() => void copyProposal()}>
                Copy message
              </button>
            </div>
          )}

          <div className="sponsor-events">
            <h3>Events</h3>
            {state.events.length === 0 && <p className="onboarding-fine">No events yet.</p>}
            {state.events.map(({ eventId, event }) => {
              const remaining = sponsorEventRemaining(event);
              const active = sponsorEventActive(event, nowSeconds);
              return (
                <article className="sponsor-event-row" key={eventId}>
                  <header>
                    <strong>#{eventId} · {sponsorKindLabel(event.kind)}</strong>
                    <span className={"badge " + (active ? "badge-curve" : "badge-reserve")}>
                      <i aria-hidden="true" /> {active ? "Active" : event.paused ? "Paused" : remaining === 0n ? "Budget spent" : "Scheduled or ended"}
                    </span>
                  </header>
                  <div className="sponsor-budget">
                    <div className="sponsor-budget-bar">
                      <i style={{ width: budgetUsedPercent(event.spentLamports, event.budgetLamports) + "%" }} />
                    </div>
                    <span>
                      {lamportsToSol(event.spentLamports).toFixed(4)} of {lamportsToSol(event.budgetLamports).toFixed(4)} SOL spent
                      {" · "}per coin {lamportsToSol(event.perCoinLimitLamports).toFixed(4)}
                      {" · "}per wallet {lamportsToSol(event.perWalletLimitLamports).toFixed(4)}
                    </span>
                  </div>
                  <button
                    className="outline-button"
                    disabled={busy !== null}
                    onClick={() =>
                      void dispatch(
                        "close",
                        async () =>
                          closeSponsorEventInstructions({
                            programAddress: address(programAddress),
                            sponsorOwner: address(owner!),
                            eventId,
                          }),
                        "direct",
                        "Event closed. Its unspent budget is withdrawable now.",
                      )
                    }
                  >
                    <IconClose size={14} /> {busy === "close" ? "Closing…" : "Close event"}
                  </button>
                </article>
              );
            })}
          </div>
        </>
      )}

      {notice && <p className="form-message onboarding-ok">{notice}</p>}
      {error && <p className="form-message onboarding-error">{error}</p>}
    </section>
  );
}
