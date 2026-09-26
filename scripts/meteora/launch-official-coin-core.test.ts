import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  LAUNCH,
  LAUNCH_MINT,
  LAUNCH_PAYER,
  LAUNCH_POOL,
  OFFICIAL_METADATA,
  assertLaunchSigners,
  assertOfficialLogo,
  measureLaunchCost,
  officialMetadataJson,
  parseLaunchOptions,
  planLaunchBudget,
} from "./launch-official-coin-core.ts";

describe("official coin launch guards", () => {
  it("is a dry run by default and needs both keypairs plus the typed mint to send", () => {
    expect(parseLaunchOptions([]).send).toBe(false);
    expect(() => parseLaunchOptions(["--send"])).toThrow("requires both");
    const withKeys = ["--send", "--payer-keypair", "p.json", "--mint-keypair", "m.json"];
    expect(() => parseLaunchOptions(withKeys)).toThrow("--confirm-mint");
    expect(() => parseLaunchOptions([...withKeys, "--confirm-mint", "12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7"])).toThrow("--confirm-mint");
    expect(parseLaunchOptions([...withKeys, "--confirm-mint", LAUNCH.mint]).send).toBe(true);
    expect(() => parseLaunchOptions(["--mint", LAUNCH.mint])).toThrow("Unknown option");
    expect(() => parseLaunchOptions(["--priority-micro-lamports", "-1"])).toThrow("integer");
  });

  it("accepts only the pinned payer and mint", () => {
    expect(() => assertLaunchSigners(LAUNCH_PAYER, LAUNCH_MINT)).not.toThrow();
    expect(() => assertLaunchSigners(Keypair.generate().publicKey, LAUNCH_MINT)).toThrow("Payer keypair");
    expect(() => assertLaunchSigners(LAUNCH_PAYER, new PublicKey("12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7"))).toThrow("Mint keypair");
  });

  it("pins the pool, URIs and logo", () => {
    expect(LAUNCH_POOL.toBase58()).not.toBe("4g7i7aWVvwnSn6K6VKyvzG5UFf2nFCXgYJ7uJUymhhMB");
    expect(LAUNCH.metadataUrl).toBe(`https://diggo.fun/media/${LAUNCH.metadataKey}`);
    expect(LAUNCH.imageUrl).toBe(`https://diggo.fun/media/${LAUNCH.imageKey}`);
    expect(() => assertOfficialLogo(new Uint8Array(LAUNCH.imageBytes))).toThrow("Logo mismatch");
  });

  it("renders the hosted metadata JSON deterministically", () => {
    const json = officialMetadataJson();
    expect(JSON.parse(json)).toEqual(OFFICIAL_METADATA);
    expect(json).toBe(officialMetadataJson());
    expect(OFFICIAL_METADATA.extensions).toEqual({
      website: "https://diggo.fun",
      twitter: "https://x.com/Diggo_Fun",
      telegram: "https://t.me/DiggoDotFun",
    });
  });
});

describe("official coin launch budget", () => {
  const payer = LAUNCH.payer;

  it("counts lamports received by other accounts plus the network fee", () => {
    const changes = [
      { address: payer, before: 50n, after: 0n },
      { address: "mint", before: 0n, after: 1_461_600n },
      { address: "pool", before: 0n, after: 7_000_000n },
    ];
    expect(measureLaunchCost(changes, payer, 11_000n)).toBe(8_472_600n);
    expect(() => measureLaunchCost([{ address: "config", before: 10n, after: 9n }], payer, 0n)).toThrow("lost lamports");
  });

  it("keeps the payer rent exempt and rounds up to 0.001 SOL", () => {
    const budget = planLaunchBudget(30_123_456n, 890_880n, 0n);
    expect(budget.requiredBalanceLamports).toBe(33_000_000n);
    expect(budget.toSendLamports).toBe(33_000_000n);
    expect(budget.leftoverLamports).toBeGreaterThanOrEqual(890_880n + 1_000_000n);
    expect(planLaunchBudget(30_123_456n, 890_880n, 40_000_000n).toSendLamports).toBe(0n);
    expect(planLaunchBudget(30_123_456n, 890_880n, 10_000_000n).toSendLamports).toBe(23_000_000n);
    expect(planLaunchBudget(32_109_120n, 890_880n, 0n).requiredBalanceLamports).toBe(34_000_000n);
    expect(() => planLaunchBudget(0n, 890_880n, 0n)).toThrow("positive");
  });
});
