import { StopLossExecutionType, StopLossTriggerType } from "@prisma/client";
import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { asyncHandler, requireString } from "../lib/http.js";
import { prisma } from "../lib/prisma.js";
import { enterMarketProfile } from "../services/activeMarketService.js";
import { createStrategySequence, listStrategySequences, recordBreakoutFill, reconcileStrategySequences } from "../services/strategySequenceService.js";

export const strategySequenceRouter = Router();

const triggerTypeSchema = z.string().optional().transform((value) => value?.toUpperCase()).pipe(z.nativeEnum(StopLossTriggerType).optional());
const executionTypeSchema = z.string().optional().transform((value) => value?.toUpperCase()).pipe(z.nativeEnum(StopLossExecutionType).optional());
const childSchema = z.object({
  enabled: z.coerce.boolean().optional(),
  stopPrice: z.coerce.number().min(0).max(1).optional(),
  stopPercentage: z.coerce.number().min(0).optional(),
  trailingPercentage: z.coerce.number().min(0).optional(),
  activationPrice: z.coerce.number().min(0).max(1).optional(),
  executionType: executionTypeSchema,
  slippageLimit: z.coerce.number().min(0).max(1).optional(),
  maxSpread: z.coerce.number().min(0).max(1).optional(),
  disableMaxSpread: z.coerce.boolean().optional(),
  aggressivePnLProtection: z.coerce.boolean().optional(),
  takeProfitPrice: z.coerce.number().min(0).max(1).optional()
});
const sequenceSchema = z.object({
  breakout: z.object({
    tokenId: z.string().min(1),
    outcomeName: z.string().optional(),
    referencePrice: z.coerce.number().min(0).max(1).optional(),
    triggerPrice: z.coerce.number().min(0).max(1),
    stakeAmount: z.coerce.number().positive(),
    triggerType: triggerTypeSchema,
    executionType: executionTypeSchema,
    slippageLimit: z.coerce.number().min(0).max(1).optional(),
    maxSpread: z.coerce.number().min(0).max(1).optional(),
    disableMaxSpread: z.coerce.boolean().optional(),
    aggressiveBreakout: z.coerce.boolean().optional(),
    activationCondition: z.enum(["FULL_FILL_ONLY", "PARTIAL_FILL_ALLOWED", "MIN_FILLED_SHARES"]).optional(),
    minFilledShares: z.coerce.number().positive().optional(),
    cancelAfterSeconds: z.coerce.number().int().positive().optional(),
    useOfiConfirmation: z.coerce.boolean().optional(),
    ofiBuyThreshold: z.coerce.number().optional(),
    usePriceSlopeConfirmation: z.coerce.boolean().optional(),
    priceSlopeThreshold: z.coerce.number().optional()
  }),
  stopLoss: childSchema.optional(),
  trailingStop: childSchema.optional()
});
const fillSchema = z.object({
  filledShareAmount: z.coerce.number().min(0),
  averageFillPrice: z.coerce.number().positive().max(1),
  expectedShareAmount: z.coerce.number().positive().optional(),
  fullFill: z.coerce.boolean().optional(),
  rawResponse: z.unknown().optional()
});

function selectRequestProfile(req: Request) {
  const rawUrl = `${req.originalUrl} ${req.url}`;
  enterMarketProfile(rawUrl.includes("profile=mlb") ? "mlb" : req.body?.profile);
}

strategySequenceRouter.get("/", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  await reconcileStrategySequences();
  res.json(await listStrategySequences());
}));

strategySequenceRouter.post("/", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  res.json(await createStrategySequence(sequenceSchema.parse(req.body)));
}));

strategySequenceRouter.post("/reconcile", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  res.json(await reconcileStrategySequences());
}));

strategySequenceRouter.post("/rules/:id/fill", asyncHandler(async (req, res) => {
  selectRequestProfile(req);
  const id = requireString(req.params.id, "rule id");
  const existing = await prisma.stopLossRule.findUniqueOrThrow({ where: { id } });
  res.json(await recordBreakoutFill(existing.id, fillSchema.parse(req.body)));
}));
