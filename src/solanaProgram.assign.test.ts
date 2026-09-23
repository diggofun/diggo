/**
 * Off-chain proof that an assign on a curve-phase mine reaches the program with the market
 * account attached.
 *
 * The bug this covers: `assignPowerOnChain` built its `assign_power` from the mine alone, so a
 * mine still on its bonding curve - whose only payable block source is the curve's own token
 * inventory, held on the market account - answered `SyncBehind` and the assignment never
 * settled until somebody happened to run `advance_mine`.
 *
 * The real client path is driven here (PDA derivation, the initialize_player short-circuit, the
 * legacy-message build, the wallet signature) with only the JSON-RPC endpoint stubbed, and then
 * the transaction the wallet actually handed to the RPC is decoded. What is asserted is the
 * account list that would have reached the program, not a re-derivation of it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  address,
  generateKeyPairSigner,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  type Address,
} from "@solana/kit";
import { Buffer } from "buffer";
import { SYSTEM_PROGRAM_ADDRESS, derivePlayerPda, derivePositionPda } from "../shared/program";
import { assignPowerOnChain, deriveMineAddresses, type DiggoWallet } from "./solanaProgram";

const pk = (byte: number): Address => address(getBase58Decoder().decode(new Uint8Array(32).fill(byte)));

const PROGRAM = pk(1);
const MINT = pk(2);
const BLOCKHASH = "11111111111111111111111111111111";
const SIGNATURE = getBase58Decoder().decode(new Uint8Array(64).fill(7));

interface RpcRequest {
  id: unknown;
  method: string;
  params?: unknown[];
}

/**
 * A JSON-RPC stub for exactly the calls this path makes. It answers batched requests too, so the
 * test does not depend on how the transport chooses to group them, and it records the base64
 * wire transaction of every sendTransaction so the caller can decode what was really submitted.
 */
function rpcStub(sent: string[]) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as RpcRequest | RpcRequest[];
    const batch = Array.isArray(body);
    const answer = (request: RpcRequest): unknown => {
      switch (request.method) {
        case "getAccountInfo":
          // The player PDA does not exist yet, so the client initializes it first and sends the
          // assign in a second transaction - the last one this test decodes.
          return { context: { slot: 1 }, value: null };
        case "getLatestBlockhash":
          return { context: { slot: 1 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 1 } };
        case "sendTransaction":
          sent.push(String(request.params?.[0]));
          return SIGNATURE;
        case "getSignatureStatuses":
          return {
            context: { slot: 1 },
            value: [{ slot: 1, confirmations: 1, err: null, confirmationStatus: "confirmed" }],
          };
        default:
          throw new Error(`unexpected RPC method ${request.method}`);
      }
    };
    const payload = batch
      ? (body as RpcRequest[]).map((request) => ({ jsonrpc: "2.0", id: request.id, result: answer(request) }))
      : { jsonrpc: "2.0", id: (body as RpcRequest).id, result: answer(body as RpcRequest) };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

/** The account keys of a base64 wire transaction, in the order the program will receive them. */
function accountKeysOf(wireTransaction: string): readonly string[] {
  const transaction = getTransactionDecoder().decode(Buffer.from(wireTransaction, "base64"));
  return getCompiledTransactionMessageDecoder().decode(transaction.messageBytes).staticAccounts;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("assignPowerOnChain on a curve-phase mine", () => {
  it("submits an assign_power whose account list carries the mine's market", async () => {
    const sent: string[] = [];
    vi.stubGlobal("fetch", rpcStub(sent));
    const signer = await generateKeyPairSigner();

    const signature = await assignPowerOnChain(PROGRAM, signer as unknown as DiggoWallet, MINT);
    // The client derives the signature from the transaction it signed itself, so it is the
    // wallet's own base58 signature rather than the stub's echo.
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(sent).toHaveLength(2);

    const { mine, market } = await deriveMineAddresses(PROGRAM, MINT);
    const player = await derivePlayerPda(PROGRAM, signer.address);
    const position = await derivePositionPda(PROGRAM, mine, signer.address);
    // AssignPower's six accounts plus the program id the message has to carry. Before the fix
    // this transaction held five plus the program id: the market was absent, and a mine still on
    // its curve answered SyncBehind. The declared account order is asserted in
    // shared/program.test.ts; here the message is compiled by @solana/kit, so only the set is
    // this test's business.
    const keys = accountKeysOf(sent[1]);
    expect(keys).toHaveLength(7);
    expect(new Set(keys)).toEqual(
      new Set([signer.address, player, mine, position, market, SYSTEM_PROGRAM_ADDRESS, PROGRAM]),
    );
    expect(keys).toContain(market);
  });
});
