import { OrderSide, RuleType, StopLossExecutionType, StopLossStatus, StopLossTriggerType, TradeMode } from "@prisma/client";
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { asyncHandler, requireString } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { enterMarketProfile } from "../services/activeMarketService.js";
import { createStopLossRule, evaluateStopLossRule, invalidateStopLossRuleCache, listStopLossRulesWithLiveState, stopLossStatus } from "../services/stopLossService.js";
import { assertConfiguredToken, marketScope, outcomeForToken } from "../services/singleMarketService.js";

export const stopLossRouter = Router();

const stopLossBaseSchema = z.object({
  ruleType: z.string().optional().default("STOP_LOSS").transform((value) => {
    const normalized = value.toUpperCase();
    return normalized === "BUY_STOP" ? "BREAKOUT_BUY" : normalized;
  }).pipe(z.nativeEnum(RuleType)),
  marketId: z.string().optional(),
  conditionId: z.string().optional(),
  tokenId: z.string().min(1),
  outcome: z.string().optional(),
  outcomeName: z.string().optional(),
  sideCurrentlyHeld: z.nativeEnum(OrderSide).default(OrderSide.BUY),
  positionSize: z.coerce.number().positive(),
  entryPrice: z.coerce.number().positive().max(1),
  currentPrice: z.coerce.number().min(0).max(1).optional(),
  stopPrice: z.coerce.number().min(0).max(1),
  hardStopPrice: z.coerce.number().min(0).max(1).optional(),
  softStopPrice: z.coerce.number().min(0).max(1).optional(),
  useOfiConfirmationForSoftStop: z.coerce.boolean().default(true).optional(),
  useOfiConfirmationForHardStop: z.coerce.boolean().default(false).optional(),
  stopPercentage: z.coerce.number().min(0).optional(),
  highestPriceSinceEntry: z.coerce.number().min(0).max(1).optional(),
  trailingPercentage: z.coerce.number().min(0).optional(),
  referencePrice: z.coerce.number().min(0).max(1).optional(),
  breakoutPercentage: z.coerce.number().min(0).optional(),
  breakoutPrice: z.coerce.number().min(0).max(1).optional(),
  breakoutReferenceSource: z.string().optional().transform((value) => value?.toUpperCase()).pipe(z.nativeEnum(StopLossTriggerType).optional()),
  breakoutSizeUsd: z.coerce.number().positive().optional(),
  useOfiConfirmation: z.coerce.boolean().default(false).optional(),
  ofiBuyThreshold: z.coerce.number().optional(),
  usePriceSlopeConfirmation: z.coerce.boolean().default(false).optional(),
  priceSlopeThreshold: z.coerce.number().optional(),
  maxSpread: z.coerce.number().min(0).max(1).optional(),
  disableMaxSpread: z.coerce.boolean().default(false).optional(),
  aggressivePnLProtection: z.coerce.boolean().default(false).optional(),
  aggressiveBreakout: z.coerce.boolean().default(false).optional(),
  strategySequenceId: z.string().optional(),
  parentRuleId: z.string().optional(),
  activationCondition: z.string().optional(),
  minFilledShares: z.coerce.number().positive().optional(),
  cancelAfterSeconds: z.coerce.number().int().positive().optional(),
  enabled: z.coerce.boolean().optional(),
  status: z.string().optional().transform((value) => value?.toUpperCase()).pipe(z.nativeEnum(StopLossStatus).optional()),
  breakevenEnabled: z.coerce.boolean().default(false).optional(),
  breakevenTriggerPrice: z.coerce.number().min(0).max(1).optional(),
  breakevenBuffer: z.coerce.number().min(0).max(1).default(0).optional(),
  takeProfitPrice: z.coerce.number().min(0).max(1).optional(),
  triggerType: z.string().transform((value) => value.toUpperCase()).pipe(z.nativeEnum(StopLossTriggerType)),
  executionType: z.string().transform((value) => value.toUpperCase()).pipe(z.nativeEnum(StopLossExecutionType)),
  slippageLimit: z.coerce.number().min(0).max(1).default(0.01),
  maxSellSize: z.coerce.number().positive(),
  positionId: z.string().optional()
});

const stopLossSchema = stopLossBaseSchema.refine((data) => data.maxSellSize <= data.positionSize, {
  message: "Max sell size cannot exceed position size.",
  path: ["maxSellSize"]
});

const stopLossPatchSchema = stopLossBaseSchema.partial().refine((data) => (
  data.maxSellSize === undefined
  || data.positionSize === undefined
  || data.maxSellSize <= data.positionSize
), {
  message: "Max sell size cannot exceed position size.",
  path: ["maxSellSize"]
});

