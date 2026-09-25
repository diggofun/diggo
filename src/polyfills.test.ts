import { describe, expect, it } from "vitest";
import { Buffer } from "buffer";
import { deriveMeteoraPoolAddresses } from "../shared/meteora";
import { installBufferGlobal } from "./polyfills";

describe("browser Buffer polyfill", () => {
  it("installs Buffer only where the runtime has none", () => {
    const browserLike: { Buffer?: unknown } = {};
    installBufferGlobal(browserLike);
    expect(browserLike.Buffer).toBe(Buffer);
    const existing = { Buffer: "native" };
    installBufferGlobal(existing);
    expect(existing.Buffer).toBe("native");
  });

  it("lets the swap panel derive the real $DIGGO pool with the polyfilled Buffer", () => {
    const pool = deriveMeteoraPoolAddresses("12cens35GKeZH8is6R1gdbJ1faktyLrXgHvHyBB6veb7", "5yxCKEmi1rc5ebKmWdHbzj2pEe7caqS8xqvQh5V8duMF").pool;
    expect(pool).toBe("4g7i7aWVvwnSn6K6VKyvzG5UFf2nFCXgYJ7uJUymhhMB");
  });
});
