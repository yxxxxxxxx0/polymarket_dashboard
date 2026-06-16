import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import { config } from "../config.js";
import { currentMarketProfile, withMarketProfile } from "../services/activeMarketService.js";
import { fetchMarketMetadata } from "../services/marketMetadataService.js";
import { getCachedOrderBook, onOrderBookUpdate, subscribeTokens } from "../services/orderbookCache.js";
import { configuredMarket } from "../services/singleMarketService.js";
import type { OrderBook } from "../types/domain.js";

type ClientState = {
  id: number;
  ws: WebSocket;
  profile: string;
  orderbookTokenIds: Set<string>;
  marketStats: boolean;
  isAlive: boolean;
};

type ClientMessage =
  | { type: "subscribe_orderbook"; tokenIds?: string[]; profile?: string }
  | { type: "unsubscribe_orderbook"; tokenIds?: string[] }
  | { type: "subscribe_market_stats"; profile?: string }
  | { type: "unsubscribe_market_stats" }
  | { type: "ping" };

let nextClientId = 1;
let wss: WebSocketServer | null = null;
const clients = new Set<ClientState>();

function send(client: ClientState, payload: unknown) {
  if (client.ws.readyState !== WebSocket.OPEN) return;
  client.ws.send(JSON.stringify(payload));
}

function parseProfile(value: unknown) {
  return withMarketProfile(value, () => currentMarketProfile());
}

function safeHandle(client: ClientState, callback: () => void | Promise<void>) {
  Promise.resolve()
    .then(callback)
    .catch((error) => {
      console.error("Dashboard WebSocket handler error", error);
      send(client, {
        type: "error",
        message: error instanceof Error ? error.message : "WebSocket handler failed"
      });
    });
}

async function sendMarketStats(client: ClientState) {
  await withMarketProfile(client.profile, async () => {
    const market = configuredMarket();
    const metadata = await fetchMarketMetadata(market.id);
    send(client, {
      type: "market_stats",
      marketId: market.id,
      volume: metadata?.volume ?? market.volume,
      liquidity: metadata?.liquidity ?? market.liquidity,
      updatedAt: new Date().toISOString()
    });
  });
}

function sendInitialOrderBooks(client: ClientState, tokenIds: string[]) {
  withMarketProfile(client.profile, () => {
    subscribeTokens(tokenIds);
    for (const tokenId of tokenIds) {
      send(client, { type: "orderbook", book: getCachedOrderBook(tokenId) });
    }
  });
}

function handleClientMessage(client: ClientState, raw: WebSocket.RawData) {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw.toString()) as ClientMessage;
  } catch {
    send(client, { type: "error", message: "Invalid JSON message" });
    return;
  }

  if (message.type === "ping") {
    send(client, { type: "pong", ts: Date.now() });
    return;
  }

  if (message.type === "subscribe_orderbook") {
    safeHandle(client, () => {
      client.profile = parseProfile(message.profile ?? client.profile);
      const tokenIds = [...new Set((message.tokenIds ?? []).filter(Boolean).map(String))];
      for (const tokenId of tokenIds) client.orderbookTokenIds.add(tokenId);
      send(client, { type: "subscribed_orderbook", tokenIds, profile: client.profile });
      sendInitialOrderBooks(client, tokenIds);
      console.log(`[ws] client ${client.id} subscribed orderbook`, { profile: client.profile, tokenIds });
    });
    return;
  }

  if (message.type === "unsubscribe_orderbook") {
    for (const tokenId of message.tokenIds ?? []) client.orderbookTokenIds.delete(String(tokenId));
    send(client, { type: "unsubscribed_orderbook", tokenIds: message.tokenIds ?? [] });
    return;
  }

  if (message.type === "subscribe_market_stats") {
    safeHandle(client, async () => {
      client.profile = parseProfile(message.profile ?? client.profile);
      client.marketStats = true;
      send(client, { type: "subscribed_market_stats", profile: client.profile });
      await sendMarketStats(client);
      console.log(`[ws] client ${client.id} subscribed market_stats`, { profile: client.profile });
    });
    return;
  }

  if (message.type === "unsubscribe_market_stats") {
    client.marketStats = false;
    send(client, { type: "unsubscribed_market_stats" });
    return;
  }

  send(client, { type: "error", message: "Unknown WebSocket message type" });
}

function broadcastOrderBook(book: OrderBook) {
  for (const client of clients) {
    if (!client.orderbookTokenIds.has(book.tokenId)) continue;
    send(client, { type: "orderbook", book });
  }
}

export function attachDashboardWebSocket(server: http.Server) {
  if (wss) return wss;
  wss = new WebSocketServer({ server, path: "/ws/dashboard" });

  wss.on("connection", (ws) => {
    const client: ClientState = {
      id: nextClientId++,
      ws,
      profile: "football",
      orderbookTokenIds: new Set(),
      marketStats: false,
      isAlive: true
    };
    clients.add(client);
    console.log(`[ws] client ${client.id} connected`);

    ws.on("pong", () => {
      client.isAlive = true;
    });
    ws.on("message", (raw) => handleClientMessage(client, raw));
    ws.on("close", () => {
      clients.delete(client);
      console.log(`[ws] client ${client.id} disconnected`);
    });
    ws.on("error", (error) => {
      console.error(`[ws] client ${client.id} error`, error);
      clients.delete(client);
    });

    send(client, { type: "connected", ts: Date.now() });
  });

  onOrderBookUpdate(broadcastOrderBook);

  setInterval(() => {
    for (const client of clients) {
      if (client.ws.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        continue;
      }
      if (!client.isAlive) {
        client.ws.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.ws.ping();
    }
  }, 15_000);

  setInterval(() => {
    for (const client of clients) {
      if (!client.marketStats) continue;
      void sendMarketStats(client).catch((error) => console.error("Market stats WebSocket error", error));
    }
  }, config.MARKET_STATS_REFRESH_MS);

  return wss;
}
