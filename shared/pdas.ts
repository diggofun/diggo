/**
 * PDA derivations for the diggo_protocol on-chain v2 program.
 *
 * Every seed list here is transcribed from programs/diggo-protocol/src/seeds.rs, which is the
 * frozen contract (programs/diggo-protocol/CONTRACTS.md, "Accounts"). The seed order and the
 * endianness of every integer seed are part of that contract: a client that seeds a different
 * byte order derives a different, non-existent account, and the transaction fails with
 * AccountNotInitialized rather than with anything legible.
 *
 * Two families of helpers exist for every PDA. The async one uses @solana/kit's
 * getProgramDerivedAddress, which is what a transaction path should await once and cache; the
 * Sync one is the same search done locally with @noble, so a synchronous builder can derive the
 * accounts it needs without turning every call site into an async function. They must agree, and
 * shared/program.test.ts pins that they do.
 *
 * The v2 account set is small on purpose (design 1.3): one coin is a mint, a Coin and one token
 * vault, and the four v4 vaults, the separate market account and the discovery receipt are gone.
 * A wallet's ORE, bond and discovery budget live inside its PlayerAccount rather than in PDAs of
 * their own, so there is nothing here for them.
 */
import {
  type Address,
  type ReadonlyUint8Array,
  address,
  getAddressEncoder,
  getProgramDerivedAddress,
  getU16Encoder,
  getU32Encoder,
  getU8Encoder,
} from "@solana/kit";
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

/** The Token-2022 program: every v2 coin mint and token account is owned by it (design 1.3(c)). */
export const TOKEN_2022_PROGRAM_ADDRESS = address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

/** The associated-token program every associated token account lives under. */
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** The upgradeable loader, whose program-data account holds a program's upgrade authority. */
export const BPF_LOADER_UPGRADEABLE_ADDRESS = address("BPFLoaderUpgradeab1e11111111111111111111111");

/**
 * Seed prefixes, mirroring seeds.rs. The values are the bytes, not the Rust identifiers: the
 * program hashes these strings, so "sponsor-vault" is the seed and SPONSOR_VAULT_SEED is only
 * its Rust name.
 */
export const PROGRAM_SEEDS = {
  protocol: "protocol",
  treasury: "treasury",
  crankPool: "crank-pool",
  curveTable: "curve-table",
  coin: "coin",
  vault: "vault",
  player: "player",
  position: "position",
  opportunity: "opportunity",
  globalBudget: "global-budget",
  sponsorVault: "sponsor-vault",
  sponsorEvent: "sponsor-event",
  sponsorGrant: "sponsor-grant",
  mint: "mint",
  pool: "pool",
  poolTokenVault: "pool-vault",
  poolSolVault: "pool-sol",
  referralCredit: "referral",
  referralWeek: "referral_week",
} as const;

export type ProgramSeedName = keyof typeof PROGRAM_SEEDS;

// --- seed helpers --------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** Either a mutable or a read-only byte string: the kit encoders return the read-only kind. */
type Bytes = Uint8Array | ReadonlyUint8Array;

/** A seed that is a literal string, e.g. b"protocol". */
export function seedConstant(value: ProgramSeedName): Bytes {
  return utf8.encode(PROGRAM_SEEDS[value]);
}

/** A seed that is an account address, e.g. the coin's mint. */
export function seedAddress(value: Address): Bytes {
  return getAddressEncoder().encode(value);
}

/** The u8 seed launch_token uses for the mint nonce. */
export function seedU8(value: number): Bytes {
  return getU8Encoder().encode(value);
}

/** A u16 seed, little-endian: the discovery window and the global-budget day index. */
export function seedU16(value: number): Bytes {
  return getU16Encoder().encode(value);
}

/** A u32 seed, little-endian: the sponsor event id. */
export function seedU32(value: number): Bytes {
  return getU32Encoder().encode(value);
}

// --- the synchronous search -----------------------------------------------------------------

const PDA_MARKER = utf8.encode("ProgramDerivedAddress");

