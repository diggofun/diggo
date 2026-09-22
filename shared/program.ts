/**
 * Thin, dependency-free client for the diggo_protocol Anchor program, built directly on
 * @solana/kit primitives (already a project dependency, isomorphic between the browser
 * frontend and the Cloudflare Worker keeper — no @coral-xyz/anchor, no Buffer).
 *
 * Account layouts, PDA seeds and instruction discriminators are transcribed from
 * programs/diggo-protocol/src/lib.rs and its generated IDL. If the program changes,
 * this file must change with it — there is no code generation step.
 */
import {
  type Address,
  address,
  type Instruction,
  type ReadonlyUint8Array,
  AccountRole,
  getProgramDerivedAddress,
  getU8Encoder,
  getU16Encoder,
  getU32Encoder,
  getU64Encoder,
  getI64Encoder,
  getAddressEncoder,
} from "@solana/kit";
// Used only by the synchronous PDA helper below. @noble/curves is a declared dependency
// (the worker already imports its ed25519 module) and it pins @noble/hashes.
import { sha256 } from "@noble/hashes/sha2.js";
import { ed25519 } from "@noble/curves/ed25519.js";

type IInstruction = Instruction;
type Bytes = Uint8Array | ReadonlyUint8Array;

export const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
export const TOKEN_PROGRAM_ADDRESS = address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const BPF_LOADER_UPGRADEABLE_ADDRESS = address("BPFLoaderUpgradeab1e11111111111111111111111");

const DISCRIMINATOR = {
  initializeProtocol: [188, 233, 252, 106, 134, 146, 202, 91],
  rotateKeeper: [201, 88, 117, 249, 81, 101, 255, 55],
  launchToken: [10, 128, 86, 171, 3, 137, 161, 244],
  buy: [102, 6, 61, 18, 1, 218, 235, 234],
  sell: [51, 230, 133, 164, 1, 127, 131, 173],
  initializePlayer: [79, 249, 88, 177, 220, 62, 56, 128],
  assignPower: [91, 85, 179, 221, 48, 238, 125, 89],
  removePower: [156, 78, 134, 240, 166, 100, 199, 228],
  advanceMine: [219, 100, 97, 253, 117, 231, 58, 7],
  claimRewards: [4, 144, 132, 71, 116, 23, 151, 80],
  syncCrewPower: [69, 12, 225, 37, 147, 155, 26, 111],
  claimDiscovery: [82, 247, 137, 110, 42, 233, 221, 207],
  // spec 19/23/35/37/65 hardening: scoped circuit breakers, guardian rotation, bounded
  // keeper power, explicit trading fees.
  pauseDiscoveryPayouts: [75, 20, 112, 149, 127, 54, 56, 174],
  pauseRewardClaims: [42, 72, 213, 117, 127, 179, 47, 157],
  pauseMineDiscovery: [89, 93, 22, 73, 178, 169, 66, 219],
  rotateGuardian: [71, 22, 223, 22, 230, 118, 101, 114],
  updatePowerBounds: [50, 202, 219, 213, 8, 191, 131, 216],
  updateFeeConfig: [104, 184, 103, 242, 88, 151, 107, 20],
  updateDiscoveryLimits: [16, 214, 96, 49, 233, 139, 101, 121],
  claimCreatorFees: [0, 23, 125, 234, 156, 118, 134, 89],
  claimPlatformFees: [159, 129, 37, 35, 170, 99, 163, 16],
} as const satisfies Record<string, number[]>;

// --- byte-level (Borsh-compatible) encoding helpers -------------------------------------

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

const u8 = (n: number) => getU8Encoder().encode(n);
const u16 = (n: number) => getU16Encoder().encode(n);
const u64 = (n: bigint) => getU64Encoder().encode(n);
const bool = (value: boolean) => u8(value ? 1 : 0);
const i64 = (n: bigint) => getI64Encoder().encode(n);
const pubkeyBytes = (a: Address) => getAddressEncoder().encode(a);
function borshString(value: string): Uint8Array {
  const body = new TextEncoder().encode(value);
  return concatBytes(getU32Encoder().encode(body.length), body);
}

