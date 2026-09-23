/**
 * Per-mine Durable Object: keeps recent trades in SQLite and streams them to WebSocket clients.
 */
import { DurableObject } from "cloudflare:workers";
import type { MarketSnapshot, MarketTrade } from "../shared/types";
import type { RuntimeEnv } from "./env";
import { apiError } from "./http";

export class TokenMarket extends DurableObject<RuntimeEnv> {
  constructor(ctx: DurableObjectState, env: RuntimeEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS trades (
          signature TEXT PRIMARY KEY,
          side TEXT NOT NULL,
          price_sol REAL NOT NULL DEFAULT 0,
          price_usd REAL NOT NULL,
          amount REAL NOT NULL,
          timestamp INTEGER NOT NULL
        )
      `);
      const columns = this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(trades)").toArray();
      if (!columns.some((column) => column.name === "price_sol")) {
        this.ctx.storage.sql.exec("ALTER TABLE trades ADD COLUMN price_sol REAL NOT NULL DEFAULT 0");
      }
    });
  }

  async applyTrade(trade: MarketTrade): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO trades (signature, side, price_sol, price_usd, amount, timestamp) VALUES (?, ?, ?, ?, ?, ?)",
      trade.signature,
      trade.side,
      trade.priceSol,
      trade.priceUsd,
      trade.amount,
      trade.timestamp,
    );
    const message = JSON.stringify({ type: "trade", trade });
    for (const socket of this.ctx.getWebSockets()) socket.send(message);
  }

  async snapshot(): Promise<MarketSnapshot> {
    const trades = this.ctx.storage.sql
      .exec<{
        signature: string;
        side: "buy" | "sell";
        price_sol: number;
        price_usd: number;
        amount: number;
        timestamp: number;
      }>("SELECT * FROM trades ORDER BY timestamp DESC LIMIT 200")
      .toArray();
    const recentTrades = trades.map((trade) => ({
      signature: trade.signature,
      side: trade.side,
      priceSol: trade.price_sol,
      priceUsd: trade.price_usd,
      amount: trade.amount,
      timestamp: trade.timestamp,
    }));
    return {
      mint: this.ctx.id.toString(),
      priceUsd: recentTrades[0]?.priceUsd ?? 0,
      volume24h: recentTrades.reduce((sum, trade) => sum + trade.amount * trade.priceUsd, 0),
      lastTradeAt: recentTrades[0]?.timestamp ?? null,
      recentTrades,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("upgrade") !== "websocket") return apiError("WebSocket required", 426);
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "snapshot", snapshot: await this.snapshot() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  webSocketMessage(socket: WebSocket, message: ArrayBuffer | string): void {
    if (message === "ping") socket.send("pong");
  }
}
