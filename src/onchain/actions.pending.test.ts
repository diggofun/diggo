import { beforeEach, describe, expect, it, vi } from "vitest";

const { signSendConfirm } = vi.hoisted(() => ({ signSendConfirm: vi.fn() }));

vi.mock("./tx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./tx")>()),
  signSendConfirm,
}));

import { collectOre } from "./actions";
import { PendingTransactionError } from "./tx";

const wallet = { address: "11111111111111111111111111111111" } as never;
const programAddress = "11111111111111111111111111111111" as never;

beforeEach(() => {
  signSendConfirm.mockReset();
});

describe("non-reclaim action timeout handling", () => {
  it("propagates a typed pending error instead of returning a false success signature", async () => {
    const pending = new PendingTransactionError("collect-ore-signature");
    signSendConfirm.mockRejectedValue(pending);

    const attempt = collectOre({ programAddress, wallet });

    await expect(attempt).rejects.toBe(pending);
    await expect(attempt).rejects.toMatchObject({
      name: "PendingTransactionError",
      signature: "collect-ore-signature",
      confirmed: false,
      status: "pending",
    });
  });
});
