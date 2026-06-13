import { Router } from "express";
import type { Request } from "express";
import { asyncHandler, requireString } from "../lib/http.js";
import { config } from "../config.js";
import { enterMarketProfile } from "../services/activeMarketService.js";
import { getChart, type ChartInterval, type ChartSource } from "../services/chartService.js";
import { fetchOrderBook } from "../services/clobService.js";
import { fetchMarketMetadata } from "../services/marketMetadataService.js";
import { getCachedOrderBook, onOrderBookUpdate, subscribeTokens } from "../services/orderbookCache.js";
import { configuredMarket, assertConfiguredToken } from "../services/singleMarketService.js";

export const singleMarketRouter = Router();
export const streamRouter = Router();

const intervals = new Set(["1m", "5m", "15m", "1h", "1d"]);
const sources = new Set(["last_trade_price", "midpoint_price", "best_bid", "best_ask"]);

function selectRequestProfile(req: Request) {
  const rawUrl = `${req.originalUrl} ${req.url}`;
  enterMarketProfile(rawUrl.includes("profile=mlb") ? "mlb" : req.body?.profile);
}

singleMarketRouter.get("/market", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const market = configuredMarket();
  const metadata = await fetchMarketMetadata(market.id);
  res.json(metadata ? { ...market, volume: metadata.volume, liquidity: metadata.liquidity, raw: metadata.raw } : market);
}));

singleMarketRouter.get("/chart", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const tokenId = assertConfiguredToken(requireString(req.query.tokenId, "tokenId"));
  const intervalParam = String(req.query.interval ?? "1m");
  const sourceParam = String(req.query.source ?? "midpoint_price");
  const interval = (intervals.has(intervalParam) ? intervalParam : "1m") as ChartInterval;
  const source = (sources.has(sourceParam) ? sourceParam : "midpoint_price") as ChartSource;
  res.json(getChart(tokenId, interval, source));
}));

singleMarketRouter.get("/orderbook/:tokenId", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const tokenId = assertConfiguredToken(requireString(req.params.tokenId, "tokenId"));
  res.json(await fetchOrderBook(tokenId));
}));

streamRouter.get("/orderbook", (req, res) => {
  selectRequestProfile(req);
  const tokenId = assertConfiguredToken(requireString(req.query.tokenId, "tokenId"));
  subscribeTokens([tokenId]);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const send = (payload: unknown) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  send(getCachedOrderBook(tokenId));
  const dispose = onOrderBookUpdate((book) => {
    if (book.tokenId === tokenId) send(book);
  });

  req.on("close", dispose);
});

streamRouter.get("/market-stats", (req, res) => {
  selectRequestProfile(req);
  const market = configuredMarket();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  });

  const send = async () => {
    const metadata = await fetchMarketMetadata(market.id);
    res.write(`data: ${JSON.stringify({
      marketId: market.id,
      volume: metadata?.volume ?? market.volume,
      liquidity: metadata?.liquidity ?? market.liquidity,
      updatedAt: new Date().toISOString()
    })}\n\n`);
  };

  void send();
  const interval = setInterval(() => {
    void send().catch((error) => {
      console.error("Market stats stream error", error);
    });
  }, config.MARKET_STATS_REFRESH_MS);

  req.on("close", () => clearInterval(interval));
});
