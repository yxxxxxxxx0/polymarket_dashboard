import WebSocket from "ws";
import { config } from "../config.js";
import type { OrderBook, PriceLevel } from "../types/domain.js";
import { recordChartPoint } from "./chartService.js";
import { calculateRawOfi, calculateRollingOfiWindow, trimOfiObservations, type OfiObservation, type RollingOfiConfig } from "./ofiLogic.js";
import { assertConfiguredToken, configuredTokenIds } from "./singleMarketService.js";

const books = new Map<string, OrderBook>();
const ofiObservations = new Map<string, OfiObservation[]>();
let socket: WebSocket | null = null;
let heartbeat: NodeJS.Timeout | null = null;
let reconnectTimer: NodeJS.Timeout | null = null;
const subscribedTokenIds = new Set<string>();
const listeners = new Set<(book: OrderBook) => void>();

function ofiConfig(windowSeconds: number): RollingOfiConfig {
  return {
    windowSeconds,
    strongBuyThreshold: config.OFI_STRONG_BUY_THRESHOLD,
    buyThreshold: config.OFI_BUY_THRESHOLD,
    sellThreshold: config.OFI_SELL_THRESHOLD,
    strongSellThreshold: config.OFI_STRONG_SELL_THRESHOLD
  };
}

function emptyOfi() {
  return {
    rawOfi: 0,
    rollingRawOfi30s: 0,
    rollingOfi30s: 0,
    signal30s: "Neutral" as const,
    rollingRawOfi2m: 0,
    rollingOfi2m: 0,
    signal2m: "Neutral" as const,
    windows: {
      "30s": {
        rollingRawOfi: 0,
        rollingOfi: 0,
        windowSeconds: config.OFI_ROLLING_WINDOW_30_SECONDS,
        signal: "Neutral" as const
      },
      "2m": {
        rollingRawOfi: 0,
        rollingOfi: 0,
        windowSeconds: config.OFI_ROLLING_WINDOW_2M_SECONDS,
        signal: "Neutral" as const
      }
    }
  };
}

function emptyBook(tokenId: string): OrderBook {
  return {
    tokenId,
    bids: [],
    asks: [],
    bestBid: null,
    bestAsk: null,
    spread: null,
    midpoint: null,
    depthImbalance: null,
    lastTradePrice: null,
    lastUpdateTime: null,
    ofi: emptyOfi()
  };
}

function sortLevels(levels: PriceLevel[], side: "bids" | "asks"): PriceLevel[] {
  return [...levels]
    .filter((level) => level.size > 0)
    .sort((a, b) => (side === "bids" ? b.price - a.price : a.price - b.price));
}

function finalize(book: OrderBook): OrderBook {
  const bids = sortLevels(book.bids, "bids");
  const asks = sortLevels(book.asks, "asks");
  const bestBid = bids[0]?.price ?? null;
  const bestAsk = asks[0]?.price ?? null;
  const bidDepth = bids.slice(0, 10).reduce((sum, level) => sum + level.size, 0);
  const askDepth = asks.slice(0, 10).reduce((sum, level) => sum + level.size, 0);
  return {
    ...book,
    bids,
    asks,
    bestBid,
    bestAsk,
    spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
    midpoint: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
    depthImbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null,
    lastUpdateTime: new Date().toISOString()
  };
}

function toLevels(levels: unknown): PriceLevel[] {
  if (!Array.isArray(levels)) return [];
  return levels.map((level) => ({
    price: Number(level.price),
    size: Number(level.size)
  })).filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size));
}

function upsertLevel(levels: PriceLevel[], price: number, size: number): PriceLevel[] {
  const next = levels.filter((level) => level.price !== price);
  if (size > 0) next.push({ price, size });
  return next;
}

function withOfi(book: OrderBook): OrderBook {
  const previous = books.get(book.tokenId) ?? null;
  const now = Date.now();
  const rawOfi = calculateRawOfi(previous, book);
  const observation: OfiObservation = {
    timestamp: now,
    rawOfi,
    bidDepth: book.bids.slice(0, 10).reduce((sum, level) => sum + level.size, 0),
    askDepth: book.asks.slice(0, 10).reduce((sum, level) => sum + level.size, 0),
    bestBid: book.bestBid,
    bestAsk: book.bestAsk
  };
  const maxWindowSeconds = Math.max(config.OFI_ROLLING_WINDOW_30_SECONDS, config.OFI_ROLLING_WINDOW_2M_SECONDS);
  const observations = trimOfiObservations([...(ofiObservations.get(book.tokenId) ?? []), observation], now, maxWindowSeconds);
  const window30s = calculateRollingOfiWindow(observations, now, ofiConfig(config.OFI_ROLLING_WINDOW_30_SECONDS));
  const window2m = calculateRollingOfiWindow(observations, now, ofiConfig(config.OFI_ROLLING_WINDOW_2M_SECONDS));

  ofiObservations.set(book.tokenId, observations);
  return {
    ...book,
    ofi: {
      rawOfi,
      rollingRawOfi30s: window30s.rollingRawOfi,
      rollingOfi30s: window30s.rollingOfi,
      signal30s: window30s.signal,
      rollingRawOfi2m: window2m.rollingRawOfi,
      rollingOfi2m: window2m.rollingOfi,
      signal2m: window2m.signal,
      windows: {
        "30s": window30s,
        "2m": window2m
      }
    }
  };
}

