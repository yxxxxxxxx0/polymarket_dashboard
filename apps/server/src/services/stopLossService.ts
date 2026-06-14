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
import { getCachedOfi, getCachedOrderBook, onOrderBookUpdate, orderBookAgeMs } from "./orderbookCache.js";
import { getAppSettings } from "./settingsService.js";
import { assertConfiguredToken, marketScope, outcomeForToken } from "./singleMarketService.js";
import { evaluateStopLossConfirmation } from "./stopLossDecision.js";
import { cancelMarketOrders, placeOrder } from "./tradingService.js";
import { handleSequenceExitFilled, markRuleOrderSubmitted, markRuleTerminal, reconcileStrategySequences, ruleStatusForDisplay } from "./strategySequenceService.js";
import { getMarketGameTime } from "./gameTimeService.js";

const confirmationTicks = new Map<string, number>();
const recentPrices = new Map<string, Array<{ timestamp: number; price: number }>>();
const tokenEvaluationQueues = new Map<string, { running: boolean; pending: OrderBook | null }>();
const tokenExecutionLocks = new Set<string>();
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

export function executionPrice(rule: {
  executionType: StopLossExecutionType;
  stopPrice: number;
  slippageLimit: number;
}, book: OrderBook, emergencyPnLProtection = false): number | null {
  const bestBid = book.bestBid;
  if (rule.executionType === StopLossExecutionType.CANCEL_ONLY) return null;
  if (bestBid === null) return null;

  if (rule.executionType === StopLossExecutionType.STRICT_LIMIT) {
    return bestBid >= rule.stopPrice ? rule.stopPrice : null;
  }

  if (emergencyPnLProtection) {
    return Math.max(bestBid - rule.slippageLimit, 0.01);
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

async function freshestOrderBook(tokenId: string, preferred?: OrderBook) {
  const preferredAge = preferred ? orderBookAgeMs(preferred) : null;
  if (preferred && preferredAge !== null && preferredAge <= config.ORDERBOOK_STALE_MS) return preferred;

  const cached = getCachedOrderBook(tokenId);
  const cachedAge = orderBookAgeMs(cached);
  if (cachedAge !== null && cachedAge <= config.ORDERBOOK_STALE_MS) return cached;

  return fetchOrderBook(tokenId);
}

function assertFreshEnoughForExecution(book: OrderBook) {
  const age = orderBookAgeMs(book);
  if (age === null) {
    throw new Error("No fresh orderbook update is available for execution");
  }
  if (age > config.ORDERBOOK_STALE_MS) {
    throw new Error(`Orderbook is stale (${age}ms old, limit ${config.ORDERBOOK_STALE_MS}ms)`);
  }
}

async function withTokenExecutionLock<T>(tokenId: string, fn: () => Promise<T>): Promise<T | null> {
  if (tokenExecutionLocks.has(tokenId)) return null;
  tokenExecutionLocks.add(tokenId);
  try {
    return await fn();
  } finally {
    tokenExecutionLocks.delete(tokenId);
  }
}

async function claimRuleExecution(rule: StopLossRule, triggeredPrice: number | null) {
  const result = await prisma.stopLossRule.updateMany({
    where: {
      id: rule.id,
      marketId: rule.marketId,
      enabled: true,
      orderSubmitted: false,
      status: { in: [StopLossStatus.ENABLED, StopLossStatus.ARMED, StopLossStatus.ACTIVE] }
    },
    data: {
      status: StopLossStatus.TRIGGERING,
      orderSubmitted: true,
      triggeredAt: new Date(),
      triggeredPrice
    }
  });
  if (result.count !== 1) return null;
  invalidateStopLossRuleCache(rule.marketId);
  return prisma.stopLossRule.findUnique({ where: { id: rule.id } });
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
        where: { marketId, enabled: true, status: { in: [StopLossStatus.ENABLED, StopLossStatus.ARMED, StopLossStatus.ACTIVE] } }
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
  disableMaxSpread?: boolean;
  aggressivePnLProtection?: boolean;
  aggressiveBreakout?: boolean;
  strategySequenceId?: string;
  parentRuleId?: string;
  activationCondition?: string;
  enabled?: boolean;
  status?: StopLossStatus;
}) {
  assertConfiguredToken(data.tokenId);
  const { marketId, conditionId } = marketScope();
  const rule = await prisma.stopLossRule.create({
    data: {
      ...data,
      enabled: data.enabled ?? true,
      status: data.status ?? (isBreakoutRule(data.ruleType ?? RuleType.STOP_LOSS) ? StopLossStatus.ARMED : StopLossStatus.ENABLED),
      marketId,
      conditionId,
      outcomeName: data.outcomeName || outcomeForToken(data.tokenId)
    }
  });
  invalidateStopLossRuleCache(marketId);
  return rule;
}

export function marketableBuyPrice(rule: { stopPrice: number; slippageLimit: number }, book: OrderBook): number | null {
  if (book.bestAsk === null) return null;
  return Math.min(0.99, book.bestAsk + rule.slippageLimit);
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
  if (!rule || rule.marketId !== marketId || !rule.enabled || rule.orderSubmitted || rule.status === StopLossStatus.TRIGGERED || rule.status === StopLossStatus.TRIGGERING || rule.status === StopLossStatus.SUBMITTED || rule.status === StopLossStatus.ORDER_SUBMITTED || rule.status === StopLossStatus.FILLED || rule.status === StopLossStatus.CANCELLED || rule.status === StopLossStatus.INACTIVE_WAITING_FOR_PARENT) {
    return null;
  }

  const book = await freshestOrderBook(rule.tokenId, bookOverride);
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

    return withTokenExecutionLock(liveRule.tokenId, async () => {
      const executionBook = await freshestOrderBook(liveRule.tokenId, book);
      assertFreshEnoughForExecution(executionBook);
      const executionRef = referencePrice(executionBook, liveRule.breakoutReferenceSource ?? liveRule.triggerType);
      const executionSpread = executionBook.spread ?? (executionBook.bestAsk !== null && executionBook.bestBid !== null ? executionBook.bestAsk - executionBook.bestBid : null);
      const stillTriggered = executionRef !== null && executionRef >= breakoutPrice;
      const stillSpreadOk = liveRule.maxSpread === null || liveRule.maxSpread === undefined || (executionSpread !== null && executionSpread <= liveRule.maxSpread);
      if (!stillTriggered || !stillSpreadOk) {
        return {
          triggered: false,
          referencePrice: executionRef,
          spread: executionSpread,
          status: liveRule.status,
          message: "Breakout skipped because the fresh orderbook no longer satisfies trigger conditions"
        };
      }

      const claimedRule = await claimRuleExecution(liveRule, executionRef);
      if (!claimedRule) return null;

      const price = marketableBuyPrice(claimedRule, executionBook);
      const sizeUsd = claimedRule.breakoutSizeUsd ?? claimedRule.positionSize;
      const size = price && price > 0 ? sizeUsd / price : 0;
      try {
        if (price === null || size <= 0) throw new Error("No executable buy price");
        const response = await placeOrder({
          marketId: claimedRule.marketId,
          conditionId: claimedRule.conditionId ?? undefined,
          tokenId: claimedRule.tokenId,
          outcomeName: claimedRule.outcomeName,
          side: OrderSide.BUY,
          price,
          size,
          tradeMode,
          closeOnly: false,
          source: "breakout-rule"
        });
        await prisma.stopLossTriggerLog.create({
          data: {
            ruleId: claimedRule.id,
            referencePrice: executionRef,
            executablePrice: price,
            size,
            tradeMode,
            success: true,
            message: "Breakout buy triggered",
            rawResponse: JSON.stringify(response)
          }
        });
        const orderId = typeof response === "object" && response
          ? String(
            "exchangeOrderId" in response
              ? response.exchangeOrderId
              : "order" in response && response.order && typeof response.order === "object" && "id" in response.order
                ? response.order.id
                : "id" in response
                  ? response.id
                  : ""
          )
          : "";
        return markRuleOrderSubmitted(claimedRule.id, orderId || null, response);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown buy-stop failure";
        await prisma.stopLossTriggerLog.create({
          data: { ruleId: claimedRule.id, referencePrice: executionRef, executablePrice: price, size, tradeMode, success: false, message }
        });
        await markRuleTerminal(claimedRule.id, StopLossStatus.FAILED, message);
        return prisma.stopLossRule.findUnique({ where: { id: claimedRule.id } });
      }
    });
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
  const spread = book.spread ?? (book.bestAsk !== null && book.bestBid !== null ? book.bestAsk - book.bestBid : null);
  const spreadOk = liveRule.disableMaxSpread || liveRule.maxSpread === null || liveRule.maxSpread === undefined || (spread !== null && spread <= liveRule.maxSpread);

  if (!triggerReason || !spreadOk) {
    return {
      triggered: false,
      referencePrice: ref,
      rollingOfi,
      spread,
      spreadOk,
      priceTriggered: hardDecision.priceTriggered || Boolean(softDecision?.priceTriggered),
      activeStopPrice: liveRule.stopPrice,
      hardStopPrice,
      softStopPrice,
      ofiConfirmed: hardDecision.ofiConfirmed || Boolean(softDecision?.ofiConfirmed),
      confirmationTicks: Math.max(hardDecision.confirmationTicks, softDecision?.confirmationTicks ?? 0),
      requiredConfirmationTicks: config.STOP_OFI_CONFIRMATION_TICKS
    };
  }

  return withTokenExecutionLock(liveRule.tokenId, async () => {
    const executionBook = await freshestOrderBook(liveRule.tokenId, book);
    assertFreshEnoughForExecution(executionBook);
    const executionRef = referencePrice(executionBook, liveRule.triggerType);
    const claimedRule = await claimRuleExecution(liveRule, executionRef);
    if (!claimedRule) return null;
    const executionSpread = executionBook.spread ?? (executionBook.bestAsk !== null && executionBook.bestBid !== null ? executionBook.bestAsk - executionBook.bestBid : null);
    const executionSpreadOk = claimedRule.disableMaxSpread || claimedRule.maxSpread === null || claimedRule.maxSpread === undefined || (executionSpread !== null && executionSpread <= claimedRule.maxSpread);

    const position = claimedRule.positionId
    ? await prisma.position.findFirst({ where: { id: claimedRule.positionId, marketId } })
    : await prisma.position.findFirst({
      where: { tokenId: claimedRule.tokenId, marketId: claimedRule.marketId },
      orderBy: { updatedAt: "desc" }
    });

    const availableSize = Math.max(0, position?.size ?? claimedRule.positionSize);
    const exitSize = Math.min(availableSize, claimedRule.positionSize, claimedRule.maxSellSize);
    const gameMinute = (await getMarketGameTime(claimedRule.marketId).catch(() => null))?.gameMinute ?? 0;
    const emergencyPnLProtection = claimedRule.aggressivePnLProtection || gameMinute >= 85;
    const price = executionPrice(claimedRule, executionBook, emergencyPnLProtection);

    try {
      if (exitSize <= 0) throw new Error("No available position size to close");
      if (!executionSpreadOk) throw new Error(`Spread ${executionSpread?.toFixed(3) ?? "unknown"} exceeds max spread ${claimedRule.maxSpread}`);

      let response: unknown;
      if (claimedRule.executionType === StopLossExecutionType.CANCEL_ONLY) {
        response = await cancelMarketOrders(claimedRule.marketId, tradeMode);
      } else {
        if (price === null) throw new Error("No executable price within stop-loss constraints");
        response = await placeOrder({
          marketId: claimedRule.marketId,
          conditionId: claimedRule.conditionId ?? undefined,
          tokenId: claimedRule.tokenId,
          outcomeName: claimedRule.outcomeName,
          side: OrderSide.SELL,
          price,
          size: exitSize,
          tradeMode,
          closeOnly: true,
          source: "stop-rule"
        });
      }

      await prisma.stopLossTriggerLog.create({
        data: {
          ruleId: claimedRule.id,
          referencePrice: executionRef,
          executablePrice: price,
          size: exitSize,
          tradeMode,
          success: true,
          message: `${triggerReason === "TAKE_PROFIT" ? "Take profit" : triggerReason === "SOFT_OFI_STOP" ? "Soft OFI stop" : claimedRule.ruleType === RuleType.TRAILING_STOP ? "Trailing hard stop" : "Hard stop"} triggered`,
          rawResponse: JSON.stringify(response)
        }
      });

      const updatedRule = await prisma.stopLossRule.update({
        where: { id: claimedRule.id },
        data: {
          enabled: false,
          status: StopLossStatus.TRIGGERED
        }
      });
      if (claimedRule.strategySequenceId && claimedRule.parentRuleId) {
        await handleSequenceExitFilled(claimedRule.id);
      }
      return updatedRule;
    } catch (error) {
      confirmationTicks.set(claimedRule.id, 0);
      const message = error instanceof Error ? error.message : "Unknown stop-loss failure";
      await prisma.stopLossTriggerLog.create({
        data: {
          ruleId: claimedRule.id,
          referencePrice: executionRef,
          executablePrice: price,
          size: exitSize,
          tradeMode,
          success: false,
          message
        }
      });
      return prisma.stopLossRule.update({
        where: { id: claimedRule.id },
        data: { status: StopLossStatus.FAILED }
      });
    }
  });
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
    include: {
      triggerLogs: { orderBy: { attemptedAt: "desc" }, take: 5 },
      childRules: { select: { id: true } }
    }
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
      profitLocked: rule.ruleType === RuleType.TRAILING_STOP ? activeStopPrice > rule.entryPrice : null,
      displayStatus: ruleStatusForDisplay(rule.status),
      childRuleIds: rule.childRules.map((child) => child.id)
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
    evaluateAllStopLossRules().then(() => reconcileStrategySequences()).catch((error) => {
      console.error("Stop-loss monitor error", error);
    });
  }, config.RULE_EVALUATION_MS);
}