// --- PDA seed helpers ---------------------------------------------------------------------

const constSeed = (value: string) => new TextEncoder().encode(value);
const accountSeed = (a: Address) => pubkeyBytes(a);

// --- PDA derivation -------------------------------------------------------------------------

export async function deriveProtocolPda(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("protocol")] });
  return pda;
}

/**
 * Synchronous PDA derivation, mirroring @solana/kit's getProgramDerivedAddress: hash the
 * seeds, then the bump byte, then the program address and the "ProgramDerivedAddress"
 * marker, and take the first bump whose digest is not a valid ed25519 point. It exists so
 * that instruction builders whose callers compose transactions synchronously can still
 * resolve a required PDA — see buildClaimRewardsInstruction.
 */
const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress");

function isOnCurveAddress(bytes: Uint8Array): boolean {
  try {
    ed25519.Point.fromBytes(bytes);
    return true;
  } catch {
    return false;
  }
}

export function findProgramAddressSync(seeds: Uint8Array[], programAddress: Address): Address {
  const programBytes = pubkeyBytes(programAddress);
  for (let bump = 255; bump >= 0; bump--) {
    const digest = sha256(concatBytes(...seeds, Uint8Array.of(bump), programBytes, PDA_MARKER));
    if (!isOnCurveAddress(digest)) return address(base58FromBytes(digest));
  }
  throw new Error("Unable to find a viable program address bump");
}

/** The protocol config PDA, resolved without awaiting — see findProgramAddressSync. */
export function deriveProtocolPdaSync(programAddress: Address): Address {
  return findProgramAddressSync([constSeed("protocol")], programAddress);
}

export async function deriveProgramDataAddress(programAddress: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: BPF_LOADER_UPGRADEABLE_ADDRESS,
    seeds: [accountSeed(programAddress)],
  });
  return pda;
}

export async function deriveMintPda(programAddress: Address, creator: Address, nonce: bigint): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("mint"), accountSeed(creator), u64(nonce)],
  });
  return pda;
}

export async function deriveMinePda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("mine"), accountSeed(mint)] });
  return pda;
}

export async function deriveMarketPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("market"), accountSeed(mint)] });
  return pda;
}

export async function deriveMarketVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("market-vault"), accountSeed(mint)],
  });
  return pda;
}

export async function deriveReserveVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("reserve-vault"), accountSeed(mint)],
  });
  return pda;
}

export async function deriveDiscoveryVaultPda(programAddress: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("discovery-vault"), accountSeed(mint)],
  });
  return pda;
}

/** Idempotency receipt PDA for one (mine, discovery_id) discovery payout. */
export async function deriveDiscoveryReceiptPda(
  programAddress: Address,
  mine: Address,
  discoveryId: bigint,
): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("discovery"), accountSeed(mine), u64(discoveryId)],
  });
  return pda;
}

export async function derivePlayerPda(programAddress: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({ programAddress, seeds: [constSeed("player"), accountSeed(owner)] });
  return pda;
}

export async function derivePositionPda(programAddress: Address, mine: Address, owner: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress,
    seeds: [constSeed("position"), accountSeed(mine), accountSeed(owner)],
  });
  return pda;
}

export async function deriveAssociatedTokenAddress(owner: Address, mint: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [accountSeed(owner), accountSeed(TOKEN_PROGRAM_ADDRESS), accountSeed(mint)],
  });
  return pda;
}

/** Every derived address needed to operate on one already-launched mine. */
export interface MineAddresses {
  mint: Address;
  mine: Address;
  market: Address;
  marketVault: Address;
  reserveVault: Address;
  discoveryVault: Address;
}

export async function deriveMineAddresses(programAddress: Address, mint: Address): Promise<MineAddresses> {
  const [mine, market, marketVault, reserveVault, discoveryVault] = await Promise.all([
    deriveMinePda(programAddress, mint),
    deriveMarketPda(programAddress, mint),
    deriveMarketVaultPda(programAddress, mint),
    deriveReserveVaultPda(programAddress, mint),
    deriveDiscoveryVaultPda(programAddress, mint),
  ]);
  return { mint, mine, market, marketVault, reserveVault, discoveryVault };
}

