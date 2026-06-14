import {
  OrderSide,
  RuleType,
  StopLossExecutionType,
  StopLossStatus,
  StopLossTriggerType,
  TradeMode,
  type OpenOrder,
  type StopLossRule
} from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertConfiguredToken, marketScope, outcomeForToken } from "./singleMarketService.js";
import { invalidateStopLossRuleCache } from "./stopLossService.js";
import { getLiveOpenOrders } from "./clobService.js";
import { cancelOrder } from "./tradingService.js";
import { getAppSettings } from "./settingsService.js";

const FULL_FILL_EPSILON = 1e-6;
const FULL_FILL_ONLY = "FULL_FILL_ONLY";
const PARTIAL_FILL_ALLOWED = "PARTIAL_FILL_ALLOWED";
const MIN_FILLED_SHARES = "MIN_FILLED_SHARES";
const PARENT_FULL_FILL = FULL_FILL_ONLY;

type ActivationCondition = typeof FULL_FILL_ONLY | typeof PARTIAL_FILL_ALLOWED | typeof MIN_FILLED_SHARES;

type BreakoutSequenceConfig = {
  tokenId: string;
  outcomeName?: string;
  referencePrice?: number;
  triggerPrice: number;
  stakeAmount: number;
  triggerType?: StopLossTriggerType;
  executionType?: StopLossExecutionType;
  slippageLimit?: number;
  maxSpread?: number;
  disableMaxSpread?: boolean;
  aggressiveBreakout?: boolean;
  activationCondition?: ActivationCondition;
  minFilledShares?: number;
  cancelAfterSeconds?: number;
  useOfiConfirmation?: boolean;
  ofiBuyThreshold?: number;
  usePriceSlopeConfirmation?: boolean;
  priceSlopeThreshold?: number;
};

type ChildExitConfig = {
  enabled?: boolean;
  stopPrice?: number;
  stopPercentage?: number;
  trailingPercentage?: number;
  activationPrice?: number;
  executionType?: StopLossExecutionType;
  slippageLimit?: number;
  maxSpread?: number;
  disableMaxSpread?: boolean;
  aggressivePnLProtection?: boolean;
  takeProfitPrice?: number;
};

export type StrategySequenceConfig = {
  breakout: BreakoutSequenceConfig;
  stopLoss?: ChildExitConfig;
  trailingStop?: ChildExitConfig;
};

export type FillActivationInput = {
  filledShareAmount: number;
  averageFillPrice: number;
  expectedShareAmount?: number;
  fullFill?: boolean;
  rawResponse?: unknown;
};

type TerminalRuleStatus = "CANCELLED" | "FAILED";

export function ruleStatusForDisplay(status: StopLossStatus) {
  switch (status) {
    case StopLossStatus.PENDING:
      return "pending";
    case StopLossStatus.ARMED:
    case StopLossStatus.ENABLED:
    case StopLossStatus.ACTIVE:
      return "active";
    case StopLossStatus.TRIGGERING:
    case StopLossStatus.SUBMITTED:
    case StopLossStatus.ORDER_SUBMITTED:
      return "order_submitted";
    case StopLossStatus.FILLED:
    case StopLossStatus.TRIGGERED:
      return "filled";
    case StopLossStatus.CANCELLED:
    case StopLossStatus.DISABLED:
      return "cancelled";
    case StopLossStatus.FAILED:
      return "failed";
    case StopLossStatus.INACTIVE_WAITING_FOR_PARENT:
      return "inactive_waiting_for_parent";
  }
}

export function isFullFill(fill: FillActivationInput) {
  if (fill.fullFill === true) return true;
  if (fill.fullFill === false) return false;
  if (fill.expectedShareAmount === undefined) return true;
  return fill.filledShareAmount + FULL_FILL_EPSILON >= fill.expectedShareAmount;
}

