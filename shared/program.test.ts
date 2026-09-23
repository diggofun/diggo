/**
 * Account-list tests for every instruction that walks a mine's on-chain ledger.
 *
 * The bug these cover: `buildAssignPowerInstruction` and `buildRemovePowerInstruction` appended
 * the market account only when the caller happened to pass one, so a client that held nothing
 * but the mint built an `assign_power` the program refused with `SyncBehind`. While a market is
 * still on its curve the only tokens that may pay a block are the curve's own inventory, and the
 * market account is the only place that ledger lives. The builders now take the mint as a
 * required parameter and append the market unconditionally, so there is no longer any way to
 * build a pre-graduation sync that cannot settle.
 *
 * Every expected list below is transcribed from the `#[derive(Accounts)]` structs in
 * programs/diggo-protocol/src/lib.rs, in declaration order:
 *   AssignPower   lib.rs:1541 — assign_power (lib.rs:914) and remove_power (lib.rs:961), which
 *                               share one `Context<AssignPower>`
 *   AdvanceMine   lib.rs:1569
 *   ClaimRewards  lib.rs:1579
 *   SyncCrewPower lib.rs:1613
 * @solana/kit's AccountRole is bit-flagged: bit0 = writable, bit1 = signer.
 */
import { describe, expect, it } from "vitest";
import { address, getBase58Decoder, type Address, type Instruction } from "@solana/kit";
import {
  ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
  buildAdvanceMineInstruction,
  buildAssignPowerInstruction,
  buildClaimRewardsInstruction,
  buildRemovePowerInstruction,
  buildSyncCrewPowerInstruction,
  deriveMarketPda,
  deriveMarketPdaSync,
  deriveMarketVaultPda,
  deriveProtocolPdaSync,
} from "./program";

/** A real, decodable 32-byte address; the fixed strings used elsewhere are not valid base58. */
const pk = (byte: number): Address => address(getBase58Decoder().decode(new Uint8Array(32).fill(byte)));

const PROGRAM = pk(1);
const MINT = pk(2);
const OWNER = pk(3);
const PLAYER = pk(4);
const MINE = pk(5);
const POSITION = pk(6);
const KEEPER = pk(7);
const RESERVE_VAULT = pk(8);
const OWNER_TOKENS = pk(9);

const ASSIGN_POWER = [91, 85, 179, 221, 48, 238, 125, 89];
const REMOVE_POWER = [156, 78, 134, 240, 166, 100, 199, 228];

interface ExpectedAccount {
  address: Address;
  writable: boolean;
  signer: boolean;
}

const w = (a: Address): ExpectedAccount => ({ address: a, writable: true, signer: false });
const r = (a: Address): ExpectedAccount => ({ address: a, writable: false, signer: false });
const ws = (a: Address): ExpectedAccount => ({ address: a, writable: true, signer: true });
const rs = (a: Address): ExpectedAccount => ({ address: a, writable: false, signer: true });

function accountsOf(ix: Instruction): ExpectedAccount[] {
  return (ix.accounts ?? []).map((account) => ({
    address: account.address,
    writable: (account.role & 1) !== 0,
    signer: (account.role & 2) !== 0,
  }));
}