// --- account meta helpers -------------------------------------------------------------------

const w = (a: Address) => ({ address: a, role: AccountRole.WRITABLE }) as const;
const r = (a: Address) => ({ address: a, role: AccountRole.READONLY }) as const;
const ws = (a: Address) => ({ address: a, role: AccountRole.WRITABLE_SIGNER }) as const;
const rs = (a: Address) => ({ address: a, role: AccountRole.READONLY_SIGNER }) as const;

// --- instruction builders --------------------------------------------------------------------

export function buildInitializeProtocolInstruction(params: {
  programAddress: Address;
  payer: Address;
  protocol: Address;
  programData: Address;
  treasury: Address;
  keeper: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.payer),
      r(params.programAddress),
      r(params.programData),
      w(params.protocol),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.initializeProtocol),
      pubkeyBytes(params.treasury),
      pubkeyBytes(params.keeper),
    ),
  };
}

export interface LaunchTokenArgs {
  nonce: bigint;
  name: string;
  symbol: string;
  uri: string;
  decimals: number;
  totalSupply: bigint;
  reserveBps: number;
  initialBlockReward: bigint;
  minimumReward: bigint;
  blockInterval: bigint;
  epochLength: bigint;
  reductionBps: number;
  virtualSolReserve: bigint;
  graduationTarget: bigint;
  discoveryReserveBps: number;
}

export function buildLaunchTokenInstruction(params: {
  programAddress: Address;
  creator: Address;
  protocol: Address;
  treasury: Address;
  feeVault: Address;
  args: LaunchTokenArgs;
} & MineAddresses): IInstruction {
  const a = params.args;
  const data = concatBytes(
    Uint8Array.from(DISCRIMINATOR.launchToken),
    u64(a.nonce),
    borshString(a.name),
    borshString(a.symbol),
    borshString(a.uri),
    u8(a.decimals),
    u64(a.totalSupply),
    u16(a.reserveBps),
    u64(a.initialBlockReward),
    u64(a.minimumReward),
    i64(a.blockInterval),
    i64(a.epochLength),
    u16(a.reductionBps),
    u64(a.virtualSolReserve),
    u64(a.graduationTarget),
    u16(a.discoveryReserveBps),
  );
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.creator),
      r(params.protocol),
      r(params.treasury),
      w(params.mint),
      w(params.mine),
      w(params.market),
      w(params.marketVault),
      w(params.reserveVault),
      w(params.discoveryVault),
      w(params.feeVault),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data,
  };
}

export function buildBuyInstruction(params: {
  programAddress: Address;
  buyer: Address;
  buyerTokens: Address;
  solIn: bigint;
  minTokensOut: bigint;
} & MineAddresses): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.buyer),
      w(params.mine),
      w(params.market),
      r(params.mint),
      w(params.marketVault),
      w(params.buyerTokens),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.buy), u64(params.solIn), u64(params.minTokensOut)),
  };
}

export function buildSellInstruction(params: {
  programAddress: Address;
  seller: Address;
  sellerTokens: Address;
  tokensIn: bigint;
  minSolOut: bigint;
} & MineAddresses): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.seller),
      r(params.mine),
      w(params.market),
      r(params.mint),
      w(params.marketVault),
      w(params.sellerTokens),
      r(TOKEN_PROGRAM_ADDRESS),
    ],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.sell), u64(params.tokensIn), u64(params.minSolOut)),
  };
}

export function buildInitializePlayerInstruction(params: {
  programAddress: Address;
  owner: Address;
  player: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [ws(params.owner), w(params.player), r(SYSTEM_PROGRAM_ADDRESS)],
    data: Uint8Array.from(DISCRIMINATOR.initializePlayer),
  };
}