export function shouldActivateChildren(rule: Pick<StopLossRule, "activationCondition" | "minFilledShares">, fill: FillActivationInput) {
  const condition = rule.activationCondition ?? FULL_FILL_ONLY;
  if (condition === PARTIAL_FILL_ALLOWED) return fill.filledShareAmount > 0;
  if (condition === MIN_FILLED_SHARES) return fill.filledShareAmount + FULL_FILL_EPSILON >= (rule.minFilledShares ?? 0);
  return isFullFill(fill);
}

export function childActivationUpdate(rule: Pick<StopLossRule, "ruleType" | "stopPrice" | "stopPercentage" | "trailingPercentage" | "referencePrice">, fill: FillActivationInput) {
  const entryPrice = fill.averageFillPrice;
  const positionSize = fill.filledShareAmount;
  let stopPrice = rule.stopPrice;
  let highestPriceSinceEntry: number | undefined;

  if (rule.ruleType === RuleType.STOP_LOSS && rule.stopPercentage !== null && rule.stopPercentage !== undefined) {
    stopPrice = Math.max(0.01, entryPrice * (1 - rule.stopPercentage / 100));
  }

  if (rule.ruleType === RuleType.TRAILING_STOP) {
    highestPriceSinceEntry = Math.max(entryPrice, rule.referencePrice ?? entryPrice);
    const trailingPercentage = rule.trailingPercentage ?? rule.stopPercentage ?? 0;
    if (trailingPercentage > 0) {
      stopPrice = Math.max(0.01, highestPriceSinceEntry * (1 - trailingPercentage / 100));
    }
  }

  return {
    enabled: true,
    status: StopLossStatus.ACTIVE,
    positionSize,
    maxSellSize: positionSize,
    entryPrice,
    stopPrice,
    hardStopPrice: stopPrice,
    highestPriceSinceEntry,
    activatedAt: new Date()
  };
}

function childPlaceholderEntry(config: BreakoutSequenceConfig) {
  return Math.max(0.01, config.referencePrice ?? config.triggerPrice);
}

function stopFromPercentage(entry: number, percentage: number) {
  return Math.max(0.01, entry * (1 - percentage / 100));
}

async function logRuleTransition(ruleId: string, fromStatus: StopLossStatus | null, toStatus: StopLossStatus, message: string, rawResponse?: unknown) {
  await prisma.stopLossTriggerLog.create({
    data: {
      ruleId,
      referencePrice: null,
      executablePrice: null,
      size: null,
      tradeMode: TradeMode.PAPER,
      success: true,
      message: `${message}: ${fromStatus ? ruleStatusForDisplay(fromStatus) : "none"} -> ${ruleStatusForDisplay(toStatus)}`,
      rawResponse: rawResponse === undefined ? undefined : JSON.stringify(rawResponse)
    }
  });
}

async function updateRuleStatus(rule: StopLossRule, toStatus: StopLossStatus, data: Partial<StopLossRule> = {}, message = "Rule state transition", rawResponse?: unknown) {
  const updated = await prisma.stopLossRule.update({
    where: { id: rule.id },
    data: { ...data, status: toStatus }
  });
  await logRuleTransition(rule.id, rule.status, toStatus, message, rawResponse);
  invalidateStopLossRuleCache(rule.marketId);
  return updated;
}

