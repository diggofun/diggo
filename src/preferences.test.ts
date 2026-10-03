import { describe, expect, it } from "vitest";
import { BOT_EYEWEAR, BOT_HATS } from "./components/Bot";
import { BOT_ACCESSORIES, accessoryOf, defaultBot, oneAccessory, parseBotLook, withAccessory } from "./preferences";

describe("profile bot preferences", () => {
  it("offers every hat and every eyewear in the single accessory slot", () => {
    expect(BOT_ACCESSORIES).toHaveLength(1 + (BOT_HATS.length - 1) + (BOT_EYEWEAR.length - 1));
    expect(new Set(BOT_ACCESSORIES).size).toBe(BOT_ACCESSORIES.length);
  });

  it("never keeps a hat and eyewear together", () => {
    const base = { shape: "circle", color: "#ff6a00", hat: "crown", eyewear: "shades" } as const;
    expect(oneAccessory(base)).toMatchObject({ hat: "crown", eyewear: "none" });
    expect(withAccessory(base, "eyewear:goggles")).toMatchObject({ hat: "none", eyewear: "goggles" });
    expect(withAccessory(base, "hat:cap")).toMatchObject({ hat: "cap", eyewear: "none" });
    expect(withAccessory(base, "none")).toMatchObject({ hat: "none", eyewear: "none" });
    for (const accessory of BOT_ACCESSORIES) expect(accessoryOf(withAccessory(base, accessory))).toBe(accessory);
  });

  it("trims the default look to one accessory", () => {
    for (let i = 0; i < 200; i += 1) {
      const look = defaultBot(`wallet-${i}`);
      expect(look.hat === "none" || look.eyewear === "none").toBe(true);
    }
  });

  it("rejects stored looks it does not know", () => {
    expect(parseBotLook(null)).toBeNull();
    expect(parseBotLook("{")).toBeNull();
    expect(parseBotLook(JSON.stringify({ shape: "dragon", color: "#ff6a00" }))).toBeNull();
    expect(parseBotLook(JSON.stringify({ shape: "circle", color: "red" }))).toBeNull();
    expect(parseBotLook(JSON.stringify({ shape: "star", color: "#3b82f6", hat: "crown", eyewear: "shades" }))).toEqual({
      shape: "star", color: "#3b82f6", hat: "crown", eyewear: "none",
    });
    expect(parseBotLook(JSON.stringify({ shape: "star", color: "#3b82f6", hat: "wizard" }))).toMatchObject({ hat: "none" });
  });
});