function isOnCurveAddress(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Base58 (Bitcoin alphabet) of a raw byte string, without a Buffer dependency. */
export function base58FromBytes(bytes: Uint8Array): string {
  // Each leading zero byte is its own "1" and contributes nothing to the number, so they are
  // counted first and the conversion runs on the rest. Without that split an all-zero 32-byte
  // address (the default pubkey, which every unset Option<Pubkey> holds) would gain an extra "1".
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) leadingZeros++;
  if (leadingZeros === bytes.length) return BASE58_ALPHABET[0].repeat(bytes.length);
  const digits = [0];
  for (let i = leadingZeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let d = 0; d < digits.length; d++) {
      carry += digits[d] << 8;
      digits[d] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  return BASE58_ALPHABET[0].repeat(leadingZeros) + digits.reverse().map((d) => BASE58_ALPHABET[d]).join("");
}

function concatBytes(...parts: Bytes[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * The on-curve-and-hash search Anchor's bump constraint performs, done locally so a synchronous
 * instruction builder can derive an account. It is the same answer the async helpers return; a
 * mismatch between them would mean one of the two is wrong, never that both are acceptable.
 */
export function findProgramAddressSync(seeds: readonly Bytes[], programAddress: Address): Address {
  const programBytes = seedAddress(programAddress);
  for (let bump = 255; bump >= 0; bump--) {
    const digest = sha256(concatBytes(...seeds, Uint8Array.of(bump), programBytes, PDA_MARKER));
    if (!isOnCurveAddress(digest)) return address(base58FromBytes(digest));
  }
  throw new Error("Unable to find a viable program address bump");
}

// --- protocol, treasury and the crank pool ---------------------------------------------------

/** The one ProtocolConfig PDA: seeds [b"protocol"]. */
export async function deriveProtocolPda(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("protocol")] });
  return pda;
}

export function deriveProtocolPdaSync(programAddress: Address): Address {
  return findProgramAddressSync([seedConstant("protocol")], programAddress);
}

/** The fixed platform-fee destination: seeds [b"treasury"]. */
export async function deriveTreasuryPda(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("treasury")] });
  return pda;
}

export function deriveTreasuryPdaSync(programAddress: Address): Address {
  return findProgramAddressSync([seedConstant("treasury")], programAddress);
}

/** The fixed crank-tip destination: seeds [b"crank-pool"]. */
export async function deriveCrankPoolPda(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("crankPool")] });
  return pda;
}

export function deriveCrankPoolPdaSync(programAddress: Address): Address {
  return findProgramAddressSync([seedConstant("crankPool")], programAddress);
}

/**
 * The optional timelocked curve-table override: seeds [b"curve-table"]. It exists only once
 * governance has written one; while it is absent every instruction uses the compiled-in tables
 * in math/power.rs, so a caller may leave the account out entirely.
 */
export async function deriveCurveTablePda(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("curveTable")] });
  return pda;
}

export function deriveCurveTablePdaSync(programAddress: Address): Address {
  return findProgramAddressSync([seedConstant("curveTable")], programAddress);
}

// --- a coin: the mint, its Coin account and its one vault -------------------------------------

/**
 * The launch mint: seeds [b"mint", creator, nonce u8]. The mint is the coin's identity - the Coin
 * and the vault are derived from it - and launch_token takes the nonce as an argument so a
 * creator may launch repeatedly, each nonce giving a fresh mint.
 */
export async function deriveMintPda(programAddress: Address, creator: Address, nonce: number): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("mint"), seedAddress(creator), seedU8(nonce)],
  });
  return pda;
}

export function deriveMintPdaSync(programAddress: Address, creator: Address, nonce: number): Address {
  return findProgramAddressSync([seedConstant("mint"), seedAddress(creator), seedU8(nonce)], programAddress);
}

/** The Coin account, the whole reward ledger: seeds [b"coin", mint]. */
export async function deriveCoinPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("coin"), seedAddress(mint)] });
  return pda;
}

export function deriveCoinPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync([seedConstant("coin"), seedAddress(mint)], programAddress);
}

/** The coin's single token vault: seeds [b"vault", mint], authority = the Coin PDA. */
export async function deriveCoinVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("vault"), seedAddress(mint)] });
  return pda;
}

export function deriveCoinVaultPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync([seedConstant("vault"), seedAddress(mint)], programAddress);
}

export interface CoinAddresses {
  mint: Address;
  coin: Address;
  vault: Address;
}

