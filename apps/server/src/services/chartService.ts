import type { OrderBook } from "../types/domain.js";
import { assertConfiguredToken, configuredTokenIds } from "./singleMarketService.js";

export type ChartInterval = "1m" | "5m" | "15m" | "1h" | "1d";
export type ChartSource = "last_trade_price" | "midpoint_price" | "best_bid" | "best_ask";

export type ChartPoint = {
  tokenId: string;
  ts: number;
  last_trade_price: number;
  midpoint_price: number;
  best_bid: number;
  best_ask: number;
};

const points = new Map<string, ChartPoint[]>();
const maxPoints = 2_000;

export function resetChartPoints(tokenIds: string[] = configuredTokenIds()) {
  points.clear();
  for (const tokenId of tokenIds) points.set(tokenId, []);
}

function clampPrice(value: number) {
  return Math.max(0.01, Math.min(0.99, Number(value.toFixed(4))));
}

function valueFromBook(book: OrderBook, source: ChartSource) {
  if (source === "last_trade_price") return book.lastTradePrice ?? book.midpoint ?? book.bestBid ?? book.bestAsk;
  if (source === "midpoint_price") return book.midpoint;
  if (source === "best_bid") return book.bestBid;
  return book.bestAsk;
}

export function recordChartPoint(book: OrderBook) {
  const midpoint = book.midpoint;
  if (midpoint === null) return;
  const point: ChartPoint = {
    tokenId: book.tokenId,
    ts: Date.now(),
    last_trade_price: valueFromBook(book, "last_trade_price") ?? midpoint,
    midpoint_price: midpoint,
    best_bid: book.bestBid ?? clampPrice(midpoint - 0.01),
    best_ask: book.bestAsk ?? clampPrice(midpoint + 0.01)
  };
  const tokenPoints = points.get(book.tokenId) ?? [];
  tokenPoints.push(point);
  points.set(book.tokenId, tokenPoints.slice(-maxPoints));
}

function intervalMs(interval: ChartInterval) {
  return {
    "1m": 60_000,
    "5m": 300_000,
    "15m": 900_000,
    "1h": 3_600_000,
    "1d": 86_400_000
  }[interval];
}

export function getChart(tokenId: string, interval: ChartInterval, source: ChartSource) {
  assertConfiguredToken(tokenId);
  const bucket = intervalMs(interval);
  const sourcePoints = points.get(tokenId) ?? [];
  const aggregated = new Map<number, { total: number; count: number }>();

  for (const point of sourcePoints) {
    const ts = Math.floor(point.ts / bucket) * bucket;
    const value = point[source];
    const current = aggregated.get(ts) ?? { total: 0, count: 0 };
    current.total += value;
    current.count += 1;
    aggregated.set(ts, current);
  }

  return [...aggregated.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-240)
    .map(([ts, value]) => ({
      ts,
      value: Number((value.total / value.count).toFixed(4))
    }));
}
