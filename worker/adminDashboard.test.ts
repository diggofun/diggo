import { describe, expect, beforeEach, it } from "vitest";
import { adminDashboard, resetAdminDashboardCache } from "./adminDashboard";
import type { RuntimeEnv } from "./env";
import type { AdminDashboardPayload } from "../shared/adminDashboard";

const OWNER = "GyGjx2nsgG2wDbUESGTw8aHndXh6b8d2znhZPqWSdwcH";

class MissingTablesDb {
  prepare(): { bind: () => unknown; first: () => Promise<null>; all: () => Promise<{ results: [] }> } {
    const statement = {
      bind: () => statement,
      first: async () => {
        throw new Error("no such table: optional_dashboard_table");
      },
      all: async () => {
        throw new Error("no such table: optional_dashboard_table");
      },
    };
    return statement;
  }
}

class SessionCache {
  constructor(private readonly wallet: string) {}

  async get(key: string): Promise<string | null> {
    return key === `auth:session:dashboard-session` ? this.wallet : null;
  }
}

function environment(wallet: string): RuntimeEnv {
  return {
    ADMIN_WALLETS: OWNER,
    DB: new MissingTablesDb(),
    TOKEN_CACHE: new SessionCache(wallet),
    SOLANA_CLUSTER: "devnet",
  } as unknown as RuntimeEnv;
}

function request(session: string | null): Request {
  return new Request("https://diggo.fun/api/admin/dashboard", {
    headers: session ? { authorization: `Bearer ${session}` } : {},
  });
}

describe("admin dashboard", () => {
  beforeEach(() => resetAdminDashboardCache());

  it("rejects a signed session for a wallet outside the allowlist", async () => {
    const response = await adminDashboard(request("dashboard-session"), environment("11111111111111111111111111111111"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "Admin session required" });
  });

  it("returns the typed payload for an admin while optional tables are missing", async () => {
    const response = await adminDashboard(request("dashboard-session"), environment(OWNER));
    const payload = (await response.json()) as AdminDashboardPayload;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("private");
    expect(payload).toMatchObject({
      actor: OWNER,
      chainMode: expect.any(String),
      cluster: "devnet",
      launches: { total: null, last24h: null, last7d: null },
      graduated: { total: null, last24h: null, last7d: null },
      tradingVolume: {
        all: { sol: null },
        last24h: { sol: null },
        last7d: { sol: null },
      },
      fees: {
        partnerTrading: { accruedSol: null, claimableSol: null },
        creation: { accruedSol: null, claimableSol: null },
      },
      claims: { pending: null, paid: null },
      players: { total: null, last24h: null, last7d: null },
      crews: { active24h: null },
      referrals: { invited: null, qualified: null, oreCredited: null },
      jobs: {
        indexer: { lastSuccessfulAt: null, lastError: null },
        vaultSweep: { lastSuccessfulAt: null, lastError: null },
        cron: { lastSuccessfulAt: null, lastError: null },
      },
    });
    expect(payload.vault).toMatchObject({ address: null, solBalance: null, tokenBalances: [] });
    expect(payload.addresses.treasury).toBeNull();
  });
});
