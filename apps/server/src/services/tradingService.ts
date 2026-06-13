import { OrderSide, TradeMode } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createLiveOrder, cancelLiveMarketOrders, cancelLiveOrder, getLiveOpenOrders } from "./clobService.js";
import { assertConfiguredMarket, assertConfiguredToken, configuredTokenIds, marketScope, outcomeForToken } from "./singleMarketService.js";
import { assertTradingAllowed } from "./tradingPolicy.js";
import { getAppSettings } from "./settingsService.js";
import { invalidateAccountSummaryCache } from "./accountService.js";
import { HttpError } from "../lib/http.js";

export type OrderInput = {
  marketId: string;
  conditionId?: string;
  tokenId: string;
  outcomeName?: string;
  side: OrderSide;
  price: number;
  size: number;
  tradeMode?: TradeMode;
  closeOnly?: boolean;
  source?: string;
};

const orderLocks = new Set<string>();

function orderLockKey(input: OrderInput, tradeMode: TradeMode) {
  return [tradeMode, input.marketId, input.tokenId, input.side, input.closeOnly ? "close" : "open"].join(":");
}

async function withOrderLock<T>(key: string, fn: () => Promise<T>) {
  if (orderLocks.has(key)) {
    throw new HttpError(409, "An order for this market/token/side is already being submitted");
  }
  orderLocks.add(key);
  try {
    return await fn();
  } finally {
    orderLocks.delete(key);
  }
}

async function placeOrderUnlocked(input: OrderInput, tradeMode: TradeMode) {
  assertConfiguredMarket(input.marketId);
  assertConfiguredToken(input.tokenId);
  await assertTradingAllowed({
    tradeMode,
    action: input.closeOnly || input.side === OrderSide.SELL ? "CLOSE" : "OPEN",
    size: input.size,
    price: input.price
  });

  if (tradeMode === TradeMode.PAPER) {
    const openOrder = await prisma.openOrder.create({
      data: {
        marketId: input.marketId,
        conditionId: input.conditionId,
        tokenId: input.tokenId,
        outcomeName: input.outcomeName ?? outcomeForToken(input.tokenId),
        side: input.side,
        price: input.price,
        size: input.size,
        remainingSize: input.size,
        tradeMode
      }
    });
    invalidateAccountSummaryCache();
    return { paper: true, order: openOrder };
  }

  const response = await createLiveOrder({
    marketId: input.marketId,
    tokenId: input.tokenId,
    side: input.side,
    price: input.price,
    size: input.size
  });
  const exchangeOrderId = response.orderID;

  await prisma.tradeLog.create({
    data: {
      marketId: input.marketId,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      side: input.side,
      price: input.price,
      size: input.size,
      tradeMode,
      source: input.source ?? "manual",
      exchangeOrderId,
      rawResponse: JSON.stringify(response)
    }
  });

  const liveOrder = await prisma.openOrder.create({
    data: {
      exchangeOrderId,
      marketId: input.marketId,
      conditionId: input.conditionId,
      tokenId: input.tokenId,
      outcomeName: input.outcomeName ?? outcomeForToken(input.tokenId),
      side: input.side,
      price: input.price,
      size: input.size,
      remainingSize: input.size,
      tradeMode,
      status: "OPEN"
    }
  });

  invalidateAccountSummaryCache();
  return { live: true, order: liveOrder, exchangeOrderId, response };
}

export async function placeOrder(input: OrderInput) {
  const tradeMode = input.tradeMode ?? TradeMode.PAPER;
  return withOrderLock(orderLockKey(input, tradeMode), () => placeOrderUnlocked(input, tradeMode));
}

export async function cancelOrder(orderId: string, tradeMode: TradeMode = TradeMode.PAPER) {
  await assertTradingAllowed({ tradeMode, action: "CANCEL" });
  if (tradeMode === TradeMode.PAPER) {
    const { marketId } = marketScope();
    const result = await prisma.openOrder.updateMany({
      where: { id: orderId, marketId },
      data: { status: "CANCELLED", remainingSize: 0 }
    });
    invalidateAccountSummaryCache();
    return result;
  }
  const result = await cancelLiveOrder(orderId);
  invalidateAccountSummaryCache();
  return result;
}

export async function cancelMarketOrders(marketId: string, tradeMode: TradeMode = TradeMode.PAPER) {
  assertConfiguredMarket(marketId);
  await assertTradingAllowed({ tradeMode, action: "CANCEL" });
  if (tradeMode === TradeMode.PAPER) {
    const result = await prisma.openOrder.updateMany({
      where: { marketId, status: "OPEN" },
      data: { status: "CANCELLED", remainingSize: 0 }
    });
    invalidateAccountSummaryCache();
    return result;
  }
  const result = await cancelLiveMarketOrders(marketId);
  invalidateAccountSummaryCache();
  return result;
}

export async function listOpenOrders(tradeMode?: TradeMode) {
  const { marketId } = marketScope();
  const requestedTradeMode = tradeMode ?? ((await getAppSettings()).tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER);
  if (requestedTradeMode === TradeMode.LIVE) {
    const { conditionId } = marketScope();
    const tokenIds = new Set(configuredTokenIds());
    const orders = await getLiveOpenOrders();
    if (!Array.isArray(orders)) return orders;
    const liveRows = orders
      .filter((order: { market?: string; marketId?: string; asset_id?: string; tokenId?: string }) => (
        order.market === marketId ||
        order.market === conditionId ||
        order.marketId === marketId ||
        tokenIds.has(String(order.asset_id ?? order.tokenId ?? ""))
      ))
      .map((order: {
        id?: string;
        orderID?: string;
        market?: string;
        asset_id?: string;
        outcome?: string;
        side?: string;
        price?: string;
        original_size?: string;
        size_matched?: string;
        status?: string;
        created_at?: number;
      }) => {
        const size = Number(order.original_size ?? 0);
        const matched = Number(order.size_matched ?? 0);
        return {
          id: order.id ?? order.orderID,
          exchangeOrderId: order.id ?? order.orderID,
          marketId,
          conditionId: order.market,
          tokenId: order.asset_id,
          outcomeName: order.outcome,
          side: order.side,
          price: Number(order.price),
          size,
          remainingSize: Math.max(0, size - matched),
          status: order.status ?? "OPEN",
          tradeMode: TradeMode.LIVE,
          createdAt: order.created_at ? new Date(order.created_at * 1000).toISOString() : undefined
        };
      });

    const localLiveRows = await prisma.openOrder.findMany({ where: { marketId, tradeMode: TradeMode.LIVE, status: "OPEN" }, orderBy: { createdAt: "desc" } });
    const seen = new Set(liveRows.map((order) => String(order.exchangeOrderId ?? order.id)));
    return [
      ...liveRows,
      ...localLiveRows.filter((order) => !seen.has(String(order.exchangeOrderId ?? order.id)))
    ];
  }
  return prisma.openOrder.findMany({ where: { marketId }, orderBy: { createdAt: "desc" } });
}

export async function listPositions() {
  const { marketId } = marketScope();
  return prisma.position.findMany({
    where: { marketId },
    orderBy: { updatedAt: "desc" },
    include: { stopLossRules: true }
  });
}
