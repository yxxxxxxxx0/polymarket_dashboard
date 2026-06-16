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
import { createLimiter } from "../lib/concurrency.js";
import { TimeoutError, withTimeout } from "../lib/timeout.js";
import { getCachedOfi, getCachedOrderBook, onOrderBookUpdate, orderBookAgeMs } from "./orderbookCache.js";
import { getAppSettings } from "./settingsService.js";
import { assertConfiguredToken, marketScope, outcomeForToken } from "./singleMarketService.js";
import { evaluateStopLossConfirmation } from "./stopLossDecision.js";
import { cancelMarketOrders, cancelOrder, placeOrder } from "./tradingService.js";
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
const emergencyOrderbookHistory = new Map<string, Array<{
  timestamp: number;
  mid: number;
  spread: number;
  bestBid: number | null;
  bestAsk: number | null;
  bidDepthNear: number;
  askDepthNear: number;
}>>();
const emergencyCooldowns = new Map<string, number>();
const tokenEvaluationQueues = new Map<string, { running: boolean; pending: OrderBook | null }>();
const tokenExecutionLocks = new Set<string>();
const blockedLogCooldowns = new Map<string, number>();
const activeEvaluations = new Map<string, { startedAt: number }>();
const queuedRuleExecutions = new Set<string>();
const ruleEvaluationLimiter = createLimiter(config.STOP_LOSS_RULE_CONCURRENCY);
const ruleExecutionLimiter = createLimiter(config.ORDER_EXECUTION_CONCURRENCY);
let monitorTicksInFlight = 0;
let lastStopLossTickAt: string | null = null;
let lastStopLossTickDurationMs: number | null = null;
let lastBreakoutTickAt: string | null = null;
let lastBreakoutTickDurationMs: number | null = null;
let enabledRulesCache: { marketId: string; expiresAt: number; rules: StopLossRule[] } | null = null;
let subscribedToOrderBookUpdates = false;
let cachedTradeMode: { value: TradeMode; expiresAt: number } | null = null;
const gameMinuteCache = new Map<string, { expiresAt: number; gameMinute: number | null }>();
let gapModelCache: { expiresAt: number; value: GapModelConfig } | null = null;
const EMERGENCY_HISTORY_MS = 30_000;
const EMERGENCY_COOLDOWN_MS = 5_000;
const EMERGENCY_SPREAD_OVERRIDE_SCORE = 0.85;
const BLOCKED_LOG_COOLDOWN_MS = 5_000;
type EvaluationMode = "normal" | "fast" | "emergency";

function evaluationKey(rule: Pick<StopLossRule, "marketId" | "tokenId" | "id">) {
  return `${rule.marketId}:${rule.tokenId}:${rule.id}`;
}

function activeEvaluationSnapshot() {
  const now = Date.now();
  return [...activeEvaluations.entries()].map(([key, state]) => ({
    key,
    ageMs: now - state.startedAt
  }));
}

export function getMarketableSellLimit(bestBid: number, slippage: number): number {
  return Math.max(0.01, bestBid - slippage);
}

export function getMarketableBuyLimit(bestAsk: number, slippage: number): number {
  return Math.min(0.99, bestAsk + slippage);
}

export const executionAnchorByAction = {
  STOP_LOSS_SELL: "bestBid",
  TAKE_PROFIT_SELL: "bestBid",
  BREAKOUT_BUY: "bestAsk",
  DIP_BUY: "bestAsk",
  EMERGENCY_STOP_SELL: "bestBid",
  EMERGENCY_BREAKOUT_BUY: "bestAsk"
} as const;

export function staleLimitForMode(mode: EvaluationMode): number {
  if (mode === "emergency") return config.ORDERBOOK_STALE_MS_EMERGENCY;
  if (mode === "fast") return config.ORDERBOOK_STALE_MS_FAST;
  return config.ORDERBOOK_STALE_MS_NORMAL;
}

export function orderBookIsStale(ageMs: number | null, maxAgeMs: number): boolean {
  return ageMs === null || ageMs > maxAgeMs;
}

export function normalSpreadAllowed(spread: number | null, maxSpread: number | null | undefined, disableMaxSpread = false): boolean {
  return disableMaxSpread || maxSpread === null || maxSpread === undefined || (spread !== null && spread <= maxSpread);
}

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

  return getMarketableSellLimit(bestBid, rule.slippageLimit);
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
    bestBid: book.bestBid,
    bestAsk: book.bestAsk,
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
    bestBid: current.bestBid,
    bestAsk: current.bestAsk,
    bestBid5sAgo: fiveSecondsAgo.bestBid,
    bestAsk5sAgo: fiveSecondsAgo.bestAsk,
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
  return (spread !== null && spread <= maxSpread) || (config.ALLOW_EMERGENCY_SPREAD_OVERRIDE && emergencyScore >= EMERGENCY_SPREAD_OVERRIDE_SCORE);
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
    bestBid: metrics.bestBid === null ? null : Number(metrics.bestBid.toFixed(4)),
    bestAsk: metrics.bestAsk === null ? null : Number(metrics.bestAsk.toFixed(4)),
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

