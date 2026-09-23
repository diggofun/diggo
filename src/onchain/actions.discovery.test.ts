import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveGlobalBudgetPda } from "../../shared/pdas";
import { PendingTransactionError } from "./tx";

const { fetchAndDecode, signSendConfirm } = vi.hoisted(() => ({
  fetchAndDecode: vi.fn(),
  signSendConfirm: vi.fn(),
}));

vi.mock("./rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./rpc")>()),
  fetchAndDecode,
}));

vi.mock("./tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tx")>()),
  signSendConfirm,
}));

import { createDiscoveryRoll } from "./actions";
import { decodeClockSysvar, SYSVAR_CLOCK_ADDRESS } from "../../shared/program";

const programAddress = "11111111111111111111111111111111" as never;
const owner = "11111111111111111111111111111111" as never;
const mint = "So11111111111111111111111111111111111111112" as never;
const wallet = { address: owner } as never;
const day = 20_000;
const secondsPerDay = 86_400n;

function clock(timestamp: bigint): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setBigUint64(0, 123n, true);
  view.setBigInt64(8, timestamp - 100n, true);
  view.setBigUint64(16, 7n, true);
  view.setBigUint64(24, 8n, true);
  view.setBigInt64(32, timestamp, true);
  return bytes;
}

function player() {
  return { dayIndex: day, rollWindow: 41 } as never;
}

function setReads(timestamps: bigint[]): void {
  fetchAndDecode.mockImplementation(async (pda: unknown) => {
    if (pda === SYSVAR_CLOCK_ADDRESS) {
      const timestamp = timestamps.shift() ?? timestamps.at(-1)!;
      return decodeClockSysvar(clock(timestamp));
    }
    return player();
  });
}

beforeEach(() => {
  fetchAndDecode.mockReset();
  signSendConfirm.mockReset().mockResolvedValue("confirmed-roll");
});

describe("discovery roll chain-day freshness", () => {
  it("rebuilds the budget PDA for day N+1 when the player still says day N", async () => {
    setReads([BigInt(day) * secondsPerDay, BigInt(day + 1) * secondsPerDay]);

    await createDiscoveryRoll({ programAddress, wallet, mint });

    expect(signSendConfirm).toHaveBeenCalledTimes(1);
    const [instruction] = signSendConfirm.mock.calls[0][1] as [{ accounts: { address: string }[] }];
    const expected = await deriveGlobalBudgetPda(programAddress, day + 1);
    expect(instruction.accounts[5].address).toBe(expected);
  });

  it("does not retry a transaction once the wallet has reported it pending", async () => {
    setReads([BigInt(day) * secondsPerDay, BigInt(day) * secondsPerDay]);
    const pending = new PendingTransactionError("roll-signature");
    signSendConfirm.mockRejectedValue(pending);

    await expect(createDiscoveryRoll({ programAddress, wallet, mint })).rejects.toBe(pending);
    expect(signSendConfirm).toHaveBeenCalledTimes(1);
  });
});
