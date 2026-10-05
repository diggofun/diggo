import { describe, expect, it } from "vitest";
import { telegramPlayTarget } from "./push";

describe("Telegram /start links", () => {
  it("opens a mine or a referral inside the Mini App", () => {
    expect(telegramPlayTarget("m_So11111111111111111111111111111111111111112")?.url).toBe("https://diggo.fun/m/So11111111111111111111111111111111111111112");
    expect(telegramPlayTarget("r_jurek")?.url).toBe("https://diggo.fun/r/jurek");
  });

  it("leaves alert link codes and junk alone", () => {
    expect(telegramPlayTarget("ABCD1234")).toBeNull();
    expect(telegramPlayTarget("m_not-a-mint")).toBeNull();
    expect(telegramPlayTarget("r_<script>")).toBeNull();
    expect(telegramPlayTarget("")).toBeNull();
  });
});
