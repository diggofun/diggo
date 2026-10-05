import { describe, expect, it } from "vitest";
import { isTelegramLaunch, startTarget, telegramStartParam } from "./telegram";

describe("Telegram Mini App launch", () => {
  it("recognises a Telegram launch from its URL parameters", () => {
    expect(isTelegramLaunch("https://diggo.fun/mine#tgWebAppData=abc&tgWebAppVersion=8.0")).toBe(true);
    expect(isTelegramLaunch("https://diggo.fun/?tgWebAppStartParam=m_x&tgWebAppVersion=8.0")).toBe(true);
    expect(isTelegramLaunch("https://diggo.fun/mine")).toBe(false);
  });

  it("reads the direct-link parameter from the query or the hash", () => {
    expect(telegramStartParam("https://diggo.fun/?tgWebAppStartParam=r_jurek")).toBe("r_jurek");
    expect(telegramStartParam("https://diggo.fun/#tgWebAppStartParam=m_abc&tgWebAppData=x")).toBe("m_abc");
    expect(telegramStartParam("https://diggo.fun/?tgWebAppStartParam=<script>")).toBeNull();
    expect(telegramStartParam("https://diggo.fun/")).toBeNull();
  });

  it("maps m_ to a mine link and r_ to a referral", () => {
    expect(startTarget("m_So11111111111111111111111111111111111111112")).toEqual({ mine: "So11111111111111111111111111111111111111112" });
    expect(startTarget("r_jurek")).toEqual({ referral: "jurek" });
    expect(startTarget("other")).toBeNull();
    expect(startTarget(null)).toBeNull();
  });
});
