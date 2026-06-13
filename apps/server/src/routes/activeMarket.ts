import { Router } from "express";
import type { Request } from "express";
import { z } from "zod";
import { asyncHandler } from "../lib/http.js";
import { activeMarketFromEnvText, enterMarketProfile, getActiveMarket, saveActiveMarket, type ActiveMarket } from "../services/activeMarketService.js";
import { invalidateAccountSummaryCache } from "../services/accountService.js";
import { resetChartPoints } from "../services/chartService.js";
import { appendMarketToLibrary, findMarketLibraryEntry, listMarketLibrary, removeMarketFromLibrary } from "../services/marketLibraryService.js";
import { resetConfiguredOrderBooks } from "../services/orderbookCache.js";

export const activeMarketRouter = Router();

const envTextSchema = z.object({
  envText: z.string().min(1, "envText is required")
});

const savedMarketSchema = z.object({
  marketId: z.string().min(1, "marketId is required")
});

const newMarketSchema = z.object({
  marketText: z.string().min(1, "marketText is required")
});

function requestProfile(req: Request) {
  const rawUrl = `${req.originalUrl} ${req.url}`;
  const profile = rawUrl.includes("profile=mlb") ? "mlb" : req.body?.profile;
  enterMarketProfile(profile);
  return profile ?? undefined;
}

async function activateMarket(market: ActiveMarket, profile: string | undefined) {
  const saved = await saveActiveMarket(market, profile);
  resetChartPoints(saved.outcomes.map((outcome) => outcome.tokenId));
  resetConfiguredOrderBooks();
  invalidateAccountSummaryCache();
  return saved;
}

activeMarketRouter.get("/", asyncHandler(async (req, res) => {
  const profile = requestProfile(req);
  res.json(await getActiveMarket({ profile }));
}));

activeMarketRouter.get("/saved", asyncHandler(async (req, res) => {
  res.json(await listMarketLibrary(requestProfile(req)));
}));

activeMarketRouter.post("/from-env", asyncHandler(async (req, res) => {
  const { envText } = envTextSchema.parse(req.body);
  const market = await activeMarketFromEnvText(envText, requestProfile(req));
  resetChartPoints(market.outcomes.map((outcome) => outcome.tokenId));
  resetConfiguredOrderBooks();
  invalidateAccountSummaryCache();
  res.json(market);
}));

activeMarketRouter.post("/from-saved", asyncHandler(async (req, res) => {
  const { marketId } = savedMarketSchema.parse(req.body);
  const profile = requestProfile(req);
  res.json(await activateMarket(await findMarketLibraryEntry(marketId, profile), profile));
}));

activeMarketRouter.post("/saved", asyncHandler(async (req, res) => {
  const { marketText } = newMarketSchema.parse(req.body);
  const profile = requestProfile(req);
  res.json(await activateMarket(await appendMarketToLibrary(marketText, profile), profile));
}));

activeMarketRouter.delete("/saved/:marketId", asyncHandler(async (req, res) => {
  const { marketId } = savedMarketSchema.parse(req.params);
  res.json(await removeMarketFromLibrary(marketId, requestProfile(req)));
}));
