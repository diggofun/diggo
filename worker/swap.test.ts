import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "./env";
import { readAccount } from "./meteora/rpc";
import { quoteFeeBps, swapBuild, swapFeeAccount, swapFeeBps } from "./swap";

vi.mock("./meteora/rpc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./meteora/rpc")>()),
  readAccount: vi.fn(),
}));

const ME = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const SOL = "So11111111111111111111111111111111111111112";

function env(extra: Record<string, string> = {}): RuntimeEnv {
  return {
    DB: { prepare: () => ({ bind: () => ({ first: async () => null, run: async () => ({ meta: { changes: 1 } }) }) }) },
    TOKEN_CACHE: { get: async (key: string) => (key === "auth:session:s" ? ME : null), put: async () => undefined },
    ...extra,
  } as unknown as RuntimeEnv;
}

const build = (quote: unknown) => new Request("https://diggo.fun/api/swap/build", {
  method: "POST",
  headers: { authorization: "Bearer s", "content-type": "application/json" },
  body: JSON.stringify({ quote }),
});

afterEach(() => { vi.unstubAllGlobals(); vi.mocked(readAccount).mockReset(); });

describe("swap fee", () => {
  it("defaults to 0.5% and accepts an override up to 2%", () => {
    expect(swapFeeBps(env())).toBe(50);
    expect(swapFeeBps(env({ SWAP_FEE_BPS: "0" }))).toBe(0);
    expect(swapFeeBps(env({ SWAP_FEE_BPS: "100" }))).toBe(100);
    expect(swapFeeBps(env({ SWAP_FEE_BPS: "900" }))).toBe(50);
  });

  it("reads the fee a quote carries", () => {
    expect(quoteFeeBps({ platformFee: { amount: "1", feeBps: 50 } })).toBe(50);
    expect(quoteFeeBps({ platformFee: null })).toBe(0);
    expect(quoteFeeBps(null)).toBe(0);
  });

  it("refuses to build a swap whose quote dropped the fee", async () => {
    vi.mocked(readAccount).mockResolvedValue({ pubkey: "x", lamports: 1n, data: new Uint8Array(165), owner: "x" });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const response = await swapBuild(build({ outputMint: SOL, platformFee: null }), env());
    expect(response.status).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sends the fee account to Jupiter with a quote that carries the fee", async () => {
    vi.mocked(readAccount).mockResolvedValue({ pubkey: "x", lamports: 1n, data: new Uint8Array(165), owner: "x" });
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ swapTransaction: "AQ==" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await swapBuild(build({ outputMint: SOL, platformFee: { amount: "5", feeBps: 50 } }), env());
    expect(response.status).toBe(200);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).toMatchObject({ userPublicKey: ME, feeAccount: swapFeeAccount(env()), wrapAndUnwrapSol: true });
  });

  it("builds without a fee while the fee account does not exist yet", async () => {
    vi.mocked(readAccount).mockResolvedValue(null);
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ swapTransaction: "AQ==" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const response = await swapBuild(build({ outputMint: SOL, platformFee: null }), env());
    expect(response.status).toBe(200);
    const sent = JSON.parse(String((fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent.feeAccount).toBeUndefined();
  });
});

describe("amounts", async () => {
  const { toRaw } = await import("./swap");
  it("parses decimal amounts into raw units", () => {
    expect(toRaw("1", 9)).toBe(1_000_000_000n);
    expect(toRaw("0.5", 9)).toBe(500_000_000n);
    expect(toRaw("1.234567891", 6)).toBe(1_234_567n);
    expect(toRaw("abc", 9)).toBeNull();
    expect(toRaw("-1", 9)).toBeNull();
  });
});
