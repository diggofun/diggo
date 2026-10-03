import { describe, expect, it } from "vitest";
import { BOT_ACCESSORIES, BOT_COLORS, BOT_SHAPE_NAMES, parseProfileBot } from "./profileBot";

describe("parseProfileBot", () => {
  it("accepts every shape, colour and accessory", () => {
    for (const shape of BOT_SHAPE_NAMES) expect(parseProfileBot({ shape, color: "#ff6a00", accessory: "none" })?.shape).toBe(shape);
    for (const color of BOT_COLORS) expect(parseProfileBot({ shape: "circle", color, accessory: "none" })?.color).toBe(color);
    for (const accessory of BOT_ACCESSORIES) expect(parseProfileBot({ shape: "circle", color: "#ff6a00", accessory })?.accessory).toBe(accessory);
  });

  it("normalizes colour case and a missing accessory", () => {
    expect(parseProfileBot({ shape: "star", color: "#FF6A00" })).toEqual({ shape: "star", color: "#ff6a00", accessory: "none" });
  });

  it("rejects anything outside the lists, including two accessories", () => {
    for (const value of [
      null, "circle", [], {},
      { shape: "dragon", color: "#ff6a00" },
      { shape: "circle", color: "red" },
      { shape: "circle", color: "#ff6a01" },
      { shape: "circle", color: "#ff6a00", accessory: "hat:wizard" },
      { shape: "circle", color: "#ff6a00", accessory: "hat:crown,eyewear:shades" },
      { shape: "circle", color: "#ff6a00", accessory: ["hat:crown", "eyewear:shades"] },
      { shape: "__proto__", color: "#ff6a00" },
    ]) {
      expect(parseProfileBot(value)).toBeNull();
    }
  });
});