export async function createStrategySequence(config: StrategySequenceConfig) {
  assertConfiguredToken(config.breakout.tokenId);
  const { marketId, conditionId } = marketScope();
  const outcomeName = config.breakout.outcomeName ?? outcomeForToken(config.breakout.tokenId);
  const placeholderEntry = childPlaceholderEntry(config.breakout);
  const triggerType = config.breakout.triggerType ?? StopLossTriggerType.BEST_BID;
  const executionType = config.breakout.executionType ?? StopLossExecutionType.MARKETABLE_LIMIT;
  const slippageLimit = config.breakout.slippageLimit ?? 0.01;

  const result = await prisma.$transaction(async (tx) => {
    const activationCondition = config.breakout.activationCondition ?? FULL_FILL_ONLY;
    const sequence = await tx.strategySequence.create({
      data: { marketId, conditionId, tokenId: config.breakout.tokenId, outcomeName, status: StopLossStatus.ACTIVE, activationCondition }
    });
    const parent = await tx.stopLossRule.create({
      data: {
        ruleType: RuleType.BREAKOUT_BUY,
        strategySequenceId: sequence.id,
        activationCondition,
        minFilledShares: config.breakout.minFilledShares,
        cancelAfterSeconds: config.breakout.cancelAfterSeconds,
        marketId,
        conditionId,
        tokenId: config.breakout.tokenId,
        outcomeName,
        currentPrice: config.breakout.referencePrice,
        referencePrice: config.breakout.referencePrice,
        sideCurrentlyHeld: OrderSide.BUY,
        positionSize: config.breakout.stakeAmount,
        entryPrice: placeholderEntry,
        stopPrice: config.breakout.triggerPrice,
        breakoutPrice: config.breakout.triggerPrice,
        breakoutReferenceSource: triggerType,
        breakoutSizeUsd: config.breakout.stakeAmount,
        useOfiConfirmation: config.breakout.useOfiConfirmation ?? false,
        ofiBuyThreshold: config.breakout.ofiBuyThreshold,
        usePriceSlopeConfirmation: config.breakout.usePriceSlopeConfirmation ?? false,
        priceSlopeThreshold: config.breakout.priceSlopeThreshold,
        maxSpread: config.breakout.maxSpread,
        disableMaxSpread: config.breakout.disableMaxSpread ?? false,
        aggressiveBreakout: config.breakout.aggressiveBreakout ?? false,
        triggerType,
        executionType,
        slippageLimit,
        maxSellSize: config.breakout.stakeAmount,
        enabled: true,
        status: StopLossStatus.ARMED
      }
    });

    const children = [];
    if (config.stopLoss?.enabled !== false) {
      const stopPercentage = config.stopLoss?.stopPercentage;
      const stopPrice = config.stopLoss?.stopPrice ?? stopFromPercentage(placeholderEntry, stopPercentage ?? 10);
      children.push(await tx.stopLossRule.create({
        data: {
          ruleType: RuleType.STOP_LOSS,
          strategySequenceId: sequence.id,
          parentRuleId: parent.id,
          activationCondition,
          marketId,
          conditionId,
          tokenId: config.breakout.tokenId,
          outcomeName,
          currentPrice: config.breakout.referencePrice,
          sideCurrentlyHeld: OrderSide.BUY,
          positionSize: 1,
          entryPrice: placeholderEntry,
          stopPrice,
          hardStopPrice: stopPrice,
          stopPercentage,
          triggerType,
          executionType: config.stopLoss?.executionType ?? executionType,
          slippageLimit: config.stopLoss?.slippageLimit ?? slippageLimit,
          maxSpread: config.stopLoss?.maxSpread,
          disableMaxSpread: config.stopLoss?.disableMaxSpread ?? false,
          aggressivePnLProtection: config.stopLoss?.aggressivePnLProtection ?? false,
          maxSellSize: 1,
          enabled: false,
          status: StopLossStatus.INACTIVE_WAITING_FOR_PARENT
        }
      }));
    }

    if (config.trailingStop?.enabled !== false) {
      const trailingPercentage = config.trailingStop?.trailingPercentage ?? 10;
      const activationPrice = config.trailingStop?.activationPrice ?? placeholderEntry;
      const stopPrice = stopFromPercentage(activationPrice, trailingPercentage);
      children.push(await tx.stopLossRule.create({
        data: {
          ruleType: RuleType.TRAILING_STOP,
          strategySequenceId: sequence.id,
          parentRuleId: parent.id,
          activationCondition,
          marketId,
          conditionId,
          tokenId: config.breakout.tokenId,
          outcomeName,
          currentPrice: config.breakout.referencePrice,
          sideCurrentlyHeld: OrderSide.BUY,
          positionSize: 1,
          entryPrice: placeholderEntry,
          stopPrice,
          hardStopPrice: stopPrice,
          stopPercentage: trailingPercentage,
          trailingPercentage,
          referencePrice: activationPrice,
          highestPriceSinceEntry: activationPrice,
          takeProfitPrice: config.trailingStop?.takeProfitPrice,
          triggerType,
          executionType: config.trailingStop?.executionType ?? executionType,
          slippageLimit: config.trailingStop?.slippageLimit ?? slippageLimit,
          maxSpread: config.trailingStop?.maxSpread,
          disableMaxSpread: config.trailingStop?.disableMaxSpread ?? false,
          aggressivePnLProtection: config.trailingStop?.aggressivePnLProtection ?? false,
          maxSellSize: 1,
          enabled: false,
          status: StopLossStatus.INACTIVE_WAITING_FOR_PARENT
        }
      }));
    }
    return { sequence, parent, children };
  });

  await logRuleTransition(result.parent.id, null, StopLossStatus.ARMED, "Strategy sequence parent created");
  for (const child of result.children) await logRuleTransition(child.id, null, StopLossStatus.INACTIVE_WAITING_FOR_PARENT, "Strategy sequence child created");
  invalidateStopLossRuleCache(marketId);
  return result;
}