/** Everything a coin is, in one await, for the builders that need all three. */
export async function deriveCoinAddresses(programAddress: Address, mint: Address): Promise<CoinAddresses> {
  const [coin, vault] = await Promise.all([
    deriveCoinPda(programAddress, mint),
    deriveCoinVaultPda(programAddress, mint),
  ]);
  return { mint, coin, vault };
}

// --- the player, its position and its discovery PDAs -----------------------------------------

/** One PDA per wallet: seeds [b"player", owner]. The owner is the seed and is not stored. */
export async function derivePlayerPda(programAddress: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("player"), seedAddress(owner)] });
  return pda;
}

export function derivePlayerPdaSync(programAddress: Address, owner: Address): Address {
  return findProgramAddressSync([seedConstant("player"), seedAddress(owner)], programAddress);
}

/** One PDA per (coin, owner): seeds [b"position", coin, owner]. Neither is stored. */
export async function derivePositionPda(
  programAddress: Address,
  coin: Address,
  owner: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("position"), seedAddress(coin), seedAddress(owner)],
  });
  return pda;
}

export function derivePositionPdaSync(programAddress: Address, coin: Address, owner: Address): Address {
  return findProgramAddressSync([seedConstant("position"), seedAddress(coin), seedAddress(owner)], programAddress);
}

/**
 * One PDA per (coin, owner, window): seeds [b"opportunity", coin, owner, window_index u16 le].
 *
 * The window index is the PlayerAccount's roll_window at the moment of the roll, so a reroll is
 * impossible by construction: the second attempt derives the account that already exists and the
 * program's init constraint refuses it.
 */
export async function deriveOpportunityPda(
  programAddress: Address,
  coin: Address,
  owner: Address,
  windowIndex: number,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("opportunity"), seedAddress(coin), seedAddress(owner), seedU16(windowIndex)],
  });
  return pda;
}

export function deriveOpportunityPdaSync(
  programAddress: Address,
  coin: Address,
  owner: Address,
  windowIndex: number,
): Address {
  return findProgramAddressSync(
    [seedConstant("opportunity"), seedAddress(coin), seedAddress(owner), seedU16(windowIndex)],
    programAddress,
  );
}

/** The protocol-wide daily discovery budget: seeds [b"global-budget", day_index u16 le]. */
export async function deriveGlobalBudgetPda(programAddress: Address, dayIndex: number): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("globalBudget"), seedU16(dayIndex)],
  });
  return pda;
}

export function deriveGlobalBudgetPdaSync(programAddress: Address, dayIndex: number): Address {
  return findProgramAddressSync([seedConstant("globalBudget"), seedU16(dayIndex)], programAddress);
}

// --- sponsorship ------------------------------------------------------------------------------

/** One PDA per sponsor wallet: seeds [b"sponsor-vault", sponsor_owner]. Lamports only. */
export async function deriveSponsorVaultPda(programAddress: Address, sponsorOwner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("sponsorVault"), seedAddress(sponsorOwner)],
  });
  return pda;
}

export function deriveSponsorVaultPdaSync(programAddress: Address, sponsorOwner: Address): Address {
  return findProgramAddressSync([seedConstant("sponsorVault"), seedAddress(sponsorOwner)], programAddress);
}

/**
 * One PDA per (vault, event id): seeds [b"sponsor-event", sponsor_vault, event_id u32 le].
 *
 * The id is the vault's event_count at creation, which create_sponsor_event increments, so an
 * event PDA is derived from state the vault itself holds: a caller reads the vault, derives the
 * next id and passes it as the argument the instruction takes.
 */
export async function deriveSponsorEventPda(
  programAddress: Address,
  sponsorVault: Address,
  eventId: number,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("sponsorEvent"), seedAddress(sponsorVault), seedU32(eventId)],
  });
  return pda;
}

export function deriveSponsorEventPdaSync(
  programAddress: Address,
  sponsorVault: Address,
  eventId: number,
): Address {
  return findProgramAddressSync(
    [seedConstant("sponsorEvent"), seedAddress(sponsorVault), seedU32(eventId)],
    programAddress,
  );
}

/**
 * One PDA per (event, subject): seeds [b"sponsor-grant", sponsor_event, subject].
 *
 * The subject is the coin for a launch-rent or trade-fee-waiver event and the player's wallet for
 * an account or bond subsidy, which is what lets one grant shape enforce both the per-coin and
 * the per-wallet limit.
 */