function executionLogPayload(params: {
  actionType: "STOP_LOSS" | "BREAKOUT_BUY" | "TAKE_PROFIT" | "EMERGENCY_STOP" | "EMERGENCY_BREAKOUT";
  book: OrderBook;
  limitPrice: number | null;
  slippage: number;
  triggerReferenceUsed: string;
  referencePrice: number | null;
  triggerThreshold: number | null;
  executionAnchor: "bestBid" | "bestAsk";
  orderId?: string | null;
  fillStatus?: string | null;
  retryCount?: number;
  blockedReason?: string | null;
}) {
  const spread = params.book.bestBid !== null && params.book.bestAsk !== null
    ? params.book.bestAsk - params.book.bestBid
    : params.book.spread;
  return {
    actionType: params.actionType,
    orderbookTimestamp: params.book.lastUpdateTime,
    localReceiveTimestamp: params.book.lastUpdateTime,
    orderbookAgeMs: orderBookAgeMs(params.book),
    bestBid: params.book.bestBid,
    bestAsk: params.book.bestAsk,
    spread,
    limitPrice: params.limitPrice,
    slippage: params.slippage,
    triggerReferenceUsed: params.triggerReferenceUsed,
    referencePrice: params.referencePrice,
    triggerThreshold: params.triggerThreshold,
    executionAnchor: params.executionAnchor,
    orderId: params.orderId ?? null,
    fillStatus: params.fillStatus ?? null,
    retryCount: params.retryCount ?? 0,
    blockedReason: params.blockedReason ?? null
  };
}

function orderIdFromPlaceOrderResponse(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  return String(
    "exchangeOrderId" in response
      ? response.exchangeOrderId
      : "order" in response && response.order && typeof response.order === "object" && "id" in response.order
        ? response.order.id
        : "id" in response
          ? response.id
          : ""
  ) || null;
}