function selectRequestProfile(req: Request) {
  const rawUrl = `${req.originalUrl} ${req.url}`;
  enterMarketProfile(rawUrl.includes("profile=mlb") ? "mlb" : req.body?.profile);
}

stopLossRouter.get("/", asyncHandler(async (_req, res) => {
  selectRequestProfile(_req);
  res.json(await listStopLossRulesWithLiveState());
}));

stopLossRouter.get("/status", asyncHandler(async (_req, res) => {
  selectRequestProfile(_req);
  res.json(await stopLossStatus());
}));

stopLossRouter.post("/", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const body = stopLossSchema.parse(req.body);
  assertConfiguredToken(body.tokenId);
  const { outcome, ...data } = body;
  res.json(await createStopLossRule({
    ...data,
    outcomeName: body.outcomeName ?? outcome ?? outcomeForToken(body.tokenId)
  }));
}));

stopLossRouter.delete("/", asyncHandler(async (_req, res) => {
  selectRequestProfile(_req);
  const { marketId } = marketScope();
  const rules = await prisma.stopLossRule.findMany({
    where: { marketId },
    select: { id: true }
  });
  const ruleIds = rules.map((rule) => rule.id);
  const triggerLogs = ruleIds.length > 0
    ? await prisma.stopLossTriggerLog.deleteMany({ where: { ruleId: { in: ruleIds } } })
    : { count: 0 };
  const deletedRules = await prisma.stopLossRule.deleteMany({ where: { marketId } });
  const deletedSequences = await prisma.strategySequence.deleteMany({ where: { marketId } });
  invalidateStopLossRuleCache(marketId);
  res.json({
    marketId,
    deletedRules: deletedRules.count,
    deletedTriggerLogs: triggerLogs.count,
    deletedSequences: deletedSequences.count
  });
}));

stopLossRouter.patch("/:id", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const id = requireString(req.params.id, "stop-loss id");
  const { marketId } = marketScope();
  const body = stopLossPatchSchema.parse(req.body);
  if (body.tokenId) assertConfiguredToken(body.tokenId);
  const existing = await prisma.stopLossRule.findFirstOrThrow({ where: { id, marketId } });
  const { outcome, marketId: _marketId, conditionId: _conditionId, ...data } = body;
  const updated = await prisma.stopLossRule.update({
    where: { id: existing.id },
    data: {
      ...data,
      outcomeName: body.outcomeName ?? outcome
    }
  });
  invalidateStopLossRuleCache(marketId);
  res.json(updated);
}));

stopLossRouter.delete("/:id", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const id = requireString(req.params.id, "stop-loss id");
  const { marketId } = marketScope();
  const existing = await prisma.stopLossRule.findFirstOrThrow({ where: { id, marketId } });
  const deleted = await prisma.stopLossRule.delete({ where: { id: existing.id } });
  invalidateStopLossRuleCache(marketId);
  res.json(deleted);
}));

stopLossRouter.post("/:id/enable", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const id = requireString(req.params.id, "stop-loss id");
  const { marketId } = marketScope();
  const existing = await prisma.stopLossRule.findFirstOrThrow({ where: { id, marketId } });
  const updated = await prisma.stopLossRule.update({
    where: { id: existing.id },
    data: {
      enabled: true,
      status: existing.ruleType === RuleType.BREAKOUT_BUY || existing.ruleType === RuleType.BUY_STOP ? StopLossStatus.ARMED : StopLossStatus.ENABLED,
      triggeredAt: null,
      triggeredPrice: null,
      orderSubmitted: false,
      orderId: null
    }
  });
  invalidateStopLossRuleCache(marketId);
  res.json(updated);
}));

stopLossRouter.post("/:id/disable", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const id = requireString(req.params.id, "stop-loss id");
  const { marketId } = marketScope();
  const existing = await prisma.stopLossRule.findFirstOrThrow({ where: { id, marketId } });
  const updated = await prisma.stopLossRule.update({
    where: { id: existing.id },
    data: { enabled: false, status: StopLossStatus.CANCELLED, cancelledAt: new Date() }
  });
  invalidateStopLossRuleCache(marketId);
  res.json(updated);
}));

stopLossRouter.post("/:id/evaluate", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const id = requireString(req.params.id, "stop-loss id");
  const tradeMode = req.body.tradeMode === TradeMode.LIVE ? TradeMode.LIVE : TradeMode.PAPER;
  res.json(await evaluateStopLossRule(id, tradeMode));
}));
