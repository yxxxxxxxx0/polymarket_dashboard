import { OrderSide, TradeMode } from "@prisma/client";
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { asyncHandler, requireString } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { enterMarketProfile } from "../services/activeMarketService.js";
import { getLiveTrades } from "../services/clobService.js";
import { accountSummary } from "../services/accountService.js";
import { cancelMarketOrders, cancelOrder, listOpenOrders, listPositions, placeOrder } from "../services/tradingService.js";
import { assertConfiguredMarket, assertConfiguredToken, marketScope, outcomeForToken } from "../services/singleMarketService.js";

export const tradingRouter = Router();

const orderSchema = z.object({
  marketId: z.string().optional(),
  conditionId: z.string().optional(),
  tokenId: z.string().min(1),
  outcomeName: z.string().optional(),
  price: z.coerce.number().positive(),
  size: z.coerce.number().positive(),
  tradeMode: z.nativeEnum(TradeMode).default(TradeMode.PAPER)
});

function selectRequestProfile(req: Request) {
  const rawUrl = `${req.originalUrl} ${req.url}`;
  enterMarketProfile(rawUrl.includes("profile=mlb") ? "mlb" : req.body?.profile);
}

tradingRouter.get("/positions", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  res.json(await listPositions());
}));

tradingRouter.get("/account", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  res.json(await accountSummary({ force: req.query.refresh === "1" }));
}));

tradingRouter.get("/open-orders", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const tradeMode = req.query.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : undefined;
  res.json(await listOpenOrders(tradeMode));
}));

tradingRouter.post("/orders/buy", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const body = orderSchema.parse(req.body);
  const { marketId, conditionId } = marketScope();
  assertConfiguredMarket(body.marketId || marketId);
  assertConfiguredToken(body.tokenId);
  res.json(await placeOrder({ ...body, marketId, conditionId, outcomeName: body.outcomeName ?? outcomeForToken(body.tokenId), side: OrderSide.BUY }));
}));

tradingRouter.post("/orders/sell", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const body = orderSchema.parse(req.body);
  const { marketId, conditionId } = marketScope();
  assertConfiguredMarket(body.marketId || marketId);
  assertConfiguredToken(body.tokenId);
  res.json(await placeOrder({ ...body, marketId, conditionId, outcomeName: body.outcomeName ?? outcomeForToken(body.tokenId), side: OrderSide.SELL, closeOnly: true }));
}));

tradingRouter.post("/orders/cancel", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const orderId = requireString(req.body.orderId, "orderId");
  const tradeMode = req.body.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER;
  res.json(await cancelOrder(orderId, tradeMode));
}));

tradingRouter.post("/orders/cancel-market", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const marketId = assertConfiguredMarket(req.body.marketId ? requireString(req.body.marketId, "marketId") : marketScope().marketId);
  const tradeMode = req.body.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER;
  res.json(await cancelMarketOrders(marketId, tradeMode));
}));

tradingRouter.get("/trades", asyncHandler(async (_req, res) => {
  selectRequestProfile(_req);
  if (_req.query.tradeMode === TradeMode.LIVE) {
    res.json(await getLiveTrades());
    return;
  }
  res.json(await prisma.tradeLog.findMany({ orderBy: { createdAt: "desc" } }));
}));
