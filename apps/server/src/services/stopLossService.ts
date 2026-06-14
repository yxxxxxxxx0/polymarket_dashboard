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
import { DEFAULT_GAP_MODEL_CONFIG, getGapModelConfig, getMarketGameTime, tierForGameMinute, type GapModelConfig } from "./gameTimeService.js";
import {
  computeEmergencyScore,
  emergencyBuyLimit,
  emergencySellLimit,
  getEmergencyParams,
  shouldEmergencyBreakoutBuy,
  shouldEmergencyStopLoss
} from "./emergencyExecutionModel.js";

const confirmationTicks = new Map<string, number>();
const recentPrices = new Map<string, Array<{ timestamp: number; price: number }>>();
const midpointHistory = new Map<string, Array<{ timestamp: number; midpoint: number }>>();
const emergencyOrderbookHistory = new Map<string, Array<{ timestamp: number; mid: number; spread: number; bidDepthNear: number; askDepthNear: number }>>();
const emergencyCooldowns = new Map<string, number>();
const tokenEvaluationQueues = new Map<string, { running: boolean; pending: OrderBook | null }>();
const tokenExecutionLocks = new Set<string>();
let enabledRulesCache: { marketId: string; expiresAt: number; rules: StopLossRule[] } | null = null;
let subscribedToOrderBookUpdates = false;
let cachedTradeMode: { value: TradeMode; expiresAt: number } | null = null;
const gameMinuteCache = new Map<string, { expiresAt: number; gameMinute: number | null }>();
let gapModelCache: { expiresAt: number; value: GapModelConfig } | null = null;
const EMERGENCY_HISTORY_MS = 30_000;
const EMERGENCY_COOLDOWN_MS = 5_000;
const EMERGENCY_SPREAD_OVERRIDE_SCORE = 0.85;

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

async function currentGameMinute(marketId: string): Promise<number | null> {
  const now = Date.now();
  const cached = gameMinuteCache.get(marketId);
  if (cached && cached.expiresAt > now) return cached.gameMinute;
  const gameTime = await getMarketGameTime(marketId).catch(() => null);
  const gameMinute = gameTime?.kickoffTimeIso ? gameTime.gameMinute : null;
  gameMinuteCache.set(marketId, { expiresAt: now + 1_000, gameMinute });
  return gameMinute;
}

async function currentGapModelConfig() {
  const now = Date.now();
  if (gapModelCache && gapModelCache.expiresAt > now) return gapModelCache.value;
  const value = await getGapModelConfig();
  gapModelCache = { expiresAt: now + 1_000, value };
  return value;
}

