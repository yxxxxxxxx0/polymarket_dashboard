import {
  OrderSide,
  RuleType,
  StopLossExecutionType,
  StopLossStatus,
  StopLossTriggerType,
  TradeMode,
  type StopLossRule
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import type { OrderBook } from "../types/domain.js";
import { fetchOrderBook } from "./clobService.js";
import { config } from "../config.js";
import { getCachedOfi, getCachedOrderBook, onOrderBookUpdate } from "./orderbookCache.js";
import { getAppSettings } from "./settingsService.js";
import { assertConfiguredToken, marketScope, outcomeForToken } from "./singleMarketService.js";
import { evaluateStopLossConfirmation } from "./stopLossDecision.js";
import { cancelMarketOrders, placeOrder } from "./tradingService.js";

const confirmationTicks = new Map<string, number>();
const recentPrices = new Map<string, Array<{ timestamp: number; price: number }>>();
const tokenEvaluationQueues = new Map<string, { running: boolean; pending: OrderBook | null }>();
let enabledRulesCache: { marketId: string; expiresAt: number; rules: StopLossRule[] } | null = null;
let subscribedToOrderBookUpdates = false;
let cachedTradeMode: { value: TradeMode; expiresAt: number } | null = null;

function referencePrice(book: OrderBook, triggerType: StopLossTriggerType): number | null {
  switch (triggerType) {
    case StopLossTriggerType.BEST_BID:
      return book.bestBid;
    case StopLossTriggerType.BEST_ASK:
      return book.bestAsk;
    case StopLossTriggerType.MIDPOINT_PRICE:
      return book.midpoint;
    case StopLossTriggerType.LAST_TRADE_PRICE:
      return book.lastTradePrice ?? book.midpoint;
  }
}

function executionPrice(rule: {
  executionType: StopLossExecutionType;
  stopPrice: number;
  slippageLimit: number;
}, book: OrderBook): number | null {
  const bestBid = book.bestBid;
  if (rule.executionType === StopLossExecutionType.CANCEL_ONLY) return null;
  if (bestBid === null) return null;

  if (rule.executionType === StopLossExecutionType.STRICT_LIMIT) {
    return bestBid >= rule.stopPrice ? rule.stopPrice : null;
  }

  const floor = Math.max(0.01, rule.stopPrice - rule.slippageLimit);
  return Math.max(floor, bestBid - rule.slippageLimit);
}

function isExitRule(ruleType: RuleType) {
  return ruleType === RuleType.STOP_LOSS || ruleType === RuleType.TRAILING_STOP;
}

function isBreakoutRule(ruleType: RuleType) {
  return ruleType === RuleType.BREAKOUT_BUY || ruleType === RuleType.BUY_STOP;
}

function confirmationKey(ruleId: string, reason: string) {
  return `${ruleId}:${reason}`;
}

export function invalidateStopLossRuleCache(marketId?: string) {
  if (!marketId || enabledRulesCache?.marketId === marketId) enabledRulesCache = null;
}

async function getEnabledStopRules(marketId: string, tokenId?: string) {
  const now = Date.now();
  if (!enabledRulesCache || enabledRulesCache.marketId !== marketId || enabledRulesCache.expiresAt <= now) {
    enabledRulesCache = {
      marketId,
      expiresAt: now + 250,
      rules: await prisma.stopLossRule.findMany({
        where: { marketId, enabled: true, status: { in: [StopLossStatus.ENABLED, StopLossStatus.ARMED] } }
      })
    };
  }
  return tokenId ? enabledRulesCache.rules.filter((rule) => rule.tokenId === tokenId) : enabledRulesCache.rules;
}

function rememberPrice(tokenId: string, price: number | null) {
  if (price === null || !Number.isFinite(price)) return null;
  const now = Date.now();
  const next = [...(recentPrices.get(tokenId) ?? []), { timestamp: now, price }]
    .filter((point) => now - point.timestamp <= 30_000)
    .slice(-50);
  recentPrices.set(tokenId, next);
  const first = next[0];
  const last = next[next.length - 1];
  if (!first || !last || first.timestamp === last.timestamp) return 0;
  return (last.price - first.price) / ((last.timestamp - first.timestamp) / 1_000);
}

export async function createStopLossRule(data: {
  ruleType?: RuleType;
  marketId?: string;
  conditionId?: string;
  tokenId: string;
  outcomeName: string;
  sideCurrentlyHeld: OrderSide;
  positionSize: number;
  entryPrice: number;
  stopPrice: number;
  triggerType: StopLossTriggerType;
  executionType: StopLossExecutionType;
  slippageLimit: number;
  maxSellSize: number;
  positionId?: string;
  currentPrice?: number;
  stopPercentage?: number;
  highestPriceSinceEntry?: number;
  trailingPercentage?: number;
  referencePrice?: number;
  breakoutPercentage?: number;
  breakevenEnabled?: boolean;
  breakevenTriggerPrice?: number;
  breakevenBuffer?: number;
  takeProfitPrice?: number;
  hardStopPrice?: number;
  softStopPrice?: number;
  useOfiConfirmationForSoftStop?: boolean;
  useOfiConfirmationForHardStop?: boolean;
  breakoutPrice?: number;
  breakoutReferenceSource?: StopLossTriggerType;
  breakoutSizeUsd?: number;
  useOfiConfirmation?: boolean;
  ofiBuyThreshold?: number;
  usePriceSlopeConfirmation?: boolean;
  priceSlopeThreshold?: number;
  maxSpread?: number;
}) {
  assertConfiguredToken(data.tokenId);
  const { marketId, conditionId } = marketScope();
  const rule = await prisma.stopLossRule.create({
    data: {
      ...data,
      status: isBreakoutRule(data.ruleType ?? RuleType.STOP_LOSS) ? StopLossStatus.ARMED : StopLossStatus.ENABLED,
      marketId,
      conditionId,
      outcomeName: data.outcomeName || outcomeForToken(data.tokenId)
    }
  });
  invalidateStopLossRuleCache(marketId);
  return rule;
}

function marketableBuyPrice(rule: { stopPrice: number; slippageLimit: number }, book: OrderBook): number | null {
  if (book.bestAsk === null) return null;
  return Math.min(0.99, Math.max(rule.stopPrice, book.bestAsk + rule.slippageLimit));
}

async function updateLiveRuleState(rule: Awaited<ReturnType<typeof prisma.stopLossRule.findUnique>>, book: OrderBook, ref: number | null) {
  if (!rule || ref === null) return rule;

  if (rule.ruleType === RuleType.TRAILING_STOP) {
    const previousHighest = rule.highestPriceSinceEntry ?? rule.entryPrice;
    const highestPriceSinceEntry = Math.max(previousHighest, ref);
    let stopPrice = rule.stopPrice;
    const trailingPercentage = rule.trailingPercentage ?? rule.stopPercentage ?? 0;
    if (trailingPercentage > 0) {
      const candidateStop = highestPriceSinceEntry * (1 - trailingPercentage / 100);
      stopPrice = Math.max(rule.stopPrice, candidateStop);
    }

    if (rule.breakevenEnabled && rule.breakevenTriggerPrice !== null && ref >= rule.breakevenTriggerPrice) {
      stopPrice = Math.max(stopPrice, rule.entryPrice + rule.breakevenBuffer);
    }

    if (highestPriceSinceEntry !== rule.highestPriceSinceEntry || stopPrice !== rule.stopPrice || ref !== rule.currentPrice) {
      return prisma.stopLossRule.update({
        where: { id: rule.id },
        data: { highestPriceSinceEntry, stopPrice, currentPrice: ref, lastEvaluatedPrice: ref, lastUpdatedAt: new Date() }
      });
    }
  }

  if (ref !== rule.currentPrice) {
    return prisma.stopLossRule.update({
      where: { id: rule.id },
      data: { currentPrice: ref, lastEvaluatedPrice: ref, lastUpdatedAt: new Date() }
    });
  }

  return rule;
}

async function currentTradeMode() {
  const now = Date.now();
  if (cachedTradeMode && cachedTradeMode.expiresAt > now) return cachedTradeMode.value;
  const settings = await getAppSettings();
  const value = settings.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER;
  cachedTradeMode = { value, expiresAt: now + 1_000 };
  return value;
}

async function evaluateStopLossRuleRow(rule: StopLossRule, tradeMode: TradeMode = TradeMode.PAPER, bookOverride?: OrderBook) {
  const { marketId } = marketScope();
  if (!rule || rule.marketId !== marketId || !rule.enabled || rule.orderSubmitted || rule.status === StopLossStatus.TRIGGERED || rule.status === StopLossStatus.TRIGGERING || rule.status === StopLossStatus.SUBMITTED || rule.status === StopLossStatus.FILLED) {
    return null;
  }

  const book = bookOverride ?? await fetchOrderBook(rule.tokenId);
  const ref = referencePrice(book, rule.triggerType);
  const priceSlope = rememberPrice(rule.tokenId, ref);
  const liveRule = await updateLiveRuleState(rule, book, ref);
  if (!liveRule) return null;

  if (isBreakoutRule(liveRule.ruleType)) {
    const breakoutRef = referencePrice(book, liveRule.breakoutReferenceSource ?? liveRule.triggerType);
    const breakoutPrice = liveRule.breakoutPrice ?? liveRule.stopPrice;
    const spread = book.spread ?? (book.bestAsk !== null && book.bestBid !== null ? book.bestAsk - book.bestBid : null);
    const rollingOfi = getCachedOfi(liveRule.tokenId)?.rollingOfi30s ?? 0;
    const shouldBuy = breakoutRef !== null && breakoutRef >= breakoutPrice;
    const spreadOk = liveRule.maxSpread === null || liveRule.maxSpread === undefined || (spread !== null && spread <= liveRule.maxSpread);
    const ofiOk = !liveRule.useOfiConfirmation || rollingOfi >= (liveRule.ofiBuyThreshold ?? config.OFI_BUY_THRESHOLD);
    const slopeOk = !liveRule.usePriceSlopeConfirmation || (priceSlope !== null && priceSlope >= (liveRule.priceSlopeThreshold ?? 0));
    if (!shouldBuy) {
      return {
        triggered: false,
        referencePrice: breakoutRef,
        distanceToTrigger: breakoutRef === null ? null : breakoutPrice - breakoutRef,
        status: liveRule.status
      };
    }
    if (!spreadOk || !ofiOk || !slopeOk) {
      return { triggered: false, referencePrice: breakoutRef, spread, rollingOfi, priceSlope, spreadOk, ofiOk, slopeOk, status: liveRule.status };
    }

    await prisma.stopLossRule.update({
      where: { id: liveRule.id },
      data: { status: StopLossStatus.TRIGGERING, orderSubmitted: true, triggeredAt: new Date(), triggeredPrice: breakoutRef }
    });
    invalidateStopLossRuleCache(liveRule.marketId);

    const price = marketableBuyPrice(liveRule, book);
    const sizeUsd = liveRule.breakoutSizeUsd ?? liveRule.positionSize;
    const size = price && price > 0 ? sizeUsd / price : 0;
    try {
      if (price === null || size <= 0) throw new Error("No executable buy price");
      const response = await placeOrder({
        marketId: liveRule.marketId,
        conditionId: liveRule.conditionId ?? undefined,
        tokenId: liveRule.tokenId,
        outcomeName: liveRule.outcomeName,
        side: OrderSide.BUY,
        price,
        size,
        tradeMode,
        closeOnly: false
      });
      await prisma.stopLossTriggerLog.create({
        data: {
          ruleId: liveRule.id,
          referencePrice: breakoutRef,
          executablePrice: price,
          size,
          tradeMode,
          success: true,
          message: "Breakout buy triggered",
          rawResponse: JSON.stringify(response)
        }
      });
      return prisma.stopLossRule.update({
        where: { id: liveRule.id },
        data: { status: StopLossStatus.SUBMITTED, orderId: typeof response === "object" && response && "id" in response ? String(response.id) : null }
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown buy-stop failure";
      await prisma.stopLossTriggerLog.create({
        data: { ruleId: liveRule.id, referencePrice: breakoutRef, executablePrice: price, size, tradeMode, success: false, message }
      });
      return prisma.stopLossRule.update({ where: { id: liveRule.id }, data: { status: StopLossStatus.FAILED } });
    }
  }

  const forceExit = liveRule.ruleType === RuleType.TRAILING_STOP && liveRule.takeProfitPrice !== null && ref !== null && ref >= liveRule.takeProfitPrice;
  const rollingOfi = getCachedOfi(liveRule.tokenId)?.rollingOfi30s ?? 0;
  const hardStopPrice = liveRule.hardStopPrice ?? liveRule.stopPrice;
  const softStopPrice = liveRule.softStopPrice;
  const hardDecision = evaluateStopLossConfirmation({
    sideHeld: liveRule.sideCurrentlyHeld,
    referencePrice: ref,
    stopPrice: forceExit ? ref ?? hardStopPrice : hardStopPrice,
    rollingOfi,
    previousConfirmationTicks: confirmationTicks.get(confirmationKey(liveRule.id, "HARD_STOP")) ?? 0,
    requiredConfirmationTicks: config.STOP_OFI_CONFIRMATION_TICKS,
    sellThreshold: config.STOP_OFI_SELL_THRESHOLD
  });
  confirmationTicks.set(confirmationKey(liveRule.id, "HARD_STOP"), hardDecision.confirmationTicks);
  const hardConfirmed = liveRule.useOfiConfirmationForHardStop ? hardDecision.shouldExit : hardDecision.priceTriggered;
  const softDecision = softStopPrice === null ? null : evaluateStopLossConfirmation({
    sideHeld: liveRule.sideCurrentlyHeld,
    referencePrice: ref,
    stopPrice: softStopPrice,
    rollingOfi,
    previousConfirmationTicks: confirmationTicks.get(confirmationKey(liveRule.id, "SOFT_OFI_STOP")) ?? 0,
    requiredConfirmationTicks: config.STOP_OFI_CONFIRMATION_TICKS,
    sellThreshold: config.STOP_OFI_SELL_THRESHOLD
  });
  if (softDecision) confirmationTicks.set(confirmationKey(liveRule.id, "SOFT_OFI_STOP"), softDecision.confirmationTicks);
  const softConfirmed = Boolean(softDecision?.priceTriggered && (!liveRule.useOfiConfirmationForSoftStop || softDecision.shouldExit));
  const triggerReason = forceExit ? "TAKE_PROFIT" : hardConfirmed ? "HARD_STOP" : softConfirmed ? "SOFT_OFI_STOP" : null;

  if (!triggerReason) {
    return {
      triggered: false,
      referencePrice: ref,
      rollingOfi,
      priceTriggered: hardDecision.priceTriggered || Boolean(softDecision?.priceTriggered),
      activeStopPrice: liveRule.stopPrice,
      hardStopPrice,
      softStopPrice,
      ofiConfirmed: hardDecision.ofiConfirmed || Boolean(softDecision?.ofiConfirmed),
      confirmationTicks: Math.max(hardDecision.confirmationTicks, softDecision?.confirmationTicks ?? 0),
      requiredConfirmationTicks: config.STOP_OFI_CONFIRMATION_TICKS
    };
  }

  await prisma.stopLossRule.update({
    where: { id: liveRule.id },
    data: { status: StopLossStatus.TRIGGERING }
  });
  invalidateStopLossRuleCache(liveRule.marketId);

  const position = liveRule.positionId
    ? await prisma.position.findFirst({ where: { id: liveRule.positionId, marketId } })
    : await prisma.position.findFirst({
      where: { tokenId: liveRule.tokenId, marketId: liveRule.marketId },
      orderBy: { updatedAt: "desc" }
    });

  const availableSize = Math.max(0, position?.size ?? liveRule.positionSize);
  const exitSize = Math.min(availableSize, liveRule.positionSize, liveRule.maxSellSize);
  const price = executionPrice(liveRule, book);

  try {
    if (exitSize <= 0) throw new Error("No available position size to close");

    let response: unknown;
    if (liveRule.executionType === StopLossExecutionType.CANCEL_ONLY) {
      response = await cancelMarketOrders(liveRule.marketId, tradeMode);
    } else {
      if (price === null) throw new Error("No executable price within stop-loss constraints");
      response = await placeOrder({
        marketId: liveRule.marketId,
        conditionId: liveRule.conditionId ?? undefined,
        tokenId: liveRule.tokenId,
        outcomeName: liveRule.outcomeName,
        side: OrderSide.SELL,
        price,
        size: exitSize,
        tradeMode,
        closeOnly: true
      });
    }

    await prisma.stopLossTriggerLog.create({
      data: {
        ruleId: liveRule.id,
        referencePrice: ref,
        executablePrice: price,
        size: exitSize,
        tradeMode,
        success: true,
        message: `${triggerReason === "TAKE_PROFIT" ? "Take profit" : triggerReason === "SOFT_OFI_STOP" ? "Soft OFI stop" : liveRule.ruleType === RuleType.TRAILING_STOP ? "Trailing hard stop" : "Hard stop"} triggered`,
        rawResponse: JSON.stringify(response)
      }
    });

    return prisma.stopLossRule.update({
      where: { id: liveRule.id },
      data: {
        triggeredAt: new Date(),
        enabled: false,
        status: StopLossStatus.TRIGGERED
      }
    });
  } catch (error) {
    confirmationTicks.set(liveRule.id, 0);
    const message = error instanceof Error ? error.message : "Unknown stop-loss failure";
    await prisma.stopLossTriggerLog.create({
      data: {
        ruleId: liveRule.id,
        referencePrice: ref,
        executablePrice: price,
        size: exitSize,
        tradeMode,
        success: false,
        message
      }
    });
    return prisma.stopLossRule.update({
      where: { id: liveRule.id },
      data: { status: StopLossStatus.FAILED }
    });
  }
}

export async function evaluateStopLossRule(ruleId: string, tradeMode: TradeMode = TradeMode.PAPER, bookOverride?: OrderBook) {
  const rule = await prisma.stopLossRule.findUnique({ where: { id: ruleId } });
  if (!rule) return null;
  return evaluateStopLossRuleRow(rule, tradeMode, bookOverride);
}

export async function evaluateAllStopLossRules() {
  const { marketId } = marketScope();
  const tradeMode = await currentTradeMode();
  const enabledRules = await getEnabledStopRules(marketId);

  const results = [];
  for (const rule of enabledRules) {
    results.push(await evaluateStopLossRuleRow(rule, tradeMode));
  }
  return results;
}

export async function evaluateStopRulesForMarket(marketId: string, book?: OrderBook) {
  const tradeMode = await currentTradeMode();
  const enabledRules = await getEnabledStopRules(marketId, book?.tokenId);

  const results = [];
  for (const rule of enabledRules) {
    results.push(await evaluateStopLossRuleRow(rule, tradeMode, book));
  }
  return results;
}

export async function stopLossStatus() {
  const { marketId } = marketScope();
  const [enabled, triggered, failed, total] = await Promise.all([
    prisma.stopLossRule.count({ where: { marketId, enabled: true } }),
    prisma.stopLossRule.count({ where: { marketId, status: StopLossStatus.TRIGGERED } }),
    prisma.stopLossRule.count({ where: { marketId, status: StopLossStatus.FAILED } }),
    prisma.stopLossRule.count({ where: { marketId } })
  ]);
  return { marketId, total, enabled, triggered, failed, running: true };
}

export async function listStopLossRulesWithLiveState() {
  const { marketId } = marketScope();
  const rules = await prisma.stopLossRule.findMany({
    where: { marketId },
    orderBy: { updatedAt: "desc" },
    include: { triggerLogs: { orderBy: { attemptedAt: "desc" }, take: 5 } }
  });

  return Promise.all(rules.map(async (rule) => {
    let livePrice = rule.currentPrice;
    try {
      const cached = getCachedOrderBook(rule.tokenId);
      const book = cached.bestBid !== null || cached.bestAsk !== null ? cached : await fetchOrderBook(rule.tokenId);
      livePrice = referencePrice(book, rule.triggerType) ?? livePrice;
    } catch {
      // Keep stored price if the live request is temporarily unavailable.
    }
    const activeStopPrice = rule.stopPrice;
    const distanceToStop = livePrice === null ? null : livePrice - activeStopPrice;
    const distanceToTrigger = livePrice === null ? null : activeStopPrice - livePrice;
    return {
      ...rule,
      currentPrice: livePrice,
      activeStopPrice,
      distanceToStop: isBreakoutRule(rule.ruleType) ? null : distanceToStop,
      distanceToTrigger: isBreakoutRule(rule.ruleType) ? distanceToTrigger : null,
      profitLocked: rule.ruleType === RuleType.TRAILING_STOP ? activeStopPrice > rule.entryPrice : null
    };
  }));
}

async function queueStopEvaluation(book: OrderBook) {
  const state = tokenEvaluationQueues.get(book.tokenId) ?? { running: false, pending: null };
  if (state.running) {
    state.pending = book;
    tokenEvaluationQueues.set(book.tokenId, state);
    return;
  }

  state.running = true;
  state.pending = book;
  tokenEvaluationQueues.set(book.tokenId, state);

  try {
    while (state.pending) {
      const next = state.pending;
      state.pending = null;
      await evaluateStopRulesForMarket(marketScope().marketId, next);
    }
  } catch (error) {
    console.error("Event-driven stop evaluation error", error);
  } finally {
    state.running = false;
    if (state.pending) {
      void queueStopEvaluation(state.pending);
    }
  }
}

export function startStopLossMonitor() {
  if (!subscribedToOrderBookUpdates) {
    subscribedToOrderBookUpdates = true;
    onOrderBookUpdate((book) => {
      void queueStopEvaluation(book);
    });
  }
  setInterval(() => {
    evaluateAllStopLossRules().catch((error) => {
      console.error("Stop-loss monitor error", error);
    });
  }, 5_000);
}