export function buildAssignPowerInstruction(params: {
  programAddress: Address;
  owner: Address;
  player: Address;
  mine: Address;
  position: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [ws(params.owner), w(params.player), w(params.mine), w(params.position), r(SYSTEM_PROGRAM_ADDRESS)],
    data: Uint8Array.from(DISCRIMINATOR.assignPower),
  };
}

export function buildRemovePowerInstruction(params: {
  programAddress: Address;
  owner: Address;
  player: Address;
  mine: Address;
  position: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [ws(params.owner), w(params.player), w(params.mine), w(params.position), r(SYSTEM_PROGRAM_ADDRESS)],
    data: Uint8Array.from(DISCRIMINATOR.removePower),
  };
}

export function buildClaimRewardsInstruction(params: {
  programAddress: Address;
  owner: Address;
  mine: Address;
  mint: Address;
  reserveVault: Address;
  ownerTokens: Address;
  position: Address;
  /** Optional override; the protocol PDA is derived synchronously when omitted. */
  protocol?: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.owner),
      r(params.protocol ?? deriveProtocolPdaSync(params.programAddress)),
      w(params.mine),
      r(params.mint),
      w(params.reserveVault),
      w(params.ownerTokens),
      w(params.position),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: Uint8Array.from(DISCRIMINATOR.claimRewards),
  };
}

/** Keeper-only: pushes an off-chain, ORE-funded Crew power value on-chain. */
export function buildSyncCrewPowerInstruction(params: {
  programAddress: Address;
  keeper: Address;
  protocol: Address;
  owner: Address;
  player: Address;
  mine: Address;
  mint: Address;
  position: Address;
  newPower: bigint;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.keeper),
      r(params.protocol),
      r(params.owner),
      w(params.player),
      w(params.mine),
      r(params.mint),
      w(params.position),
    ],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.syncCrewPower), u64(params.newPower)),
  };
}

// --- account decoding (mirrors the structs above) -------------------------------------------

export const ACCOUNT_DISCRIMINATOR = {
  protocolConfig: [207, 91, 250, 28, 152, 179, 215, 209],
  mine: [67, 107, 75, 99, 143, 125, 186, 164],
  launchMarket: [73, 227, 118, 164, 34, 99, 10, 101],
  player: [205, 222, 112, 7, 165, 155, 206, 218],
  miningPosition: [132, 97, 97, 74, 238, 187, 109, 140],
  discoveryReceipt: [168, 19, 166, 49, 77, 198, 78, 101],
} as const satisfies Record<string, number[]>;

function base58FromBytes(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeros = 0;
  for (const byte of bytes) {
    if (byte !== 0) break;
    leadingZeros++;
  }
  return alphabet[0].repeat(leadingZeros) + digits.reverse().map((d) => alphabet[d]).join("");
}

