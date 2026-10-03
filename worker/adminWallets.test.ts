import { describe, expect, it } from "vitest";
import type { RuntimeEnv } from "./env";
import { BUILT_IN_ADMIN_WALLETS, adminWallets, isAdminWallet } from "./admin";
import { isBase58Address } from "./http";

const OWNER = "6HHEkX5MxsoQwyCJZHvLnewmnsaw19vGT9Y8jhqH7GuJ";
const OTHER = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

describe("admin wallets", () => {
  it("lists only valid wallet addresses as built-in admins", () => {
    expect(BUILT_IN_ADMIN_WALLETS).toContain(OWNER);
    for (const wallet of BUILT_IN_ADMIN_WALLETS) expect(isBase58Address(wallet)).toBe(true);
  });

  it("keeps the built-in admin without the secret and adds the secret's wallets", () => {
    expect(isAdminWallet({} as RuntimeEnv, OWNER)).toBe(true);
    expect(isAdminWallet({} as RuntimeEnv, OTHER)).toBe(false);
    const env = { ADMIN_WALLETS: ` ${OTHER}, ${OWNER},` } as unknown as RuntimeEnv;
    expect(adminWallets(env)).toEqual([OWNER, OTHER]);
    expect(isAdminWallet(env, OTHER)).toBe(true);
  });
});
