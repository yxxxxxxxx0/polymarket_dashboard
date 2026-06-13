import { Router } from "express";
import { asyncHandler } from "../lib/http.js";
import { checkGeoblock } from "../services/geoblockService.js";

export const geoRouter = Router();

geoRouter.get("/check", asyncHandler(async (_req, res) => {
  res.json(await checkGeoblock());
}));
