import { TradeMode } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { config } from "../config.js";
import { asyncHandler } from "../lib/http.js";
import { checkGeoblock } from "../services/geoblockService.js";
import { getAppSettings, setSetting } from "../services/settingsService.js";

export const settingsRouter = Router();

const settingsSchema = z.object({
  tradeMode: z.nativeEnum(TradeMode).optional(),
  maxTotalExposure: z.coerce.number().positive().optional()
});

settingsRouter.get("/", asyncHandler(async (_req, res) => {
  const [settings, geo] = await Promise.all([getAppSettings(), checkGeoblock()]);
  res.json({ ...settings, geo });
}));

settingsRouter.get("/trading-mode", asyncHandler(async (_req, res) => {
  const [settings, geo] = await Promise.all([getAppSettings(), checkGeoblock()]);
  res.json({ tradeMode: settings.tradeMode, liveTradingAllowedByEnv: config.ENABLE_LIVE_TRADING, geo });
}));

settingsRouter.post("/trading-mode", asyncHandler(async (req, res) => {
  const body = z.object({ tradeMode: z.nativeEnum(TradeMode) }).parse(req.body);
  await setSetting("tradeMode", body.tradeMode);
  const [settings, geo] = await Promise.all([getAppSettings(), checkGeoblock()]);
  res.json({ tradeMode: settings.tradeMode, liveTradingAllowedByEnv: config.ENABLE_LIVE_TRADING, geo });
}));

settingsRouter.patch("/", asyncHandler(async (req, res) => {
  const body = settingsSchema.parse(req.body);
  if (body.tradeMode) await setSetting("tradeMode", body.tradeMode);
  if (body.maxTotalExposure !== undefined) await setSetting("maxTotalExposure", String(body.maxTotalExposure));
  res.json(await getAppSettings());
}));
