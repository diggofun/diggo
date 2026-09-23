/**
 * Sponsor vaults and events: the one mechanism that moves cost off a creator, and the only admin
 * surface that is not governance.
 *
 * Three things are true of everything here and they are the reason it is a separate module:
 *
 * 1. A sponsorship event can pay rent and fees and nothing else. It cannot change power, rewards,
 *    discovery odds, rarity, caps or eligibility, and WS-G pins that with an invariance test.
 * 2. The vault belongs to the owner's own wallet. It is not part of the Squads configuration and
 *    can never be a program upgrade or config authority.
 * 3. Withdrawal belongs to the owner alone and is capped at `total_funded - total_spent`.
 *    Unspent lamports are never the protocol's.
 *
 * One kind is gone with the bond: `playerBondSubsidy`, which posted a player's deposit, is not in
 * the list below because there is no deposit left to post. The remaining kinds pay rent, which is
 * the only cost a sponsor can still move.
 *
 * The multisig path matters for one case only: on a devnet deploy where the vault owner is a
 * single hot key, a transaction can be signed and sent directly. Anywhere else the same
 * instructions are handed to Squads as an importable message, which is why
 * `createSponsorEventInstructions` is separated from `submitSponsorInstructions`.
 */
import { PublicKey, Transaction, TransactionInstruction, type Message } from "@solana/web3.js";
import { AccountRole, type Address, type Instruction } from "@solana/kit";
import {
  ACCOUNT_RENT_LAMPORTS,
  LAUNCH_RENT_LAMPORTS,
  SPONSOR_EVENT_KIND,
  buildCloseSponsorEventInstruction,
  buildCreateSponsorEventInstruction,
  buildFundSponsorVaultInstruction,
  buildInitSponsorVaultInstruction,
  buildWithdrawSponsorVaultInstruction,
  decodeSponsorVault,
  sponsorEventKindName,
  type DecodedSponsorEvent,
  type DecodedSponsorVault,
} from "../../shared/program";
import { deriveSponsorVaultPda } from "../../shared/pdas";
import { fetchAndDecode, fetchSponsorEvents } from "./rpc";
import { signSendConfirm, type DiggoWallet } from "./tx";

/** The sponsor owner's whole view: the vault, and every event it has created. */
export interface SponsorAdminState {
  vault: (DecodedSponsorVault & { address: Address }) | null;
  events: { eventId: number; address: Address; event: DecodedSponsorEvent }[];
  /** `total_funded - total_spent`, which is the most the owner may withdraw. */
  withdrawableLamports: bigint;
  /** The id the next `create_sponsor_event` will be created under. */
  nextEventId: number;
}

export async function loadSponsorAdminState(
  programAddress: Address,
  sponsorOwner: Address,
): Promise<SponsorAdminState> {
  const address = await deriveSponsorVaultPda(programAddress, sponsorOwner);
  const vault = await fetchAndDecode(address, decodeSponsorVault);
  if (!vault) {
    return { vault: null, events: [], withdrawableLamports: 0n, nextEventId: 0 };
  }
  const events = await fetchSponsorEvents(programAddress, address, vault.eventCount);
  const unspent = vault.totalFunded - vault.totalSpent;
  return {
    vault: { ...vault, address },
    events,
    withdrawableLamports: unspent > 0n ? unspent : 0n,
    nextEventId: vault.eventCount,
  };
}

/** The vault's own rent, which a withdrawal may never take it below. */
export const SPONSOR_VAULT_RENT_LAMPORTS = ACCOUNT_RENT_LAMPORTS.sponsorVault;

// --- the four owner-signed instructions ----------------------------------------------------

export function initSponsorVaultInstructions(params: {
  programAddress: Address;
  sponsorOwner: Address;
}): Instruction[] {
  return [
    buildInitSponsorVaultInstruction({
      programAddress: params.programAddress,
      sponsorOwner: params.sponsorOwner,
    }),
  ];
}

export function fundSponsorVaultInstructions(params: {
  programAddress: Address;
  sponsorOwner: Address;
  amountLamports: bigint;
}): Instruction[] {
  return [
    buildFundSponsorVaultInstruction({
      programAddress: params.programAddress,
      sponsorOwner: params.sponsorOwner,
      amount: params.amountLamports,
    }),
  ];
}

export function withdrawSponsorVaultInstructions(params: {
  programAddress: Address;
  sponsorOwner: Address;
  amountLamports: bigint;
}): Instruction[] {
  return [
    buildWithdrawSponsorVaultInstruction({
      programAddress: params.programAddress,
      sponsorOwner: params.sponsorOwner,
      amount: params.amountLamports,
    }),
  ];
}

/**
 * The event's PDA is keyed on `vault.event_count`, which the program reads before it creates
 * anything, so `eventId` has to be the value read from the vault rather than an index the caller
 * invents. A caller that has not read the vault gets a clear refusal instead of a transaction
 * that fails its seeds check.
 */