function publish(book: OrderBook): OrderBook {
  if (!subscribedTokenIds.has(book.tokenId)) return book;
  const next = withOfi(book);
  books.set(next.tokenId, next);
  recordChartPoint(next);
  for (const listener of listeners) listener(next);
  return next;
}

export function updateCachedOrderBook(book: OrderBook): OrderBook {
  const finalized = finalize(book);
  return publish(finalized);
}

function handleMessage(raw: WebSocket.RawData) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString());
  } catch {
    return;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];

  for (const message of messages) {
    if (message.event_type === "book") {
      if (!subscribedTokenIds.has(String(message.asset_id))) continue;
      publish(finalize({
        ...emptyBook(String(message.asset_id)),
        market: message.market,
        bids: toLevels(message.bids),
        asks: toLevels(message.asks)
      }));
    }

    if (message.event_type === "price_change" && Array.isArray(message.price_changes)) {
      for (const change of message.price_changes) {
        const tokenId = String(change.asset_id);
        if (!subscribedTokenIds.has(tokenId)) continue;
        const current = books.get(tokenId) ?? emptyBook(tokenId);
        const side = String(change.side).toUpperCase() === "BUY" ? "bids" : "asks";
        const updated = finalize({
          ...current,
          market: message.market ?? current.market,
          [side]: upsertLevel(current[side], Number(change.price), Number(change.size))
        });
        publish(updated);
      }
    }

    if (message.event_type === "last_trade_price") {
      const tokenId = String(message.asset_id);
      if (!subscribedTokenIds.has(tokenId)) continue;
      const current = books.get(tokenId) ?? emptyBook(tokenId);
      publish(finalize({ ...current, market: message.market, lastTradePrice: Number(message.price) }));
    }

    if (message.event_type === "best_bid_ask") {
      const tokenId = String(message.asset_id);
      if (!subscribedTokenIds.has(tokenId)) continue;
      const current = books.get(tokenId) ?? emptyBook(tokenId);
      publish(finalize({
        ...current,
        market: message.market,
        bids: upsertLevel(current.bids, Number(message.best_bid), current.bids[0]?.size ?? 0.01),
        asks: upsertLevel(current.asks, Number(message.best_ask), current.asks[0]?.size ?? 0.01)
      }));
    }
  }
}

function marketWsUrl() {
  return `${config.POLYMARKET_WS_HOST.replace(/\/$/, "")}/ws/market`;
}

export function ensureMarketSocket() {
  if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  socket = new WebSocket(marketWsUrl());
  socket.on("open", () => {
    const assets_ids = [...subscribedTokenIds];
    if (assets_ids.length > 0) socket?.send(JSON.stringify({ type: "market", assets_ids }));
    heartbeat = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("{}"), 10_000);
  });
  socket.on("message", handleMessage);
  socket.on("error", (error) => {
    console.error("Polymarket market WebSocket error", error);
    socket?.close();
  });
  socket.on("close", () => {
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    reconnectTimer = setTimeout(ensureMarketSocket, 2_000);
  });
}

export function subscribeTokens(tokenIds: string[]) {
  for (const tokenId of tokenIds) subscribedTokenIds.add(assertConfiguredToken(tokenId));
  ensureMarketSocket();
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ operation: "subscribe", assets_ids: tokenIds }));
  }
}

export function getCachedOrderBook(tokenId: string): OrderBook {
  assertConfiguredToken(tokenId);
  return books.get(tokenId) ?? emptyBook(tokenId);
}

export function orderBookAgeMs(book: OrderBook): number | null {
  if (!book.lastUpdateTime) return null;
  const timestamp = Date.parse(book.lastUpdateTime);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, Date.now() - timestamp);
}

export function hasFreshOrderBook(tokenId: string, maxAgeMs = config.ORDERBOOK_STALE_MS): boolean {
  const age = orderBookAgeMs(getCachedOrderBook(tokenId));
  return age !== null && age <= maxAgeMs;
}

export function getCachedOfi(tokenId: string) {
  assertConfiguredToken(tokenId);
  return getCachedOrderBook(tokenId).ofi ?? emptyBook(tokenId).ofi;
}

export function onOrderBookUpdate(listener: (book: OrderBook) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function startConfiguredOrderBooks() {
  subscribedTokenIds.clear();
  configuredTokenIds().forEach((tokenId, index) => {
    subscribedTokenIds.add(tokenId);
    books.set(tokenId, emptyBook(tokenId));
    ofiObservations.set(tokenId, []);
  });
  ensureMarketSocket();
}

export function resetConfiguredOrderBooks() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = null;
  }
  if (socket) {
    socket.removeAllListeners();
    socket.close();
    socket = null;
  }
  books.clear();
  ofiObservations.clear();
  startConfiguredOrderBooks();
}