/** Small sequential cursor for decoding Borsh-laid-out account data (post 8-byte discriminator). */
class ByteReader {
  private offset = 0;
  private readonly data: Uint8Array;
  constructor(data: Uint8Array) {
    this.data = data;
  }
  private view() {
    return new DataView(this.data.buffer, this.data.byteOffset + this.offset);
  }
  u8(): number {
    const v = this.view().getUint8(0);
    this.offset += 1;
    return v;
  }
  bool(): boolean {
    return this.u8() !== 0;
  }
  u16(): number {
    const v = this.view().getUint16(0, true);
    this.offset += 2;
    return v;
  }
  i64(): bigint {
    const v = this.view().getBigInt64(0, true);
    this.offset += 8;
    return v;
  }
  u64(): bigint {
    const v = this.view().getBigUint64(0, true);
    this.offset += 8;
    return v;
  }
  u128(): bigint {
    const lo = this.u64();
    const hi = this.u64();
    return lo + (hi << 64n);
  }
  pubkey(): Address {
    const bytes = this.data.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return address(base58FromBytes(bytes));
  }
  string(): string {
    const len = this.view().getUint32(0, true);
    this.offset += 4;
    const bytes = this.data.subarray(this.offset, this.offset + len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }
  skipDiscriminator(): void {
    this.offset += 8;
  }
}

export type MineStatusName = "Launching" | "MiningActive" | "FullyMined";

export interface DecodedMine {
  mint: Address;
  creator: Address;
  reserveVault: Address;
  discoveryVault: Address;
  marketVault: Address;
  feeVault: Address;
  totalSupply: bigint;
  remainingReserve: bigint;
  remainingDiscoveryReserve: bigint;
  cumulativeDistributed: bigint;
  totalPower: bigint;
  rewardIndex: bigint;
  currentBlockReward: bigint;
  blockInterval: bigint;
  nextBlockAt: bigint;
  epoch: bigint;
  epochLength: bigint;
  epochEndsAt: bigint;
  reductionBps: number;
  minimumReward: bigint;
  status: MineStatusName;
  name: string;
  symbol: string;
  uri: string;
  discoveryReserveTotal: bigint;
  discoveryEpochBudget: bigint;
  discoveryEpochSpent: bigint;
  discoveryEpochEndsAt: bigint;
  discoveryPaused: boolean;
  bump: number;
}

export function decodeMine(data: Uint8Array): DecodedMine {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  const mint = r.pubkey();
  const creator = r.pubkey();
  const reserveVault = r.pubkey();
  const discoveryVault = r.pubkey();
  const marketVault = r.pubkey();
  const feeVault = r.pubkey();
  const totalSupply = r.u64();
  const remainingReserve = r.u64();
  const remainingDiscoveryReserve = r.u64();
  const cumulativeDistributed = r.u64();
  const totalPower = r.u64();
  const rewardIndex = r.u128();
  const currentBlockReward = r.u64();
  const blockInterval = r.i64();
  const nextBlockAt = r.i64();
  const epoch = r.u64();
  const epochLength = r.i64();
  const epochEndsAt = r.i64();
  const reductionBps = r.u16();
  const minimumReward = r.u64();
  const statusTag = r.u8();
  const status: MineStatusName = statusTag === 0 ? "Launching" : statusTag === 1 ? "MiningActive" : "FullyMined";
  const name = r.string();
  const symbol = r.string();
  const uri = r.string();
  const discoveryReserveTotal = r.u64();
  const discoveryEpochBudget = r.u64();
  const discoveryEpochSpent = r.u64();
  const discoveryEpochEndsAt = r.i64();
  const discoveryPaused = r.bool();
  const bump = r.u8();
  return {
    mint, creator, reserveVault, discoveryVault, marketVault, feeVault, totalSupply, remainingReserve,
    remainingDiscoveryReserve, cumulativeDistributed, totalPower, rewardIndex, currentBlockReward,
    blockInterval, nextBlockAt, epoch, epochLength, epochEndsAt, reductionBps, minimumReward, status,
    name, symbol, uri, discoveryReserveTotal, discoveryEpochBudget, discoveryEpochSpent,
    discoveryEpochEndsAt, discoveryPaused, bump,
  };
}

export interface DecodedLaunchMarket {
  mine: Address;
  tokenReserve: bigint;
  solReserve: bigint;
  virtualSolReserve: bigint;
  graduationTarget: bigint;
  graduated: boolean;
  creatorFeeClaimable: bigint;
  platformFeeClaimable: bigint;
  creatorFeeBps: number;
  platformFeeBps: number;
  bump: number;
}

export function decodeLaunchMarket(data: Uint8Array): DecodedLaunchMarket {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    mine: r.pubkey(),
    tokenReserve: r.u64(),
    solReserve: r.u64(),
    virtualSolReserve: r.u64(),
    graduationTarget: r.u64(),
    graduated: r.bool(),
    creatorFeeClaimable: r.u64(),
    platformFeeClaimable: r.u64(),
    creatorFeeBps: r.u16(),
    platformFeeBps: r.u16(),
    bump: r.u8(),
  };
}

