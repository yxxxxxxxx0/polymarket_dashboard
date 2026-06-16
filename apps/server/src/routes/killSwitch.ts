import { OrderSide, StopLossStatus, TradeMode } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { marketScope } from "../services/singleMarketService.js";
import { config } from "../config.js";
import { fetchOrderBook } from "../services/clobService.js";
import { cancelMarketOrders, placeOrder } from "../services/tradingService.js";

export const killSwitchRouter = Router();

killSwitchRouter.post("/", asyncHandler(async (req, res) => {
  const tradeMode = req.body.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER;
  const closePositions = Boolean(req.body.closePositionsConfirmed);
  const { marketId } = marketScope();

  const disabled = await prisma.stopLossRule.updateMany({
    where: { enabled: true, marketId },
    data: { enabled: false, status: StopLossStatus.DISABLED }
  });

  const openOrders = await prisma.openOrder.findMany({ where: { status: "OPEN", marketId } });
  const marketIds = [...new Set(openOrders.map((order) => order.marketId))];
  const cancelResults = [];
  for (const scopedMarketId of marketIds) {
    cancelResults.push(await cancelMarketOrders(scopedMarketId, tradeMode));
  }

  const closeResults = [];
  if (closePositions) {
    const positions = await prisma.position.findMany({ where: { marketId, size: { gt: 0 } } });
    for (const position of positions) {
      const book = await fetchOrderBook(position.tokenId, { force: true, maxAgeMs: config.ORDERBOOK_STALE_MS_FAST });
      if (book.bestBid === null) {
        closeResults.push({ tokenId: position.tokenId, skipped: true, reason: "No fresh best bid for panic close" });
        continue;
      }
      const price = Math.max(0.01, book.bestBid - Math.max(0.05, config.ORDERBOOK_STALE_MS_FAST / 10000));
      closeResults.push(await placeOrder({
        marketId: position.marketId,
        conditionId: position.conditionId ?? undefined,
        tokenId: position.tokenId,
        outcomeName: position.outcomeName,
        side: OrderSide.SELL,
        price,
        size: position.size,
        tradeMode,
        closeOnly: true,
        source: "panic-close"
      }));
    }
  }

  res.json({ disabled, cancelResults, closeResults });
}));