export async function markRuleOrderSubmitted(ruleId: string, orderId?: string | null, rawResponse?: unknown) {
  const rule = await prisma.stopLossRule.findUnique({ where: { id: ruleId } });
  if (!rule) return null;
  return updateRuleStatus(rule, StopLossStatus.ORDER_SUBMITTED, { orderId: orderId ?? rule.orderId, orderSubmitted: true }, "Rule order submitted", rawResponse);
}

export async function markRuleTerminal(ruleId: string, status: TerminalRuleStatus, message: string) {
  const rule = await prisma.stopLossRule.findUnique({ where: { id: ruleId } });
  if (!rule || rule.status === StopLossStatus.FILLED || rule.status === status) return rule;
  return updateRuleStatus(rule, status, { enabled: false, cancelledAt: status === StopLossStatus.CANCELLED ? new Date() : rule.cancelledAt }, message);
}

export async function recordBreakoutFill(ruleId: string, fill: FillActivationInput) {
  const parent = await prisma.stopLossRule.findUnique({ where: { id: ruleId }, include: { childRules: true } });
  if (!parent) return null;
  if (!shouldActivateChildren(parent, fill)) {
    const updated = await prisma.stopLossRule.update({
      where: { id: parent.id },
      data: { filledShareAmount: fill.filledShareAmount, averageFillPrice: fill.averageFillPrice }
    });
    await logRuleTransition(parent.id, parent.status, parent.status, "Fill recorded; activation condition not met", fill.rawResponse);
    return { parent: updated, activatedChildren: [] };
  }

  const filledAt = parent.filledAt ?? new Date();
  const updatedParent = parent.status === StopLossStatus.FILLED
    ? parent
    : await updateRuleStatus(parent, StopLossStatus.FILLED, {
      enabled: false,
      filledShareAmount: fill.filledShareAmount,
      averageFillPrice: fill.averageFillPrice,
      filledAt
    }, "Breakout parent filled", fill.rawResponse);

  const waitingChildren = await prisma.stopLossRule.findMany({
    where: { parentRuleId: parent.id, status: StopLossStatus.INACTIVE_WAITING_FOR_PARENT, enabled: false }
  });
  const activatedChildren = [];
  for (const child of waitingChildren) {
    activatedChildren.push(await updateRuleStatus(child, StopLossStatus.ACTIVE, childActivationUpdate(child, fill), "Child rule activated from parent fill"));
  }
  if (parent.strategySequenceId) {
    await prisma.strategySequence.update({ where: { id: parent.strategySequenceId }, data: { status: StopLossStatus.ACTIVE } }).catch(() => undefined);
  }
  invalidateStopLossRuleCache(parent.marketId);
  return { parent: updatedParent, activatedChildren };
}

function fillFromPaperOrder(order: OpenOrder): FillActivationInput | null {
  const status = order.status.toUpperCase();
  const filledShareAmount = Math.max(0, order.size - order.remainingSize);
  if (status === "FILLED" || order.remainingSize <= FULL_FILL_EPSILON) {
    return { filledShareAmount: order.size, averageFillPrice: order.price, expectedShareAmount: order.size, fullFill: true, rawResponse: order };
  }
  if (filledShareAmount > 0) return { filledShareAmount, averageFillPrice: order.price, expectedShareAmount: order.size, fullFill: false, rawResponse: order };
  return null;
}