function parseExecutionMeta(rawResponse?: string | null): Record<string, unknown> | null {
  if (!rawResponse) return null;
  try {
    const parsed = JSON.parse(rawResponse) as Record<string, unknown>;
    const execution = parsed.execution;
    return execution && typeof execution === "object" ? execution as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function shouldRetryEmergencyOrder(input: {
  orderSubmitted: boolean;
  orderId?: string | null;
  status: StopLossStatus;
  triggeredAt?: Date | null;
  latestActionType?: unknown;
  retryCount: number;
  nowMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
}) {
  const actionType = String(input.latestActionType ?? "");
  const emergency = actionType === "EMERGENCY_STOP" || actionType === "EMERGENCY_BREAKOUT";
  if (!emergency || !input.orderSubmitted || !input.orderId || !input.triggeredAt) return false;
  if (input.status !== StopLossStatus.ORDER_SUBMITTED && input.status !== StopLossStatus.SUBMITTED && input.status !== StopLossStatus.TRIGGERING) return false;
  const timeoutMs = input.timeoutMs ?? config.EMERGENCY_ORDER_TIMEOUT_MS;
  const maxRetries = input.maxRetries ?? config.EMERGENCY_MAX_RETRIES;
  if (input.retryCount >= maxRetries) return false;
  return (input.nowMs ?? Date.now()) - input.triggeredAt.getTime() >= timeoutMs;
}

async function logBlockedExecution(rule: StopLossRule, payload: ReturnType<typeof executionLogPayload>, tradeMode: TradeMode, message: string) {
  const key = `${rule.id}:${message}`;
  const now = Date.now();
  const lastLogged = blockedLogCooldowns.get(key) ?? 0;
  if (now - lastLogged < BLOCKED_LOG_COOLDOWN_MS) return;
  blockedLogCooldowns.set(key, now);
  await prisma.stopLossTriggerLog.create({
    data: {
      ruleId: rule.id,
      referencePrice: payload.referencePrice,
      executablePrice: payload.limitPrice,
      size: null,
      tradeMode,
      success: false,
      message,
      rawResponse: JSON.stringify({ execution: payload })
    }
  });
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

async function freshestOrderBook(tokenId: string, preferred?: OrderBook, maxAgeMs = config.ORDERBOOK_STALE_MS_NORMAL, forceRefresh = false) {
  const preferredAge = preferred ? orderBookAgeMs(preferred) : null;
  if (!forceRefresh && preferred && preferredAge !== null && preferredAge <= maxAgeMs) return preferred;

  const cached = getCachedOrderBook(tokenId);
  const cachedAge = orderBookAgeMs(cached);
  if (!forceRefresh && cachedAge !== null && cachedAge <= maxAgeMs) return cached;

  const fetched = await fetchOrderBook(tokenId, { force: true, maxAgeMs });
  const fetchedAge = orderBookAgeMs(fetched);
  if (fetchedAge === null || fetchedAge > maxAgeMs) {
    throw new Error(`Orderbook unavailable or stale for ${tokenId} (${fetchedAge ?? "unknown"}ms old, limit ${maxAgeMs}ms)`);
  }
  return fetched;
}

function assertFreshEnoughForExecution(book: OrderBook, maxAgeMs: number) {
  const age = orderBookAgeMs(book);
  if (age === null) {
    throw new Error("No fresh orderbook update is available for execution");
  }
  if (age > maxAgeMs) {
    throw new Error(`Orderbook is stale (${age}ms old, limit ${maxAgeMs}ms)`);
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

async function resetClaimedRuleForReevaluation(rule: StopLossRule, tradeMode: TradeMode, message: string, rawResponse?: unknown) {
  const status = isBreakoutRule(rule.ruleType) ? StopLossStatus.ARMED : StopLossStatus.ACTIVE;
  await prisma.stopLossTriggerLog.create({
    data: {
      ruleId: rule.id,
      referencePrice: rule.triggeredPrice,
      executablePrice: null,
      size: null,
      tradeMode,
      success: false,
      message,
      rawResponse: rawResponse === undefined ? undefined : JSON.stringify(rawResponse)
    }
  });
  const updated = await prisma.stopLossRule.update({
    where: { id: rule.id },
    data: {
      status,
      orderSubmitted: false,
      orderId: null,
      triggeredAt: null,
      triggeredPrice: null
    }
  });
  invalidateStopLossRuleCache(rule.marketId);
  return updated;
}

function enqueueRuleExecution(rule: StopLossRule, task: () => Promise<unknown>) {
  if (queuedRuleExecutions.has(rule.id)) {
    return {
      triggered: true,
      queued: true,
      deduped: true,
      status: rule.status,
      message: "Execution is already queued for this rule"
    };
  }

  queuedRuleExecutions.add(rule.id);
  void ruleExecutionLimiter(async () => {
    const started = Date.now();
    try {
      await task();
    } catch (error) {
      console.error("[stop-loss] queued execution failed", { ruleId: rule.id, tokenId: rule.tokenId, error });
      const message = error instanceof Error ? error.message : "Queued execution failed";
      await markRuleTerminal(rule.id, StopLossStatus.FAILED, message).catch((terminalError) => {
        console.error("[stop-loss] failed to mark queued execution terminal", { ruleId: rule.id, error: terminalError });
      });
    } finally {
      const duration = Date.now() - started;
      if (duration > config.MAX_RULE_EVAL_MS) {
        console.warn("[stop-loss] queued execution exceeded watchdog", { ruleId: rule.id, tokenId: rule.tokenId, durationMs: duration });
      }
      queuedRuleExecutions.delete(rule.id);
    }
  });

  return {
    triggered: true,
    queued: true,
    status: StopLossStatus.TRIGGERING,
    message: "Execution queued"
  };
}

async function evaluateRuleWithLock<T>(rule: StopLossRule, task: () => Promise<T>): Promise<T | null> {
  const key = evaluationKey(rule);
  const now = Date.now();
  const active = activeEvaluations.get(key);
  if (active) {
    const ageMs = now - active.startedAt;
    if (ageMs < config.MAX_RULE_EVAL_MS) {
      console.warn("[stop-loss] rule evaluation still running, skipping rule", { key, ageMs });
      return null;
    }
    console.warn("[stop-loss] stale evaluation lock cleared", { key, ageMs });
    activeEvaluations.delete(key);
  }

  activeEvaluations.set(key, { startedAt: now });
  try {
    return await withTimeout(() => task(), config.MAX_RULE_EVAL_MS, `stop-loss rule ${rule.id}`);
  } catch (error) {
    if (error instanceof TimeoutError) {
      console.error("[stop-loss] rule evaluation timed out", { ruleId: rule.id, tokenId: rule.tokenId, timeoutMs: config.MAX_RULE_EVAL_MS });
      return null;
    }
    throw error;
  } finally {
    const current = activeEvaluations.get(key);
    if (current?.startedAt === now) activeEvaluations.delete(key);
  }
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
  return getMarketableBuyLimit(book.bestAsk, rule.slippageLimit);
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

async function evaluateStopLossRuleRow(rule: StopLossRule, tradeMode: TradeMode = TradeMode.PAPER, bookOverride?: OrderBook, mode: EvaluationMode = bookOverride ? "fast" : "normal") {
  const { marketId } = marketScope();
  if (!rule || rule.marketId !== marketId || !rule.enabled || rule.orderSubmitted || rule.status === StopLossStatus.TRIGGERED || rule.status === StopLossStatus.TRIGGERING || rule.status === StopLossStatus.SUBMITTED || rule.status === StopLossStatus.ORDER_SUBMITTED || rule.status === StopLossStatus.FILLED || rule.status === StopLossStatus.CANCELLED || rule.status === StopLossStatus.INACTIVE_WAITING_FOR_PARENT) {
    return null;
  }

  const staleLimitMs = staleLimitForMode(mode);
  const book = await freshestOrderBook(rule.tokenId, bookOverride, staleLimitMs);
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
      && book.bestAsk !== null
      && emergencyBreakoutMetrics.bestAsk5sAgo !== null
      && shouldEmergencyBreakoutBuy({
        breakoutTrigger: breakoutPrice,
        triggerReference: book.bestAsk,
        triggerReference5sAgo: emergencyBreakoutMetrics.bestAsk5sAgo,
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
      const blockedReason = !spreadOk
        ? `Spread ${spread?.toFixed(3) ?? "unknown"} exceeds effective max spread ${risk.maxSpread}`
        : !ofiOk
          ? `OFI ${rollingOfi.toFixed(3)} below buy threshold ${liveRule.ofiBuyThreshold ?? config.OFI_BUY_THRESHOLD}`
          : `Price slope ${priceSlope?.toFixed(4) ?? "unknown"} below threshold ${liveRule.priceSlopeThreshold ?? 0}`;
      const candidatePrice = book.bestAsk === null ? null : getMarketableBuyLimit(book.bestAsk, risk.slippageLimit);
      await logBlockedExecution(liveRule, executionLogPayload({
        actionType: emergencyBreakoutTriggered ? "EMERGENCY_BREAKOUT" : "BREAKOUT_BUY",
        book,
        limitPrice: candidatePrice,
        slippage: emergencyBreakoutTriggered && gameMinute !== null ? getEmergencyParams(gameMinute).slippage : risk.slippageLimit,
        triggerReferenceUsed: liveRule.breakoutReferenceSource ?? liveRule.triggerType,
        referencePrice: breakoutRef,
        triggerThreshold: breakoutPrice,
        executionAnchor: executionAnchorByAction.BREAKOUT_BUY,
        blockedReason
      }), tradeMode, blockedReason);
      return { triggered: false, referencePrice: breakoutRef, spread, rollingOfi, priceSlope, spreadOk, ofiOk, slopeOk, status: liveRule.status, effectiveRisk: risk, emergencyMetrics: emergencyBreakoutMetrics };
    }

    const claimedRule = await claimRuleExecution(liveRule, breakoutRef);
    if (!claimedRule) return null;

    return enqueueRuleExecution(claimedRule, async () => {
      const executed = await withTokenExecutionLock(claimedRule.tokenId, async () => {
      const executionStaleLimitMs = staleLimitForMode(emergencyBreakoutTriggered ? "emergency" : mode);
      const executionBook = await freshestOrderBook(liveRule.tokenId, book, executionStaleLimitMs, emergencyBreakoutTriggered)
        .catch((error) => resetClaimedRuleForReevaluation(
          claimedRule,
          tradeMode,
          error instanceof Error ? error.message : "Orderbook unavailable during breakout execution"
        ).then(() => null));
      if (!executionBook) return null;
      assertFreshEnoughForExecution(executionBook, executionStaleLimitMs);
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
        && executionBook.bestAsk !== null
        && executionEmergencyMetrics.bestAsk5sAgo !== null
        && shouldEmergencyBreakoutBuy({
          breakoutTrigger: breakoutPrice,
          triggerReference: executionBook.bestAsk,
          triggerReference5sAgo: executionEmergencyMetrics.bestAsk5sAgo,
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
        const blockedReason = !stillTriggered
          ? "Fresh orderbook no longer satisfies breakout trigger"
          : `Spread ${executionSpread?.toFixed(3) ?? "unknown"} exceeds effective max spread ${executionRisk.maxSpread}`;
        await logBlockedExecution(claimedRule, executionLogPayload({
          actionType: executionEmergencyBreakout ? "EMERGENCY_BREAKOUT" : "BREAKOUT_BUY",
          book: executionBook,
          limitPrice: executionBook.bestAsk === null ? null : getMarketableBuyLimit(executionBook.bestAsk, executionRisk.slippageLimit),
          slippage: executionEmergencyBreakout && executionGameMinute !== null ? getEmergencyParams(executionGameMinute).slippage : executionRisk.slippageLimit,
          triggerReferenceUsed: liveRule.breakoutReferenceSource ?? liveRule.triggerType,
          referencePrice: executionRef,
          triggerThreshold: breakoutPrice,
          executionAnchor: executionAnchorByAction.BREAKOUT_BUY,
          blockedReason
        }), tradeMode, blockedReason);
        return resetClaimedRuleForReevaluation(claimedRule, tradeMode, "Breakout skipped because the fresh orderbook no longer satisfies trigger conditions", {
          execution: {
            referencePrice: executionRef,
            spread: executionSpread,
            effectiveRisk: executionRisk,
            emergencyMetrics: executionEmergencyMetrics,
            blockedReason
          }
        });
      }

      const useEmergencyExecution = Boolean(executionEmergencyBreakout && executionGameMinute !== null && executionEmergencyMetrics);
      const price = useEmergencyExecution && executionBook.bestAsk !== null && executionGameMinute !== null
        ? emergencyBuyLimit(executionBook.bestAsk, executionGameMinute)
        : marketableBuyPrice({ ...claimedRule, slippageLimit: executionRisk.slippageLimit }, executionBook);
      const sizeUsd = claimedRule.breakoutSizeUsd ?? claimedRule.positionSize;
      const size = price && price > 0 ? sizeUsd / price : 0;
      try {
        if (price === null || size <= 0) throw new Error("No executable buy price");
        const executionLog = executionLogPayload({
          actionType: useEmergencyExecution ? "EMERGENCY_BREAKOUT" : "BREAKOUT_BUY",
          book: executionBook,
          limitPrice: price,
          slippage: useEmergencyExecution && executionGameMinute !== null ? getEmergencyParams(executionGameMinute).slippage : executionRisk.slippageLimit,
          triggerReferenceUsed: liveRule.breakoutReferenceSource ?? liveRule.triggerType,
          referencePrice: executionRef,
          triggerThreshold: breakoutPrice,
          executionAnchor: executionAnchorByAction.BREAKOUT_BUY
        });
        console.log("[RuleExecution]", executionLog);
        if (useEmergencyExecution && executionEmergencyMetrics && executionGameMinute !== null) {
          markEmergencyAttempt(claimedRule.id, "breakout");
          console.log("[EmergencyBreakout]", emergencyLogPayload(claimedRule, executionEmergencyMetrics, executionGameMinute, {
            actionType: "EMERGENCY_BREAKOUT",
            breakoutPrice,
            triggerReferenceUsed: "bestAsk",
            triggerReference: executionBook.bestAsk,
            spread: executionSpread,
            slippage: getEmergencyParams(executionGameMinute).slippage,
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
        const orderId = orderIdFromPlaceOrderResponse(response);
        const persistedExecutionLog = { ...executionLog, orderId, fillStatus: "submitted" };
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
            rawResponse: JSON.stringify({ execution: persistedExecutionLog, response })
          }
        });
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

      if (executed === null) {
        return resetClaimedRuleForReevaluation(claimedRule, tradeMode, "Token execution lock busy; rule returned to active evaluation");
      }
      return executed;
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
    && book.bestBid !== null
    && shouldEmergencyStopLoss({
      entryPrice: liveRule.entryPrice,
      stopPrice: hardStopPrice,
      triggerReference: book.bestBid,
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
    if (triggerReason && !spreadOk) {
      const blockedReason = `Spread ${spread?.toFixed(3) ?? "unknown"} exceeds effective max spread ${risk.maxSpread}`;
      await logBlockedExecution(liveRule, executionLogPayload({
        actionType: triggerReason === "EMERGENCY_STOP" ? "EMERGENCY_STOP" : triggerReason === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_LOSS",
        book,
        limitPrice: book.bestBid === null ? null : getMarketableSellLimit(book.bestBid, risk.slippageLimit),
        slippage: triggerReason === "EMERGENCY_STOP" && gameMinute !== null ? getEmergencyParams(gameMinute).slippage : risk.slippageLimit,
        triggerReferenceUsed: liveRule.triggerType,
        referencePrice: ref,
        triggerThreshold: triggerReason === "TAKE_PROFIT" ? liveRule.takeProfitPrice : hardStopPrice,
        executionAnchor: executionAnchorByAction.STOP_LOSS_SELL,
        blockedReason
      }), tradeMode, blockedReason);
    }
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

  const claimedRule = await claimRuleExecution(liveRule, ref);
  if (!claimedRule) return null;

  return enqueueRuleExecution(claimedRule, async () => {
    const executed = await withTokenExecutionLock(claimedRule.tokenId, async () => {
    const executionStaleLimitMs = staleLimitForMode(triggerReason === "EMERGENCY_STOP" ? "emergency" : mode);
    const executionBook = await freshestOrderBook(liveRule.tokenId, book, executionStaleLimitMs, triggerReason === "EMERGENCY_STOP")
      .catch((error) => resetClaimedRuleForReevaluation(
        claimedRule,
        tradeMode,
        error instanceof Error ? error.message : "Orderbook unavailable during stop-loss execution"
      ).then(() => null));
    if (!executionBook) return null;
    assertFreshEnoughForExecution(executionBook, executionStaleLimitMs);
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
      && executionBook.bestBid !== null
      && shouldEmergencyStopLoss({
        entryPrice: liveRule.entryPrice,
        stopPrice: hardStopPrice,
        triggerReference: executionBook.bestBid,
        emergencyScore: executionEmergencyMetrics.emergencyScore,
        gameMinute: executionGameMinute
      })
    );
    const useEmergencyExecution = Boolean(triggerReason === "EMERGENCY_STOP" || (triggerReason !== "TAKE_PROFIT" && executionEmergencyStop));
    const executionSpreadOk = useEmergencyExecution && executionGameMinute !== null && executionEmergencyMetrics
      ? emergencySpreadOk(executionSpread, executionGameMinute, executionEmergencyMetrics.emergencyScore)
      : executionRisk.disableMaxSpread || executionRisk.maxSpread === null || executionRisk.maxSpread === undefined || (executionSpread !== null && executionSpread <= executionRisk.maxSpread);

    if (triggerReason === "EMERGENCY_STOP" && !executionEmergencyStop) {
      return resetClaimedRuleForReevaluation(claimedRule, tradeMode, "Emergency stop skipped because the fresh orderbook no longer satisfies stress conditions", {
        execution: {
          referencePrice: executionRef,
          spread: executionSpread,
          effectiveRisk: executionRisk,
          emergencyMetrics: executionEmergencyMetrics
        }
      });
    }

    if (!executionSpreadOk) {
      const blockedReason = `Spread ${executionSpread?.toFixed(3) ?? "unknown"} exceeds effective max spread ${executionRisk.maxSpread}`;
      await logBlockedExecution(claimedRule, executionLogPayload({
        actionType: useEmergencyExecution ? "EMERGENCY_STOP" : triggerReason === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_LOSS",
        book: executionBook,
        limitPrice: executionBook.bestBid === null ? null : getMarketableSellLimit(executionBook.bestBid, executionRisk.slippageLimit),
        slippage: useEmergencyExecution && executionGameMinute !== null ? getEmergencyParams(executionGameMinute).slippage : executionRisk.slippageLimit,
        triggerReferenceUsed: liveRule.triggerType,
        referencePrice: executionRef,
        triggerThreshold: triggerReason === "TAKE_PROFIT" ? liveRule.takeProfitPrice : hardStopPrice,
        executionAnchor: executionAnchorByAction.STOP_LOSS_SELL,
        blockedReason
      }), tradeMode, blockedReason);
      return resetClaimedRuleForReevaluation(claimedRule, tradeMode, blockedReason, {
        execution: {
          referencePrice: executionRef,
          spread: executionSpread,
          effectiveRisk: executionRisk,
          emergencyMetrics: executionEmergencyMetrics,
          blockedReason
        }
      });
    }

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
      const executionLog = executionLogPayload({
        actionType: useEmergencyExecution ? "EMERGENCY_STOP" : triggerReason === "TAKE_PROFIT" ? "TAKE_PROFIT" : "STOP_LOSS",
        book: executionBook,
        limitPrice: price,
        slippage: useEmergencyExecution && executionGameMinute !== null ? getEmergencyParams(executionGameMinute).slippage : executionRisk.slippageLimit,
        triggerReferenceUsed: liveRule.triggerType,
        referencePrice: executionRef,
        triggerThreshold: triggerReason === "TAKE_PROFIT" ? liveRule.takeProfitPrice : hardStopPrice,
        executionAnchor: executionAnchorByAction.STOP_LOSS_SELL
      });
      console.log("[RuleExecution]", executionLog);
      if (useEmergencyExecution && executionEmergencyMetrics && executionGameMinute !== null) {
        markEmergencyAttempt(claimedRule.id, "stop");
        console.log("[EmergencyStop]", emergencyLogPayload(claimedRule, executionEmergencyMetrics, executionGameMinute, {
          actionType: "EMERGENCY_STOP",
          hardStopPrice,
          triggerReferenceUsed: "bestBid",
          triggerReference: executionBook.bestBid,
          spread: executionSpread,
          slippage: getEmergencyParams(executionGameMinute).slippage,
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
          rawResponse: JSON.stringify({ execution: { ...executionLog, orderId: orderIdFromPlaceOrderResponse(response), fillStatus: claimedRule.executionType === StopLossExecutionType.CANCEL_ONLY ? "cancelled" : "submitted" }, response })
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

    if (executed === null) {
      return resetClaimedRuleForReevaluation(claimedRule, tradeMode, "Token execution lock busy; rule returned to active evaluation");
    }
    return executed;
  });
}

export async function evaluateStopLossRule(ruleId: string, tradeMode: TradeMode = TradeMode.PAPER, bookOverride?: OrderBook) {
  const rule = await prisma.stopLossRule.findUnique({ where: { id: ruleId } });
  if (!rule) return null;
  return evaluateRuleWithLock(rule, () => evaluateStopLossRuleRow(rule, tradeMode, bookOverride, bookOverride ? "fast" : "normal"));
}

export async function evaluateAllStopLossRules() {
  const { marketId } = marketScope();
  const tradeMode = await currentTradeMode();
  const enabledRules = await getEnabledStopRules(marketId);

  return Promise.all(enabledRules.map((rule) => ruleEvaluationLimiter(async () => {
    try {
      return await evaluateRuleWithLock(rule, () => evaluateStopLossRuleRow(rule, tradeMode, undefined, "normal"));
    } catch (error) {
      console.error("[stop-loss] rule evaluation failed", { ruleId: rule.id, tokenId: rule.tokenId, error });
      return null;
    }
  })));
}

export async function evaluateStopRulesForMarket(marketId: string, book?: OrderBook) {
  const tradeMode = await currentTradeMode();
  const enabledRules = await getEnabledStopRules(marketId, book?.tokenId);

  return Promise.all(enabledRules.map((rule) => ruleEvaluationLimiter(async () => {
    try {
      return await evaluateRuleWithLock(rule, () => evaluateStopLossRuleRow(rule, tradeMode, book, book ? "fast" : "normal"));
    } catch (error) {
      console.error("[stop-loss] event rule evaluation failed", { ruleId: rule.id, tokenId: rule.tokenId, error });
      return null;
    }
  })));
}

export function evaluatorDiagnostics() {
  return {
    stopLossEvaluating: activeEvaluations.size > 0,
    breakoutEvaluating: activeEvaluations.size > 0,
    monitorTicksInFlight,
    activeRuleEvaluations: activeEvaluationSnapshot(),
    queuedRuleExecutions: [...queuedRuleExecutions],
    lastStopLossTickAt,
    lastStopLossTickDurationMs,
    lastBreakoutTickAt,
    lastBreakoutTickDurationMs,
    activeTokenEvaluationQueues: [...tokenEvaluationQueues.entries()].filter(([, state]) => state.running).map(([tokenId]) => tokenId),
    pendingTokenEvaluationQueues: [...tokenEvaluationQueues.entries()].filter(([, state]) => state.pending).map(([tokenId]) => tokenId)
  };
}

export async function stopLossStatus() {
  const { marketId } = marketScope();
  const [enabled, triggered, failed, total] = await Promise.all([
    prisma.stopLossRule.count({ where: { marketId, enabled: true } }),
    prisma.stopLossRule.count({ where: { marketId, status: StopLossStatus.TRIGGERED } }),
    prisma.stopLossRule.count({ where: { marketId, status: StopLossStatus.FAILED } }),
    prisma.stopLossRule.count({ where: { marketId } })
  ]);
  return { marketId, total, enabled, triggered, failed, running: true, evaluator: evaluatorDiagnostics() };
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
    const orderbookAge = liveBook ? orderBookAgeMs(liveBook) : null;
    const staleLimitMs = staleLimitForMode(rule.aggressivePnLProtection || rule.aggressiveBreakout ? "fast" : "normal");
    const latestLog = rule.triggerLogs[0];
    const latestExecution = parseExecutionMeta(latestLog?.rawResponse);
    const latestBlockedLog = rule.triggerLogs.find((log) => !log.success);
    const triggerSource = isBreakoutRule(rule.ruleType) ? rule.breakoutReferenceSource ?? rule.triggerType : rule.triggerType;
    const triggerPrice = liveBook ? referencePrice(liveBook, triggerSource) : livePrice;
    const triggerThreshold = isBreakoutRule(rule.ruleType) ? rule.breakoutPrice ?? rule.stopPrice : rule.takeProfitPrice ?? rule.hardStopPrice ?? rule.stopPrice;
    const retryCount = rule.triggerLogs.filter((log) => log.message.startsWith("Emergency retry")).length;
    return {
      ...rule,
      currentPrice: livePrice,
      orderbookAgeMs: orderbookAge,
      orderbookStale: orderbookAge === null ? true : orderbookAge > staleLimitMs,
      orderbookStaleLimitMs: staleLimitMs,
      bestBid: liveBook?.bestBid ?? null,
      bestAsk: liveBook?.bestAsk ?? null,
      spread: liveBook?.bestBid !== null && liveBook?.bestBid !== undefined && liveBook?.bestAsk !== null && liveBook?.bestAsk !== undefined
        ? liveBook.bestAsk - liveBook.bestBid
        : liveBook?.spread ?? null,
      triggerSource,
      triggerPrice,
      triggerThreshold,
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
      emergencyMode: isBreakoutRule(rule.ruleType) ? rule.aggressiveBreakout : rule.aggressivePnLProtection,
      lastExecutionAttempt: latestLog?.attemptedAt ?? null,
      lastBlockedReason: latestBlockedLog?.message ?? null,
      lastLimitPrice: latestExecution?.limitPrice ?? null,
      lastSlippage: latestExecution?.slippage ?? null,
      retryCount,
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

async function retryTimedOutEmergencyOrders() {
  if (config.EMERGENCY_MAX_RETRIES <= 0) return [];
  const { marketId } = marketScope();
  const rules = await prisma.stopLossRule.findMany({
    where: {
      marketId,
      orderSubmitted: true,
      orderId: { not: null },
      status: { in: [StopLossStatus.ORDER_SUBMITTED, StopLossStatus.SUBMITTED, StopLossStatus.TRIGGERING] }
    },
    include: {
      triggerLogs: { orderBy: { attemptedAt: "desc" }, take: 20 }
    }
  });
  const tradeMode = await currentTradeMode();
  const results = [];
  for (const rule of rules) {
    const latestExecution = parseExecutionMeta(rule.triggerLogs[0]?.rawResponse);
    const retryCount = rule.triggerLogs.filter((log) => log.message.startsWith("Emergency retry")).length;
    const latestActionType = latestExecution?.actionType;
    const emergency = latestActionType === "EMERGENCY_STOP" || latestActionType === "EMERGENCY_BREAKOUT";
    if (!emergency) continue;

    const timedOut = rule.triggeredAt
      ? Date.now() - rule.triggeredAt.getTime() >= config.EMERGENCY_ORDER_TIMEOUT_MS
      : false;
    if (timedOut && retryCount >= config.EMERGENCY_MAX_RETRIES) {
      results.push(await markRuleTerminal(rule.id, StopLossStatus.FAILED, `Emergency order retry limit reached (${config.EMERGENCY_MAX_RETRIES})`));
      continue;
    }

    if (!shouldRetryEmergencyOrder({
      orderSubmitted: rule.orderSubmitted,
      orderId: rule.orderId,
      status: rule.status,
      triggeredAt: rule.triggeredAt,
      latestActionType,
      retryCount
    })) {
      continue;
    }

    await cancelOrder(rule.orderId as string, tradeMode).catch((error) => {
      console.error("Emergency retry cancel failed", error);
    });
    await prisma.stopLossTriggerLog.create({
      data: {
        ruleId: rule.id,
        referencePrice: rule.triggeredPrice,
        executablePrice: null,
        size: null,
        tradeMode,
        success: false,
        message: `Emergency retry ${retryCount + 1}: cancelled unfilled order after ${config.EMERGENCY_ORDER_TIMEOUT_MS}ms`,
        rawResponse: JSON.stringify({
          previousExecution: latestExecution,
          retryCount: retryCount + 1,
          timeoutMs: config.EMERGENCY_ORDER_TIMEOUT_MS
        })
      }
    });

    const resetRule = await prisma.stopLossRule.update({
      where: { id: rule.id },
      data: {
        orderSubmitted: false,
        orderId: null,
        triggeredAt: null,
        status: isBreakoutRule(rule.ruleType) ? StopLossStatus.ARMED : StopLossStatus.ACTIVE
      }
    });
    invalidateStopLossRuleCache(rule.marketId);
    const freshBook = await freshestOrderBook(rule.tokenId, undefined, staleLimitForMode("emergency"), true);
    results.push(await evaluateRuleWithLock(resetRule, () => evaluateStopLossRuleRow(resetRule, tradeMode, freshBook, "emergency")));
  }
  return results;
}

export function startStopLossMonitor() {
  if (!subscribedToOrderBookUpdates) {
    subscribedToOrderBookUpdates = true;
    onOrderBookUpdate((book) => {
      void queueStopEvaluation(book);
    });
  }
  setInterval(() => {
    const started = Date.now();
    monitorTicksInFlight += 1;
    lastStopLossTickAt = new Date(started).toISOString();
    lastBreakoutTickAt = lastStopLossTickAt;
    withTimeout(
      () => evaluateAllStopLossRules()
        .then(() => retryTimedOutEmergencyOrders())
        .then(() => reconcileStrategySequences()),
      config.MAX_FULL_TICK_MS,
      "stop-loss full tick"
    )
      .catch((error) => {
        console.error("[stop-loss] evaluation failed", error);
      })
      .finally(() => {
        const duration = Date.now() - started;
        lastStopLossTickDurationMs = duration;
        lastBreakoutTickDurationMs = duration;
        monitorTicksInFlight = Math.max(0, monitorTicksInFlight - 1);
      });
  }, config.STOP_LOSS_POLL_MS);
}
