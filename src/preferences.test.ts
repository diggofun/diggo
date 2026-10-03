import { describe, expect, it } from "vitest";
import { BOT_EYEWEAR, BOT_HATS, BOT_SHAPES } from "./components/Bot";
import { BOT_SHAPE_NAMES } from "../shared/profileBot";
import { BOT_ACCESSORIES, resolveTheme, accessoryOf, defaultBot, lookOf, oneAccessory, profileBotOf, withAccessory } from "./preferences";

describe("profile bot preferences", () => {
  it("draws every shape the Worker accepts, and no other", () => {
    expect(Object.keys(BOT_SHAPES)).toEqual([...BOT_SHAPE_NAMES]);
  });

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

  it("round-trips a look through the stored form", () => {
    for (const accessory of BOT_ACCESSORIES) {
      const look = withAccessory({ shape: "ghost", color: "#3b82f6", hat: "none", eyewear: "none" }, accessory);
      expect(lookOf(profileBotOf(look))).toEqual(look);
    }
  });

  it("trims the default look to one accessory", () => {
    for (let i = 0; i < 200; i += 1) {
      const look = defaultBot(`wallet-${i}`);
      expect(look.hat === "none" || look.eyewear === "none").toBe(true);
    }
  });

  it("follows the device unless a theme is picked", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });
});