export interface DecodedProtocolConfig {
  treasury: Address;
  keeper: Address;
  /** Circuit-breaker authority: may only flip the scoped pause flags and tune the
   * bounded parameters below, never move reserve tokens or LP SOL. */
  guardian: Address;
  reserveBps: number;
  discoveryReserveBps: number;
  creatorFeeBps: number;
  platformFeeBps: number;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
  maxCrewPower: bigint;
  maxPowerIncreaseBps: number;
  discoveryPayoutsPaused: boolean;
  rewardClaimsPaused: boolean;
  bump: number;
}

export function decodeProtocolConfig(data: Uint8Array): DecodedProtocolConfig {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    treasury: r.pubkey(),
    keeper: r.pubkey(),
    guardian: r.pubkey(),
    reserveBps: r.u16(),
    discoveryReserveBps: r.u16(),
    creatorFeeBps: r.u16(),
    platformFeeBps: r.u16(),
    discoveryMaxBps: r.u16(),
    discoveryEpochBudgetBps: r.u16(),
    maxCrewPower: r.u64(),
    maxPowerIncreaseBps: r.u16(),
    discoveryPayoutsPaused: r.bool(),
    rewardClaimsPaused: r.bool(),
    bump: r.u8(),
  };
}

export interface DecodedPlayer {
  owner: Address;
  power: bigint;
  activeMine: Address;
  bump: number;
}

export function decodePlayer(data: Uint8Array): DecodedPlayer {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return { owner: r.pubkey(), power: r.u64(), activeMine: r.pubkey(), bump: r.u8() };
}

export interface DecodedMiningPosition {
  owner: Address;
  mine: Address;
  assignedPower: bigint;
  lastRewardIndex: bigint;
  pendingReward: bigint;
  bump: number;
}

export function decodeMiningPosition(data: Uint8Array): DecodedMiningPosition {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    owner: r.pubkey(),
    mine: r.pubkey(),
    assignedPower: r.u64(),
    lastRewardIndex: r.u128(),
    pendingReward: r.u64(),
    bump: r.u8(),
  };
}

export interface DecodedDiscoveryReceipt {
  mine: Address;
  discoveryId: bigint;
  recipient: Address;
  amount: bigint;
  claimedAt: bigint;
  bump: number;
}

/** One receipt per (mine, discovery_id); its existence is the on-chain replay guard. */
export function decodeDiscoveryReceipt(data: Uint8Array): DecodedDiscoveryReceipt {
  const r = new ByteReader(data);
  r.skipDiscriminator();
  return {
    mine: r.pubkey(),
    discoveryId: r.u64(),
    recipient: r.pubkey(),
    amount: r.u64(),
    claimedAt: r.i64(),
    bump: r.u8(),
  };
}

/**
 * Constant-product spot price of the bonding curve, in lamports per whole token unit
 * (i.e. already adjusted for `decimals`). Matches the on-chain quote_buy/quote_sell curve.
 */
export function bondingCurveSpotPriceLamports(market: DecodedLaunchMarket, decimals: number): number {
  const effectiveSol = Number(market.solReserve + market.virtualSolReserve);
  const tokenReserveWhole = Number(market.tokenReserve) / 10 ** decimals;
  if (tokenReserveWhole <= 0) return 0;
  return effectiveSol / tokenReserveWhole;
}

/** Mirrors the Rust program's quote_buy exactly (integer division, same operand order). */
export function quoteBuy(market: DecodedLaunchMarket, solIn: bigint): bigint {
  if (solIn <= 0n) return 0n;
  const denominator = market.solReserve + market.virtualSolReserve + solIn;
  if (denominator <= 0n) return 0n;
  return (market.tokenReserve * solIn) / denominator;
}

/** Mirrors the Rust program's quote_sell exactly, including the real-SOL-reserve cap. */
export function quoteSell(market: DecodedLaunchMarket, tokensIn: bigint): bigint {
  if (tokensIn <= 0n) return 0n;
  const effectiveSol = market.solReserve + market.virtualSolReserve;
  const denominator = market.tokenReserve + tokensIn;
  if (denominator <= 0n) return 0n;
  const raw = (effectiveSol * tokensIn) / denominator;
  return raw < market.solReserve ? raw : market.solReserve;
}