export async function createSponsorEventInstructions(params: {
  programAddress: Address;
  sponsorOwner: Address;
  kind: number;
  startAt: bigint;
  endAt: bigint;
  budgetLamports: bigint;
  perCoinLimitLamports: bigint;
  perWalletLimitLamports: bigint;
  /** The vault's `event_count`, read immediately before this call. */
  eventId: number;
}): Promise<Instruction[]> {
  if (!Number.isInteger(params.eventId) || params.eventId < 0) {
    throw new Error("Read the sponsor vault first: the event id is its event_count.");
  }
  return [
    buildCreateSponsorEventInstruction({
      programAddress: params.programAddress,
      sponsorOwner: params.sponsorOwner,
      kind: params.kind,
      startAt: params.startAt,
      endAt: params.endAt,
      budgetLamports: params.budgetLamports,
      perCoinLimitLamports: params.perCoinLimitLamports,
      perWalletLimitLamports: params.perWalletLimitLamports,
      eventId: params.eventId,
    }),
  ];
}

export async function closeSponsorEventInstructions(params: {
  programAddress: Address;
  sponsorOwner: Address;
  eventId: number;
}): Promise<Instruction[]> {
  return [
    buildCloseSponsorEventInstruction({
      programAddress: params.programAddress,
      sponsorOwner: params.sponsorOwner,
      eventId: params.eventId,
    }),
  ];
}

// --- submission: direct on devnet, or an importable message for Squads ---------------------

/**
 * Signs and sends directly with the owner's wallet. This is the devnet path the brief names: the
 * vault owner is a hot key there, so there is nothing for a multisig to approve.
 */
export async function submitSponsorInstructions(params: {
  wallet: DiggoWallet;
  instructions: Instruction[];
}): Promise<string> {
  return signSendConfirm(params.wallet, params.instructions);
}

/** @solana/kit's AccountRole is bit-flagged: bit0 writable, bit1 signer. */
function toWeb3Instruction(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: (ix.accounts ?? []).map((account) => ({
      pubkey: new PublicKey(account.address),
      isSigner: (account.role & AccountRole.READONLY_SIGNER) !== 0,
      isWritable: (account.role & AccountRole.WRITABLE) !== 0,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

/**
 * The same instructions as a base64 legacy message, which is the form Squads v4's "import
 * transaction" accepts.
 *
 * The message carries the fee payer and a recent blockhash and no signatures at all: the
 * multisig members add those, and a proposal whose instructions were built anywhere else would
 * have to be re-derived by hand. Nothing here is signed, so this cannot move a lamport on its
 * own.
 */
export function toImportableMessage(params: {
  feePayer: Address;
  recentBlockhash: string;
  instructions: Instruction[];
}): string {
  const transaction = new Transaction();
  transaction.feePayer = new PublicKey(params.feePayer);
  transaction.recentBlockhash = params.recentBlockhash;
  for (const ix of params.instructions) transaction.add(toWeb3Instruction(ix));
  const message: Message = transaction.compileMessage();
  return message.serialize().toString("base64");
}

/**
 * The message for one sponsor action, ready to paste into a Squads proposal. It fetches the
 * blockhash itself so the caller only has to name the action.
 */
export async function sponsorProposalMessage(params: {
  feePayer: Address;
  instructions: Instruction[];
  recentBlockhash: string;
}): Promise<{ messageBase64: string; accountCount: number }> {
  return {
    messageBase64: toImportableMessage(params),
    accountCount: params.instructions.reduce((sum, ix) => sum + (ix.accounts?.length ?? 0), 0),
  };
}

/** The kinds with the copy the admin screen shows for each. */
export const SPONSOR_KIND_OPTIONS = [
  {
    kind: SPONSOR_EVENT_KIND.launchRentSubsidy,
    label: "Launch rent subsidy",
    detail: "Pays the mint, Coin and vault rent at launch, within the per-coin limit.",
    defaultPerSubjectLamports: LAUNCH_RENT_LAMPORTS,
  },
  {
    kind: SPONSOR_EVENT_KIND.platformTradeFeeWaiver,
    label: "Platform trade fee waiver",
    detail: "Pays the platform share of the trading fee, so the trader pays the creator's share only.",
    defaultPerSubjectLamports: 0n,
  },
  {
    kind: SPONSOR_EVENT_KIND.playerAccountSubsidy,
    label: "Player account subsidy",
    detail: "Pays a new player's PlayerAccount rent, within the per-wallet limit.",
    defaultPerSubjectLamports: ACCOUNT_RENT_LAMPORTS.playerAccount,
  },
] as const;

/** The label for a kind byte, for a row that was decoded without a name. */
export function sponsorKindLabel(kind: number): string {
  return sponsorEventKindName(kind) ?? SPONSOR_KIND_OPTIONS[0].label;
}

/** The event's own rent, which the vault pays when it creates one. */
export const SPONSOR_EVENT_RENT_LAMPORTS = ACCOUNT_RENT_LAMPORTS.sponsorEvent;