export async function deriveSponsorGrantPda(
  programAddress: Address,
  sponsorEvent: Address,
  subject: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("sponsorGrant"), seedAddress(sponsorEvent), seedAddress(subject)],
  });
  return pda;
}

export function deriveSponsorGrantPdaSync(
  programAddress: Address,
  sponsorEvent: Address,
  subject: Address,
): Address {
  return findProgramAddressSync(
    [seedConstant("sponsorGrant"), seedAddress(sponsorEvent), seedAddress(subject)],
    programAddress,
  );
}

export async function deriveReferralCreditPda(
  programAddress: Address,
  referrer: Address,
  referee: Address,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("referralCredit"), seedAddress(referrer), seedAddress(referee)],
  });
  return pda;
}

export function deriveReferralCreditPdaSync(
  programAddress: Address,
  referrer: Address,
  referee: Address,
): Address {
  return findProgramAddressSync(
    [seedConstant("referralCredit"), seedAddress(referrer), seedAddress(referee)],
    programAddress,
  );
}

export async function deriveReferralWeekPda(programAddress: Address, referrer: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("referralWeek"), seedAddress(referrer)],
  });
  return pda;
}

export function deriveReferralWeekPdaSync(programAddress: Address, referrer: Address): Address {
  return findProgramAddressSync([seedConstant("referralWeek"), seedAddress(referrer)], programAddress);
}

// --- the post-graduation pool ------------------------------------------------------------------

/** The locked liquidity pool: seeds [b"pool", mint]. */
export async function derivePoolPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [seedConstant("pool"), seedAddress(mint)] });
  return pda;
}

export function derivePoolPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync([seedConstant("pool"), seedAddress(mint)], programAddress);
}

/** The pool's token vault: seeds [b"pool-vault", mint], authority = the pool PDA. */
export async function derivePoolTokenVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("poolTokenVault"), seedAddress(mint)],
  });
  return pda;
}

export function derivePoolTokenVaultPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync([seedConstant("poolTokenVault"), seedAddress(mint)], programAddress);
}

/**
 * The pool's SOL vault: seeds [b"pool-sol", mint]. It is a program-owned PDA holding lamports
 * only, so it has no token account and no authority of its own.
 */
export async function derivePoolSolVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [seedConstant("poolSolVault"), seedAddress(mint)],
  });
  return pda;
}

export function derivePoolSolVaultPdaSync(programAddress: Address, mint: Address): Address {
  return findProgramAddressSync([seedConstant("poolSolVault"), seedAddress(mint)], programAddress);
}

export interface PoolAddresses {
  mint: Address;
  pool: Address;
  poolTokenVault: Address;
  poolSolVault: Address;
}

/** Everything the pool is, in one await. */
export async function derivePoolAddresses(programAddress: Address, mint: Address): Promise<PoolAddresses> {
  const [pool, poolTokenVault, poolSolVault] = await Promise.all([
    derivePoolPda(programAddress, mint),
    derivePoolTokenVaultPda(programAddress, mint),
    derivePoolSolVaultPda(programAddress, mint),
  ]);
  return { mint, pool, poolTokenVault, poolSolVault };
}

// --- associated token accounts ------------------------------------------------------------------

/**
 * A wallet's associated token account for a coin.
 *
 * tokenProgram defaults to Token-2022 because every v2 coin mint is one. The ATA seeds are
 * [owner, token_program, mint] under the associated-token program, so passing the wrong token
 * program here derives an account the program will never accept: it is a parameter rather than a
 * constant for exactly that reason.
 */
export async function deriveAssociatedTokenAddress(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [seedAddress(owner), seedAddress(tokenProgram), seedAddress(mint)],
  });
  return pda;
}

export function deriveAssociatedTokenAddressSync(
  owner: Address,
  mint: Address,
  tokenProgram: Address = TOKEN_2022_PROGRAM_ADDRESS,
): Address {
  return findProgramAddressSync(
    [seedAddress(owner), seedAddress(tokenProgram), seedAddress(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  );
}

// --- the upgradeable loader ---------------------------------------------------------------------

/** The upgradeable loader's program-data account for a program id, for authority checks. */
export async function deriveProgramDataAddress(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
    seeds: [seedAddress(programAddress)],
  });
  return pda;
}