function clip(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function depthWithinOneCent(book: OrderBook, side: "bid" | "ask") {
  if (side === "ask") {
    if (book.bestAsk === null) return 0;
    return book.asks
      .filter((level) => level.price >= Number(book.bestAsk) && level.price <= Number(book.bestAsk) + 0.01)
      .reduce((sum, level) => sum + level.size, 0);
  }
  if (book.bestBid === null) return 0;
  return book.bids
    .filter((level) => level.price <= Number(book.bestBid) && level.price >= Number(book.bestBid) - 0.01)
    .reduce((sum, level) => sum + level.size, 0);
}

function computeNearDepth(book: OrderBook, side: "bid" | "ask", centsRange = 0.03) {
  if (side === "ask") {
    if (book.bestAsk === null) return 0;
    return book.asks
      .filter((level) => level.price >= Number(book.bestAsk) && level.price <= Number(book.bestAsk) + centsRange)
      .reduce((sum, level) => sum + level.size, 0);
  }

  if (book.bestBid === null) return 0;
  return book.bids
    .filter((level) => level.price <= Number(book.bestBid) && level.price >= Number(book.bestBid) - centsRange)
    .reduce((sum, level) => sum + level.size, 0);
}

function rememberEmergencyOrderbook(tokenId: string, book: OrderBook) {
  const mid = book.midpoint ?? (
    book.bestBid !== null && book.bestAsk !== null ? (book.bestBid + book.bestAsk) / 2 : null
  );
  const spread = book.spread ?? (
    book.bestBid !== null && book.bestAsk !== null ? book.bestAsk - book.bestBid : null
  );
  if (mid === null || spread === null || !Number.isFinite(mid) || !Number.isFinite(spread)) return null;

  const now = Date.now();
  const snapshot = {
    timestamp: now,
    mid,
    spread,
    bidDepthNear: computeNearDepth(book, "bid"),
    askDepthNear: computeNearDepth(book, "ask")
  };
  const next = [...(emergencyOrderbookHistory.get(tokenId) ?? []), snapshot]
    .filter((point) => now - point.timestamp <= EMERGENCY_HISTORY_MS)
    .slice(-300);
  emergencyOrderbookHistory.set(tokenId, next);
  return snapshot;
}

function getSnapshotAgo(tokenId: string, secondsAgo: number) {
  const history = emergencyOrderbookHistory.get(tokenId) ?? [];
  if (history.length === 0) return null;
  const target = Date.now() - secondsAgo * 1_000;
  return history.reduce((best, item) => (
    Math.abs(item.timestamp - target) < Math.abs(best.timestamp - target) ? item : best
  ), history[0]);
}

function computeRollingNormalDepth(tokenId: string, side: "bid" | "ask") {
  const history = emergencyOrderbookHistory.get(tokenId) ?? [];
  const depths = history
    .map((item) => side === "bid" ? item.bidDepthNear : item.askDepthNear)
    .filter((depth) => Number.isFinite(depth) && depth >= 0);
  if (depths.length === 0) return 0;
  return depths.reduce((sum, depth) => sum + depth, 0) / depths.length;
}

function emergencyStressMetrics(tokenId: string, book: OrderBook, side: "bid" | "ask", gameMinute: number) {
  const current = rememberEmergencyOrderbook(tokenId, book);
  if (!current) return null;
  const fiveSecondsAgo = getSnapshotAgo(tokenId, 5) ?? current;
  const tenSecondsAgo = getSnapshotAgo(tokenId, 10) ?? fiveSecondsAgo;
  const nearDepthNow = side === "bid" ? current.bidDepthNear : current.askDepthNear;
  const normalNearDepth = computeRollingNormalDepth(tokenId, side);
  const emergencyScore = computeEmergencyScore({
    midNow: current.mid,
    mid5sAgo: fiveSecondsAgo.mid,
    mid10sAgo: tenSecondsAgo.mid,
    spread: current.spread,
    nearDepthNow,
    normalNearDepth: normalNearDepth || nearDepthNow || 1e-9,
    gameMinute
  });
  const depthVacuumScore = clip(1 - nearDepthNow / Math.max(normalNearDepth || nearDepthNow || 1e-9, 1e-9), 0, 1);

  return {
    midNow: current.mid,
    mid5sAgo: fiveSecondsAgo.mid,
    mid10sAgo: tenSecondsAgo.mid,
    spread: current.spread,
    priceMove5s: current.mid - fiveSecondsAgo.mid,
    priceMove10s: current.mid - tenSecondsAgo.mid,
    bidDepthNear: current.bidDepthNear,
    askDepthNear: current.askDepthNear,
    nearDepthNow,
    normalNearDepth,
    depthVacuumScore,
    emergencyScore
  };
}

function emergencySpreadOk(spread: number | null, gameMinute: number, emergencyScore: number) {
  const maxSpread = getEmergencyParams(gameMinute).maxSpread;
  if (maxSpread === null) return true;
  return (spread !== null && spread <= maxSpread) || emergencyScore >= EMERGENCY_SPREAD_OVERRIDE_SCORE;
}

function emergencyCooldownKey(ruleId: string, type: "stop" | "breakout") {
  return `${ruleId}:${type}`;
}

function emergencyOnCooldown(ruleId: string, type: "stop" | "breakout") {
  const lastAttempt = emergencyCooldowns.get(emergencyCooldownKey(ruleId, type));
  return lastAttempt !== undefined && Date.now() - lastAttempt < EMERGENCY_COOLDOWN_MS;
}

function markEmergencyAttempt(ruleId: string, type: "stop" | "breakout") {
  emergencyCooldowns.set(emergencyCooldownKey(ruleId, type), Date.now());
}

function emergencyLogPayload(rule: StopLossRule, metrics: NonNullable<ReturnType<typeof emergencyStressMetrics>>, gameMinute: number, extra: Record<string, unknown>) {
  return {
    ruleId: rule.id,
    tokenId: rule.tokenId,
    outcomeName: rule.outcomeName,
    gameMinute,
    emergencyScore: Number(metrics.emergencyScore.toFixed(4)),
    spread: Number(metrics.spread.toFixed(4)),
    priceMove5s: Number(metrics.priceMove5s.toFixed(4)),
    priceMove10s: Number(metrics.priceMove10s.toFixed(4)),
    nearDepthNow: Number(metrics.nearDepthNow.toFixed(4)),
    normalNearDepth: Number(metrics.normalNearDepth.toFixed(4)),
    depthVacuumScore: Number(metrics.depthVacuumScore.toFixed(4)),
    ...extra
  };
}

function rememberMidpointMove(tokenId: string, book: OrderBook) {
  const midpoint = book.midpoint ?? (
    book.bestBid !== null && book.bestAsk !== null ? (book.bestBid + book.bestAsk) / 2 : null
  );
  if (midpoint === null || !Number.isFinite(midpoint)) return { upMove10Cents: 0, downMove10Cents: 0 };

  const now = Date.now();
  const next = [...(midpointHistory.get(tokenId) ?? []), { timestamp: now, midpoint }]
    .filter((point) => now - point.timestamp <= 30_000)
    .slice(-100);
  midpointHistory.set(tokenId, next);

  const target = now - 10_000;
  const tenSecondsAgo = [...next].reverse().find((point) => point.timestamp <= target) ?? next[0];
  const moveCents = (midpoint - tenSecondsAgo.midpoint) * 100;
  return {
    upMove10Cents: Math.max(0, moveCents),
    downMove10Cents: Math.max(0, -moveCents)
  };
}

export function resolveEffectiveRiskSettings(
  rule: Pick<StopLossRule, "ruleType" | "slippageLimit" | "maxSpread" | "disableMaxSpread">,
  gameMinute: number | null,
  book?: OrderBook | null,
  gapModel: GapModelConfig = DEFAULT_GAP_MODEL_CONFIG,
  movement: { upMove10Cents?: number; downMove10Cents?: number } = {}
) {
  if (gameMinute === null) {
    return {
      slippageLimit: rule.slippageLimit,
      maxSpread: rule.maxSpread,
      disableMaxSpread: rule.disableMaxSpread,
      gameMinute,
      dynamic: false,
      label: "Saved rule settings"
    };
  }

  const breakout = isBreakoutRule(rule.ruleType);
  const model = breakout ? gapModel.breakout : gapModel.stopLoss;
  const tier = tierForGameMinute(model, gameMinute);
  let slippageCents = tier.slippageCents;
  if (book) {
    const spreadCents = Math.max(0, Number(book.spread ?? 0) * 100);
    const referencePrice = breakout ? book.bestAsk ?? book.midpoint : book.bestBid ?? book.midpoint;
    const extremePriceAddCents = referencePrice !== null && (referencePrice < model.extremePriceLow || referencePrice > model.extremePriceHigh)
      ? model.extremePriceAddCents
      : 0;
    const thinDepth = breakout ? depthWithinOneCent(book, "ask") : depthWithinOneCent(book, "bid");
    const thinDepthAddCents = thinDepth < model.thinDepthThresholdShares ? model.thinDepthAddCents : 0;
    const moveCents = breakout ? movement.upMove10Cents ?? 0 : movement.downMove10Cents ?? 0;
    slippageCents = clip(
      model.spreadCoefficient * spreadCents
      + model.moveCoefficient * moveCents
      + tier.lateAddCents
      + thinDepthAddCents
      + extremePriceAddCents,
      model.minSlippageCents,
      model.maxSlippageCents
    );
  }

  return {
    slippageLimit: Number((slippageCents / 100).toFixed(4)),
    maxSpread: Number((tier.maxSpreadCents / 100).toFixed(4)),
    disableMaxSpread: tier.disableMaxSpread,
    gameMinute,
    dynamic: true,
    label: `${breakout ? "Breakout" : "Stop"} gap model: ${slippageCents.toFixed(1)}c slippage, ${tier.disableMaxSpread ? "max spread disabled" : `${tier.maxSpreadCents}c max spread`} (${tier.label})`
  };
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
  const movement = rememberMidpointMove(rule.tokenId, book);
  const priceSlope = rememberPrice(rule.tokenId, ref);
  const liveRule = await updateLiveRuleState(rule, book, ref);
  if (!liveRule) return null;
  const gameMinute = await currentGameMinute(liveRule.marketId);
  const gapModel = await currentGapModelConfig();
  const risk = resolveEffectiveRiskSettings(liveRule, gameMinute, book, gapModel, movement);

  if (isBreakoutRule(liveRule.ruleType)) {
    const breakoutRef = referencePrice(book, liveRule.breakoutReferenceSource ?? liveRule.triggerType);
    const breakoutPrice = liveRule.breakoutPrice ?? liveRule.stopPrice;
    const spread = book.spread ?? (book.bestAsk !== null && book.bestBid !== null ? book.bestAsk - book.bestBid : null);
    const rollingOfi = getCachedOfi(liveRule.tokenId)?.rollingOfi30s ?? 0;
    const emergencyBreakoutMetrics = liveRule.aggressiveBreakout && gameMinute !== null
      ? emergencyStressMetrics(liveRule.tokenId, book, "ask", gameMinute)
      : null;
    const emergencyBreakoutTriggered = Boolean(
      liveRule.aggressiveBreakout
      && gameMinute !== null
      && emergencyBreakoutMetrics
      && shouldEmergencyBreakoutBuy({
        breakoutTrigger: breakoutPrice,
        midNow: emergencyBreakoutMetrics.midNow,
        mid5sAgo: emergencyBreakoutMetrics.mid5sAgo,
        emergencyScore: emergencyBreakoutMetrics.emergencyScore,
        gameMinute
      })
    );
    const shouldBuy = (breakoutRef !== null && breakoutRef >= breakoutPrice) || emergencyBreakoutTriggered;
    const spreadOk = emergencyBreakoutTriggered && gameMinute !== null && emergencyBreakoutMetrics
      ? emergencySpreadOk(spread, gameMinute, emergencyBreakoutMetrics.emergencyScore)
      : risk.disableMaxSpread || risk.maxSpread === null || risk.maxSpread === undefined || (spread !== null && spread <= risk.maxSpread);
    const ofiOk = !liveRule.useOfiConfirmation || rollingOfi >= (liveRule.ofiBuyThreshold ?? config.OFI_BUY_THRESHOLD);
    const slopeOk = !liveRule.usePriceSlopeConfirmation || (priceSlope !== null && priceSlope >= (liveRule.priceSlopeThreshold ?? 0));
    if (emergencyBreakoutTriggered && emergencyOnCooldown(liveRule.id, "breakout")) {
      return {
        triggered: false,
        referencePrice: breakoutRef,
        spread,
        rollingOfi,
        priceSlope,
        status: liveRule.status,
        emergencyMetrics: emergencyBreakoutMetrics,
        message: "Emergency breakout skipped during duplicate-protection cooldown"
      };
    }
    if (!shouldBuy) {
      return {
        triggered: false,
        referencePrice: breakoutRef,
        distanceToTrigger: breakoutRef === null ? null : breakoutPrice - breakoutRef,
        status: liveRule.status,
        emergencyMetrics: emergencyBreakoutMetrics
      };
    }
    if (!spreadOk || !ofiOk || !slopeOk) {
      return { triggered: false, referencePrice: breakoutRef, spread, rollingOfi, priceSlope, spreadOk, ofiOk, slopeOk, status: liveRule.status, effectiveRisk: risk, emergencyMetrics: emergencyBreakoutMetrics };
    }

    return withTokenExecutionLock(liveRule.tokenId, async () => {
      const executionBook = await freshestOrderBook(liveRule.tokenId, book);
      assertFreshEnoughForExecution(executionBook);
      const executionMovement = rememberMidpointMove(liveRule.tokenId, executionBook);
      const executionGameMinute = await currentGameMinute(liveRule.marketId);
      const executionRisk = resolveEffectiveRiskSettings(liveRule, executionGameMinute, executionBook, await currentGapModelConfig(), executionMovement);
      const executionRef = referencePrice(executionBook, liveRule.breakoutReferenceSource ?? liveRule.triggerType);
      const executionSpread = executionBook.spread ?? (executionBook.bestAsk !== null && executionBook.bestBid !== null ? executionBook.bestAsk - executionBook.bestBid : null);
      const executionEmergencyMetrics = liveRule.aggressiveBreakout && executionGameMinute !== null
        ? emergencyStressMetrics(liveRule.tokenId, executionBook, "ask", executionGameMinute)
        : null;
      const executionEmergencyBreakout = Boolean(
        liveRule.aggressiveBreakout
        && executionGameMinute !== null
        && executionEmergencyMetrics
        && shouldEmergencyBreakoutBuy({
          breakoutTrigger: breakoutPrice,
          midNow: executionEmergencyMetrics.midNow,
          mid5sAgo: executionEmergencyMetrics.mid5sAgo,
          emergencyScore: executionEmergencyMetrics.emergencyScore,
          gameMinute: executionGameMinute
        })
      );
      const executionNormalBreakout = executionRef !== null && executionRef >= breakoutPrice;
      const stillTriggered = executionNormalBreakout || executionEmergencyBreakout;
      const stillSpreadOk = executionEmergencyBreakout && executionGameMinute !== null && executionEmergencyMetrics
        ? emergencySpreadOk(executionSpread, executionGameMinute, executionEmergencyMetrics.emergencyScore)
        : executionRisk.disableMaxSpread || executionRisk.maxSpread === null || executionRisk.maxSpread === undefined || (executionSpread !== null && executionSpread <= executionRisk.maxSpread);
      if (!stillTriggered || !stillSpreadOk) {
        return {
          triggered: false,
          referencePrice: executionRef,
          spread: executionSpread,
          status: liveRule.status,
          effectiveRisk: executionRisk,
          emergencyMetrics: executionEmergencyMetrics,
          message: "Breakout skipped because the fresh orderbook no longer satisfies trigger conditions"
        };
      }

      const claimedRule = await claimRuleExecution(liveRule, executionRef);
      if (!claimedRule) return null;

      const useEmergencyExecution = Boolean(executionEmergencyBreakout && executionGameMinute !== null && executionEmergencyMetrics);
      const price = useEmergencyExecution && executionBook.bestAsk !== null && executionGameMinute !== null
        ? emergencyBuyLimit(executionBook.bestAsk, executionGameMinute)
        : marketableBuyPrice({ ...claimedRule, slippageLimit: executionRisk.slippageLimit }, executionBook);
      const sizeUsd = claimedRule.breakoutSizeUsd ?? claimedRule.positionSize;
      const size = price && price > 0 ? sizeUsd / price : 0;
      try {
        if (price === null || size <= 0) throw new Error("No executable buy price");
        if (useEmergencyExecution && executionEmergencyMetrics && executionGameMinute !== null) {
          markEmergencyAttempt(claimedRule.id, "breakout");
          console.log("[EmergencyBreakout]", emergencyLogPayload(claimedRule, executionEmergencyMetrics, executionGameMinute, {
            breakoutPrice,
            executionPrice: price,
            size,
            source: "MARKETABLE_LIMIT"
          }));
        }
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
            message: useEmergencyExecution && executionEmergencyMetrics
              ? `Emergency breakout buy triggered (score ${executionEmergencyMetrics.emergencyScore.toFixed(2)}, ${executionRisk.label})`
              : `Breakout buy triggered (${executionRisk.label})`,
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
  const spread = book.spread ?? (book.bestAsk !== null && book.bestBid !== null ? book.bestAsk - book.bestBid : null);
  const emergencyStopMetrics = liveRule.aggressivePnLProtection && gameMinute !== null
    ? emergencyStressMetrics(liveRule.tokenId, book, "bid", gameMinute)
    : null;
  const emergencyStopTriggered = Boolean(
    liveRule.aggressivePnLProtection
    && gameMinute !== null
    && emergencyStopMetrics
    && shouldEmergencyStopLoss({
      entryPrice: liveRule.entryPrice,
      stopPrice: hardStopPrice,
      midNow: emergencyStopMetrics.midNow,
      emergencyScore: emergencyStopMetrics.emergencyScore,
      gameMinute
    })
  );
  const triggerReason = forceExit ? "TAKE_PROFIT" : emergencyStopTriggered ? "EMERGENCY_STOP" : hardConfirmed ? "HARD_STOP" : softConfirmed ? "SOFT_OFI_STOP" : null;
  const spreadOk = triggerReason === "EMERGENCY_STOP" && gameMinute !== null && emergencyStopMetrics
    ? emergencySpreadOk(spread, gameMinute, emergencyStopMetrics.emergencyScore)
    : risk.disableMaxSpread || risk.maxSpread === null || risk.maxSpread === undefined || (spread !== null && spread <= risk.maxSpread);

  if (triggerReason === "EMERGENCY_STOP" && emergencyOnCooldown(liveRule.id, "stop")) {
    return {
      triggered: false,
      referencePrice: ref,
      rollingOfi,
      spread,
      spreadOk,
      status: liveRule.status,
      emergencyMetrics: emergencyStopMetrics,
      message: "Emergency stop skipped during duplicate-protection cooldown"
    };
  }

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
      requiredConfirmationTicks: config.STOP_OFI_CONFIRMATION_TICKS,
      effectiveRisk: risk,
      emergencyMetrics: emergencyStopMetrics
    };
  }

  return withTokenExecutionLock(liveRule.tokenId, async () => {
    const executionBook = await freshestOrderBook(liveRule.tokenId, book);
    assertFreshEnoughForExecution(executionBook);
    const executionRef = referencePrice(executionBook, liveRule.triggerType);
    const executionGameMinute = await currentGameMinute(liveRule.marketId);
    const executionMovement = rememberMidpointMove(liveRule.tokenId, executionBook);
    const executionRisk = resolveEffectiveRiskSettings(liveRule, executionGameMinute, executionBook, await currentGapModelConfig(), executionMovement);
    const executionSpread = executionBook.spread ?? (executionBook.bestAsk !== null && executionBook.bestBid !== null ? executionBook.bestAsk - executionBook.bestBid : null);
    const executionEmergencyMetrics = liveRule.aggressivePnLProtection && executionGameMinute !== null
      ? emergencyStressMetrics(liveRule.tokenId, executionBook, "bid", executionGameMinute)
      : null;
    const executionEmergencyStop = Boolean(
      liveRule.aggressivePnLProtection
      && executionGameMinute !== null
      && executionEmergencyMetrics
      && shouldEmergencyStopLoss({
        entryPrice: liveRule.entryPrice,
        stopPrice: hardStopPrice,
        midNow: executionEmergencyMetrics.midNow,
        emergencyScore: executionEmergencyMetrics.emergencyScore,
        gameMinute: executionGameMinute
      })
    );
    const useEmergencyExecution = Boolean(triggerReason === "EMERGENCY_STOP" || (triggerReason !== "TAKE_PROFIT" && executionEmergencyStop));
    const executionSpreadOk = useEmergencyExecution && executionGameMinute !== null && executionEmergencyMetrics
      ? emergencySpreadOk(executionSpread, executionGameMinute, executionEmergencyMetrics.emergencyScore)
      : executionRisk.disableMaxSpread || executionRisk.maxSpread === null || executionRisk.maxSpread === undefined || (executionSpread !== null && executionSpread <= executionRisk.maxSpread);

    if (triggerReason === "EMERGENCY_STOP" && !executionEmergencyStop) {
      return {
        triggered: false,
        referencePrice: executionRef,
        spread: executionSpread,
        status: liveRule.status,
        effectiveRisk: executionRisk,
        emergencyMetrics: executionEmergencyMetrics,
        message: "Emergency stop skipped because the fresh orderbook no longer satisfies stress conditions"
      };
    }

    const claimedRule = await claimRuleExecution(liveRule, executionRef);
    if (!claimedRule) return null;

    const position = claimedRule.positionId
    ? await prisma.position.findFirst({ where: { id: claimedRule.positionId, marketId } })
    : await prisma.position.findFirst({
      where: { tokenId: claimedRule.tokenId, marketId: claimedRule.marketId },
      orderBy: { updatedAt: "desc" }
    });

    const availableSize = Math.max(0, position?.size ?? claimedRule.positionSize);
    const exitSize = Math.min(availableSize, claimedRule.positionSize, claimedRule.maxSellSize);
    const emergencyPnLProtection = executionRisk.dynamic && executionRisk.gameMinute !== null && executionRisk.gameMinute >= 85;
    const price = useEmergencyExecution && executionBook.bestBid !== null && executionGameMinute !== null
      ? emergencySellLimit(executionBook.bestBid, executionGameMinute)
      : executionPrice({ ...claimedRule, slippageLimit: executionRisk.slippageLimit }, executionBook, emergencyPnLProtection);

    try {
      if (exitSize <= 0) throw new Error("No available position size to close");
      if (!executionSpreadOk) throw new Error(`Spread ${executionSpread?.toFixed(3) ?? "unknown"} exceeds effective max spread ${executionRisk.maxSpread}`);
      if (useEmergencyExecution && executionEmergencyMetrics && executionGameMinute !== null) {
        markEmergencyAttempt(claimedRule.id, "stop");
        console.log("[EmergencyStop]", emergencyLogPayload(claimedRule, executionEmergencyMetrics, executionGameMinute, {
          hardStopPrice,
          executionPrice: price,
          size: exitSize,
          source: "MARKETABLE_LIMIT"
        }));
      }

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
          message: `${triggerReason === "TAKE_PROFIT" ? "Take profit" : triggerReason === "EMERGENCY_STOP" ? `Emergency stop${executionEmergencyMetrics ? ` (score ${executionEmergencyMetrics.emergencyScore.toFixed(2)})` : ""}` : triggerReason === "SOFT_OFI_STOP" ? "Soft OFI stop" : claimedRule.ruleType === RuleType.TRAILING_STOP ? "Trailing hard stop" : "Hard stop"} triggered (${executionRisk.label})`,
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
    let liveBook: OrderBook | null = null;
    try {
      const cached = getCachedOrderBook(rule.tokenId);
      const book = cached.bestBid !== null || cached.bestAsk !== null ? cached : await fetchOrderBook(rule.tokenId);
      liveBook = book;
      livePrice = referencePrice(book, rule.triggerType) ?? livePrice;
    } catch {
      // Keep stored price if the live request is temporarily unavailable.
    }
    const activeStopPrice = rule.stopPrice;
    const distanceToStop = livePrice === null ? null : livePrice - activeStopPrice;
    const distanceToTrigger = livePrice === null ? null : activeStopPrice - livePrice;
    const effectiveRisk = resolveEffectiveRiskSettings(rule, await currentGameMinute(rule.marketId), null, await currentGapModelConfig());
    const emergencyMetrics = effectiveRisk.gameMinute !== null && liveBook
      ? emergencyStressMetrics(rule.tokenId, liveBook, isBreakoutRule(rule.ruleType) ? "ask" : "bid", effectiveRisk.gameMinute)
      : null;
    return {
      ...rule,
      currentPrice: livePrice,
      activeStopPrice,
      distanceToStop: isBreakoutRule(rule.ruleType) ? null : distanceToStop,
      distanceToTrigger: isBreakoutRule(rule.ruleType) ? distanceToTrigger : null,
      profitLocked: rule.ruleType === RuleType.TRAILING_STOP ? activeStopPrice > rule.entryPrice : null,
      displayStatus: ruleStatusForDisplay(rule.status),
      childRuleIds: rule.childRules.map((child) => child.id),
      gameMinute: effectiveRisk.gameMinute,
      effectiveSlippageLimit: effectiveRisk.slippageLimit,
      effectiveMaxSpread: effectiveRisk.disableMaxSpread ? null : effectiveRisk.maxSpread,
      effectiveDisableMaxSpread: effectiveRisk.disableMaxSpread,
      effectiveRiskLabel: effectiveRisk.label,
      emergencyStopEnabled: rule.aggressivePnLProtection,
      emergencyBreakoutEnabled: rule.aggressiveBreakout,
      emergencyMetrics
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