function liveOrderId(order: Record<string, unknown>) {
  return String(order.id ?? order.orderID ?? "");
}

function fillFromLiveOrder(order: Record<string, unknown>): FillActivationInput | null {
  const size = Number(order.original_size ?? order.size ?? 0);
  const matched = Number(order.size_matched ?? order.matched_size ?? 0);
  const price = Number(order.price ?? 0);
  const status = String(order.status ?? "").toUpperCase();
  if (matched > 0 && size > 0 && price > 0) {
    return { filledShareAmount: matched, averageFillPrice: price, expectedShareAmount: size, fullFill: matched + FULL_FILL_EPSILON >= size || status === "FILLED" || status === "MATCHED", rawResponse: order };
  }
  return null;
}

async function reconcileSubmittedParent(rule: StopLossRule, liveOrdersById: Map<string, Record<string, unknown>>) {
  if (!rule.orderId) return null;
  const paperOrder = await prisma.openOrder.findFirst({ where: { OR: [{ id: rule.orderId }, { exchangeOrderId: rule.orderId }] } });
  if (paperOrder) {
    const fill = fillFromPaperOrder(paperOrder);
    if (fill?.fullFill) return recordBreakoutFill(rule.id, fill);
    if (fill && fill.filledShareAmount > 0) return recordBreakoutFill(rule.id, fill);
  }
  const liveOrder = liveOrdersById.get(rule.orderId);
  if (liveOrder) {
    const fill = fillFromLiveOrder(liveOrder);
    if (fill?.fullFill) return recordBreakoutFill(rule.id, fill);
    if (fill && fill.filledShareAmount > 0) return recordBreakoutFill(rule.id, fill);
  }
  if (rule.cancelAfterSeconds && rule.triggeredAt) {
    const submittedMs = rule.triggeredAt.getTime();
    if (Date.now() - submittedMs >= rule.cancelAfterSeconds * 1000) {
      const settings = await getAppSettings().catch(() => ({ tradeMode: TradeMode.PAPER }));
      await cancelOrder(rule.orderId, settings.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER).catch(() => undefined);
      return markRuleTerminal(rule.id, StopLossStatus.CANCELLED, `Breakout not filled after ${rule.cancelAfterSeconds}s`);
    }
  }
  return null;
}

export async function handleSequenceExitFilled(ruleId: string) {
  const filledExit = await prisma.stopLossRule.findUnique({ where: { id: ruleId } });
  if (!filledExit?.strategySequenceId || !filledExit.parentRuleId) return null;
  const updatedExit = await updateRuleStatus(filledExit, StopLossStatus.FILLED, {
    enabled: false,
    filledAt: new Date()
  }, "Sequence exit filled");
  const siblings = await prisma.stopLossRule.findMany({
    where: {
      strategySequenceId: filledExit.strategySequenceId,
      parentRuleId: filledExit.parentRuleId,
      id: { not: filledExit.id },
      status: {
        in: [
          StopLossStatus.ACTIVE,
          StopLossStatus.ENABLED,
          StopLossStatus.ARMED,
          StopLossStatus.TRIGGERING,
          StopLossStatus.SUBMITTED,
          StopLossStatus.ORDER_SUBMITTED,
          StopLossStatus.INACTIVE_WAITING_FOR_PARENT
        ]
      }
    }
  });
  const settings = siblings.some((sibling) => sibling.orderId)
    ? await getAppSettings().catch(() => ({ tradeMode: TradeMode.PAPER }))
    : { tradeMode: TradeMode.PAPER };
  for (const sibling of siblings) {
    if (sibling.orderId) {
      await cancelOrder(sibling.orderId, settings.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER).catch(() => undefined);
    }
    await updateRuleStatus(sibling, StopLossStatus.CANCELLED, {
      enabled: false,
      cancelledAt: new Date()
    }, `OCO cancelled after ${filledExit.ruleType} filled`);
  }
  await prisma.strategySequence.update({
    where: { id: filledExit.strategySequenceId },
    data: { status: StopLossStatus.FILLED }
  }).catch(() => undefined);
  invalidateStopLossRuleCache(filledExit.marketId);
  return updatedExit;
}

