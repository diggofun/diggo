import { beforeEach, describe, expect, it, vi } from "vitest";

const { getLatestBlockhash, getSignatureStatuses, signAndSendTransaction } = vi.hoisted(() => ({
  getLatestBlockhash: vi.fn(),
  getSignatureStatuses: vi.fn(),
  signAndSendTransaction: vi.fn(),
}));

vi.mock("@solana/kit", () => ({
  address: (value: string) => value as never,
  createSolanaRpc: () => ({
    getLatestBlockhash: () => ({ send: getLatestBlockhash }),
    getSignatureStatuses: () => ({ send: getSignatureStatuses }),
  }),
  createTransactionMessage: () => ({}),
  setTransactionMessageFeePayerSigner: (_wallet: unknown, message: unknown) => message,
  setTransactionMessageLifetimeUsingBlockhash: (_blockhash: unknown, message: unknown) => message,
  appendTransactionMessageInstructions: (_instructions: unknown, message: unknown) => message,
  signTransactionMessageWithSigners: vi.fn(),
  signAndSendTransactionMessageWithSigners: vi.fn(),
  isTransactionSendingSigner: () => false,
  getSignatureFromTransaction: vi.fn(),
  getBase64EncodedWireTransaction: vi.fn(),
  getBase58Decoder: () => ({ decode: (value: Uint8Array) => Buffer.from(value).toString("utf8") }),
  pipe: (value: unknown, ...steps: ((current: unknown) => unknown)[]) => steps.reduce((current, step) => step(current), value),
}));

import { signSendConfirm } from "./tx";

const ADDRESS = "11111111111111111111111111111111" as never;
const BLOCKHASH = "11111111111111111111111111111111";

function wallet() {
  return {
    kind: "walletconnect" as const,
    address: ADDRESS,
    provider: { signAndSendTransaction } as never,
  } as never;
}

beforeEach(() => {
  getLatestBlockhash.mockReset().mockResolvedValue({ value: { blockhash: BLOCKHASH } });
  getSignatureStatuses.mockReset();
  signAndSendTransaction.mockReset().mockResolvedValue("landed-after-timeout");
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(globalThis, "setTimeout").mockImplementation((callback) => {
    now += 800;
    callback();
    return undefined as unknown as ReturnType<typeof setTimeout>;
  });
});

describe("signSendConfirm confirmation state", () => {
  it("preserves a signature that lands after an unconfirmed status response", async () => {
    getSignatureStatuses
      .mockResolvedValueOnce({ value: [null] })
      .mockResolvedValueOnce({ value: [{ confirmationStatus: "confirmed" }] });
    const result = await signSendConfirm(wallet(), [], { returnResult: true });

    expect(result).toEqual({
      signature: "landed-after-timeout",
      status: "confirmed",
      confirmed: true,
    });
  });

  it("returns pending with the signature when confirmation polling times out", async () => {
    getSignatureStatuses.mockResolvedValue({ value: [null] });
    vi.mocked(Date.now).mockReturnValueOnce(0).mockReturnValue(90_001);

    const structured = await signSendConfirm(wallet(), [], { returnResult: true });

    expect(structured).toMatchObject({
      signature: "landed-after-timeout",
      status: "pending",
      confirmed: false,
    });
  });

  it("keeps the legacy string result source-compatible after confirmation", async () => {
    getSignatureStatuses.mockResolvedValue({ value: [{ confirmationStatus: "confirmed" }] });
    await expect(signSendConfirm(wallet(), [])).resolves.toBe("landed-after-timeout");
  });

  it("retains the signature and reports a chain rejection", async () => {
    getSignatureStatuses.mockResolvedValue({ value: [{ err: { message: "BlockhashNotFound" } }] });

    const result = await signSendConfirm(wallet(), [], { returnResult: true });

    expect(result).toMatchObject({
      signature: "landed-after-timeout",
      status: "rejected",
      confirmed: false,
    });
    expect(result.error).toBeTruthy();
  });

  it("keeps a submitted transaction pending when status polling itself fails", async () => {
    getSignatureStatuses.mockRejectedValue(new Error("RPC unavailable"));

    const result = await signSendConfirm(wallet(), [], { returnResult: true });

    expect(result).toMatchObject({
      signature: "landed-after-timeout",
      status: "pending",
      confirmed: false,
      error: "RPC unavailable",
    });
  });
});
