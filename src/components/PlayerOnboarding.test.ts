import { describe, expect, it } from "vitest";
import {
  PLAYER_ACCOUNT_COST,
  PLAY_SUMMARY,
  WALLET_REQUIREMENT,
  onboardingBadge,
  onboardingStep,
} from "./PlayerOnboarding";
import type { DecodedPlayerAccount } from "../solanaProgram";

/**
 * The onboarding panel's two decisions, pinned.
 *
 * The step function reads the PlayerAccount's own activation window and nothing else, so there is
 * no bond, no cooldown and no paid tier that could put a wallet on a lesser step. The copy is
 * pinned in the same place because the product promise is the part that must not drift back.
 */

const NOW = 1_700_000_000;

const account = (activeUntil: bigint) => ({ activeUntil }) as unknown as DecodedPlayerAccount;

describe("the onboarding step", () => {
  it("walks connect to create to activate to ready", () => {
    expect(onboardingStep(null, false, NOW)).toBe("connect");
    expect(onboardingStep(null, true, NOW)).toBe("create");
    expect(onboardingStep(account(BigInt(NOW)), true, NOW)).toBe("activate");
    expect(onboardingStep(account(BigInt(NOW) + 1n), true, NOW)).toBe("ready");
  });

  it("treats the window the chain wrote as the only thing that closes mining", () => {
    expect(onboardingStep(account(BigInt(NOW) - 1n), true, NOW)).toBe("activate");
    expect(onboardingStep(account(BigInt(NOW) + 86_400n), true, NOW)).toBe("ready");
  });

  it("names every step, and none of them is a paid tier", () => {
    expect(onboardingBadge("connect")).toBe("Wallet not connected");
    expect(onboardingBadge("create")).toBe("No player account yet");
    expect(onboardingBadge("activate")).toBe("Window closed — activate to mine");
    expect(onboardingBadge("ready")).toBe("Window open — mining");
  });
});

describe("what the panel promises before anything is signed", () => {
  it("asks for the player account's rent and ordinary network fees", () => {
    expect(PLAYER_ACCOUNT_COST).toBe("0.002394 SOL");
    expect(WALLET_REQUIREMENT).toContain(PLAYER_ACCOUNT_COST);
    expect(WALLET_REQUIREMENT).toContain("network fee");
    expect(WALLET_REQUIREMENT).toContain("stays in your own player account");
    expect(WALLET_REQUIREMENT).toContain("Nothing else is ever locked or taken.");
  });

  it("says in as many words that there is no bond to post", () => {
    expect(PLAY_SUMMARY).toContain("no bond, no deposit and no minimum balance");
    expect(PLAY_SUMMARY).toContain("no paid tier to unlock");
  });
});
