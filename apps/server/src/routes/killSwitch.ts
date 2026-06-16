import { OrderSide, StopLossStatus, TradeMode } from "@prisma/client";
import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { marketScope } from "../services/singleMarketService.js";
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
      closeResults.push(await placeOrder({
        marketId: position.marketId,
        conditionId: position.conditionId ?? undefined,
        tokenId: position.tokenId,
        outcomeName: position.outcomeName,
        side: OrderSide.SELL,
        price: position.currentPrice ?? position.entryPrice,
        size: position.size,
        tradeMode,
        closeOnly: true
      }));
    }
  }

  res.json({ disabled, cancelResults, closeResults });
}));