describe("assign_power and remove_power always carry the market", () => {
  it("appends the market to a curve-phase assign built from the mint alone", async () => {
    const ix = buildAssignPowerInstruction({
      programAddress: PROGRAM,
      owner: OWNER,
      player: PLAYER,
      mine: MINE,
      position: POSITION,
      mint: MINT,
    });
    expect(Array.from(ix.data ?? [])).toEqual(ASSIGN_POWER);
    // Exactly AssignPower in lib.rs: owner, player, mine, position, system_program, market.
    expect(accountsOf(ix)).toEqual([
      ws(OWNER),
      w(PLAYER),
      w(MINE),
      w(POSITION),
      r(SYSTEM_PROGRAM_ADDRESS),
      w(await deriveMarketPda(PROGRAM, MINT)),
    ]);
  });

  it("keeps the market in the same slot when a caller passes it explicitly", async () => {
    const market = deriveMarketPdaSync(PROGRAM, MINT);
    // The synchronous helper the builder derives with has to agree with the awaited one.
    expect(market).toBe(await deriveMarketPda(PROGRAM, MINT));
    const ix = buildAssignPowerInstruction({
      programAddress: PROGRAM,
      owner: OWNER,
      player: PLAYER,
      mine: MINE,
      position: POSITION,
      mint: MINT,
      market,
    });
    expect(accountsOf(ix)).toEqual([
      ws(OWNER),
      w(PLAYER),
      w(MINE),
      w(POSITION),
      r(SYSTEM_PROGRAM_ADDRESS),
      w(market),
    ]);
  });

  it("does the same for remove_power, which shares Context<AssignPower>", async () => {
    const ix = buildRemovePowerInstruction({
      programAddress: PROGRAM,
      owner: OWNER,
      player: PLAYER,
      mine: MINE,
      position: POSITION,
      mint: MINT,
    });
    expect(Array.from(ix.data ?? [])).toEqual(REMOVE_POWER);
    expect(accountsOf(ix)).toEqual([
      ws(OWNER),
      w(PLAYER),
      w(MINE),
      w(POSITION),
      r(SYSTEM_PROGRAM_ADDRESS),
      w(await deriveMarketPda(PROGRAM, MINT)),
    ]);
  });
});

describe("the other instructions that sync a mine", () => {
  it("matches ClaimRewards in lib.rs:1579, market included", async () => {
    const ix = buildClaimRewardsInstruction({
      programAddress: PROGRAM,
      owner: OWNER,
      mine: MINE,
      mint: MINT,
      reserveVault: RESERVE_VAULT,
      ownerTokens: OWNER_TOKENS,
      position: POSITION,
    });
    expect(accountsOf(ix)).toEqual([
      ws(OWNER),
      r(deriveProtocolPdaSync(PROGRAM)),
      w(MINE),
      r(MINT),
      w(RESERVE_VAULT),
      w(await deriveMarketPda(PROGRAM, MINT)),
      w(await deriveMarketVaultPda(PROGRAM, MINT)),
      w(OWNER_TOKENS),
      w(POSITION),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ]);
  });

  it("matches SyncCrewPower in lib.rs:1613, market included", async () => {
    const ix = buildSyncCrewPowerInstruction({
      programAddress: PROGRAM,
      keeper: KEEPER,
      protocol: deriveProtocolPdaSync(PROGRAM),
      owner: OWNER,
      player: PLAYER,
      mine: MINE,
      mint: MINT,
      position: POSITION,
      newPower: 1_000n,
    });
    expect(accountsOf(ix)).toEqual([
      rs(KEEPER),
      r(deriveProtocolPdaSync(PROGRAM)),
      r(OWNER),
      w(PLAYER),
      w(MINE),
      r(MINT),
      w(await deriveMarketPda(PROGRAM, MINT)),
      w(POSITION),
    ]);
  });

  it("matches AdvanceMine in lib.rs:1569, where the market is not optional", async () => {
    const market = await deriveMarketPda(PROGRAM, MINT);
    expect(
      accountsOf(buildAdvanceMineInstruction({ programAddress: PROGRAM, mine: MINE, mint: MINT })),
    ).toEqual([w(MINE), w(market)]);
    expect(
      accountsOf(buildAdvanceMineInstruction({ programAddress: PROGRAM, mine: MINE, market })),
    ).toEqual([w(MINE), w(market)]);
    // A caller with neither cannot silently build a walk that reads no ledger.
    expect(() => buildAdvanceMineInstruction({ programAddress: PROGRAM, mine: MINE })).toThrow(
      /market or its mint/,
    );
  });
});