/** Keeper-only: pays a server-approved Discovery out of the token's own Discovery Reserve. */
export function buildClaimDiscoveryInstruction(params: {
  programAddress: Address;
  keeper: Address;
  protocol: Address;
  mine: Address;
  mint: Address;
  discoveryVault: Address;
  recipient: Address;
  recipientTokens: Address;
  /** Unique id of the off-chain discovery record; replaying one fails on-chain. */
  discoveryId: bigint;
  /** PDA from deriveDiscoveryReceiptPda(programAddress, mine, discoveryId). */
  receipt: Address;
  amount: bigint;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      rs(params.keeper),
      r(params.protocol),
      w(params.mine),
      r(params.mint),
      w(params.discoveryVault),
      r(params.recipient),
      w(params.recipientTokens),
      w(params.receipt),
      r(TOKEN_PROGRAM_ADDRESS),
      r(ASSOCIATED_TOKEN_PROGRAM_ADDRESS),
      r(SYSTEM_PROGRAM_ADDRESS),
    ],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.claimDiscovery),
      u64(params.discoveryId),
      u64(params.amount),
    ),
  };
}

// --- guardian / circuit-breaker / fee instructions (spec 19, 23, 35, 37, 65) --------

/**
 * Guardian-only. Pause instructions carry no mint, token account or vault: they can only
 * flip a flag, never move a reserve token.
 */
export function buildPauseDiscoveryPayoutsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  paused: boolean;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.pauseDiscoveryPayouts), bool(params.paused)),
  };
}

export function buildPauseRewardClaimsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  paused: boolean;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.pauseRewardClaims), bool(params.paused)),
  };
}

export function buildPauseMineDiscoveryInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  mine: Address;
  mint: Address;
  paused: boolean;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), r(params.protocol), w(params.mine), r(params.mint)],
    data: concatBytes(Uint8Array.from(DISCRIMINATOR.pauseMineDiscovery), bool(params.paused)),
  };
}

export function buildRotateGuardianInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  newGuardian: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.rotateGuardian),
      pubkeyBytes(params.newGuardian),
    ),
  };
}

export function buildUpdatePowerBoundsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  maxCrewPower: bigint;
  maxPowerIncreaseBps: number;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.updatePowerBounds),
      u64(params.maxCrewPower),
      u16(params.maxPowerIncreaseBps),
    ),
  };
}

export function buildUpdateFeeConfigInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  creatorFeeBps: number;
  platformFeeBps: number;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.updateFeeConfig),
      u16(params.creatorFeeBps),
      u16(params.platformFeeBps),
    ),
  };
}

export function buildUpdateDiscoveryLimitsInstruction(params: {
  programAddress: Address;
  guardian: Address;
  protocol: Address;
  discoveryMaxBps: number;
  discoveryEpochBudgetBps: number;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [rs(params.guardian), w(params.protocol)],
    data: concatBytes(
      Uint8Array.from(DISCRIMINATOR.updateDiscoveryLimits),
      u16(params.discoveryMaxBps),
      u16(params.discoveryEpochBudgetBps),
    ),
  };
}

/** Creator-only: pays out the creator's accrued trading fee, never LP SOL or reserves. */
export function buildClaimCreatorFeesInstruction(params: {
  programAddress: Address;
  creator: Address;
  mint: Address;
  mine: Address;
  market: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [ws(params.creator), r(params.mint), r(params.mine), w(params.market)],
    data: Uint8Array.from(DISCRIMINATOR.claimCreatorFees),
  };
}

/** Treasury-only: pays out the platform trading fee accrued on one market. */
export function buildClaimPlatformFeesInstruction(params: {
  programAddress: Address;
  treasury: Address;
  protocol: Address;
  mint: Address;
  mine: Address;
  market: Address;
}): IInstruction {
  return {
    programAddress: params.programAddress,
    accounts: [
      ws(params.treasury),
      r(params.protocol),
      r(params.mint),
      r(params.mine),
      w(params.market),
    ],
    data: Uint8Array.from(DISCRIMINATOR.claimPlatformFees),
  };
}