function sequenceTimeline(rules: Array<StopLossRule>) {
  const parent = rules.find((rule) => rule.ruleType === RuleType.BREAKOUT_BUY || rule.ruleType === RuleType.BUY_STOP);
  const exits = rules.filter((rule) => rule.parentRuleId === parent?.id);
  const oneExitFilled = exits.some((rule) => rule.status === StopLossStatus.FILLED || rule.status === StopLossStatus.TRIGGERED);
  return [
    { key: "waiting", label: "waiting", done: Boolean(parent), active: parent?.status === StopLossStatus.ARMED || parent?.status === StopLossStatus.ACTIVE },
    { key: "submitted", label: "submitted", done: Boolean(parent?.orderSubmitted || parent?.status === StopLossStatus.ORDER_SUBMITTED || parent?.status === StopLossStatus.FILLED), active: parent?.status === StopLossStatus.ORDER_SUBMITTED },
    { key: "filled", label: "filled", done: parent?.status === StopLossStatus.FILLED, active: false },
    { key: "exits_active", label: "exits active", done: exits.some((rule) => rule.status === StopLossStatus.ACTIVE || rule.status === StopLossStatus.FILLED || rule.status === StopLossStatus.TRIGGERED), active: exits.some((rule) => rule.status === StopLossStatus.ACTIVE) },
    { key: "one_exit_filled", label: "one exit filled", done: oneExitFilled, active: false },
    { key: "complete", label: "sequence complete", done: oneExitFilled, active: false }
  ];
}

export async function reconcileStrategySequences() {
  const { marketId } = marketScope();
  const parents = await prisma.stopLossRule.findMany({
    where: {
      marketId,
      ruleType: RuleType.BREAKOUT_BUY,
      strategySequenceId: { not: null },
      status: { in: [StopLossStatus.ORDER_SUBMITTED, StopLossStatus.SUBMITTED, StopLossStatus.FILLED] }
    }
  });
  let liveOrdersById = new Map<string, Record<string, unknown>>();
  try {
    const liveOrders = await getLiveOpenOrders();
    if (Array.isArray(liveOrders)) {
      const entries: Array<[string, Record<string, unknown>]> = (liveOrders as unknown[])
        .map((order) => order as Record<string, unknown>)
        .map((order) => [liveOrderId(order), order] as [string, Record<string, unknown>])
        .filter(([id]) => Boolean(id));
      liveOrdersById = new Map(entries);
    }
  } catch {
    liveOrdersById = new Map();
  }
  const results = [];
  for (const parent of parents) {
    if (parent.status === StopLossStatus.FILLED && parent.filledShareAmount && parent.averageFillPrice) {
      results.push(await recordBreakoutFill(parent.id, { filledShareAmount: parent.filledShareAmount, averageFillPrice: parent.averageFillPrice, fullFill: true }));
      continue;
    }
    results.push(await reconcileSubmittedParent(parent, liveOrdersById));
  }
  return results.filter(Boolean);
}

export async function listStrategySequences() {
  const { marketId } = marketScope();
  const sequences = await prisma.strategySequence.findMany({
    where: { marketId },
    orderBy: { createdAt: "desc" },
    include: { rules: { orderBy: [{ parentRuleId: "asc" }, { createdAt: "asc" }], include: { childRules: true } } }
  });
  return sequences.map((sequence) => ({
    ...sequence,
    displayStatus: ruleStatusForDisplay(sequence.status),
    timeline: sequenceTimeline(sequence.rules),
    rules: sequence.rules.map((rule) => ({ ...rule, displayStatus: ruleStatusForDisplay(rule.status), childRuleIds: rule.childRules.map((child) => child.id) }))
  }));
}
