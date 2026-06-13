import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { ZodError } from "zod";
import { webOrigins } from "./config.js";
import { HttpError } from "./lib/http.js";
import { activeMarketRouter } from "./routes/activeMarket.js";
import { geoRouter } from "./routes/geo.js";
import { killSwitchRouter } from "./routes/killSwitch.js";
import { settingsRouter } from "./routes/settings.js";
import { singleMarketRouter, streamRouter } from "./routes/singleMarket.js";
import { stopLossRouter } from "./routes/stopLoss.js";
import { tradingRouter } from "./routes/trading.js";
import { withMarketProfile } from "./services/activeMarketService.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: webOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

function selectedProfile(req: express.Request) {
  const urlProfile = new URL(req.originalUrl, "http://localhost").searchParams.get("profile");
  return urlProfile ?? req.body?.profile ?? req.header("x-market-profile");
}

function profiled(router: express.Router) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    withMarketProfile(selectedProfile(req), () => router(req, res, next));
  };
}

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/api/active-market", profiled(activeMarketRouter));
app.use("/api/geo", geoRouter);
app.use("/api", profiled(singleMarketRouter));
app.use("/api/stream", profiled(streamRouter));
app.use("/api", profiled(tradingRouter));
app.use("/api/stop-loss", profiled(stopLossRouter));
app.use("/api/settings", settingsRouter);
app.use("/api/kill-switch", killSwitchRouter);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({ error: "Validation failed", details: error.flatten() });
    return;
  }
  if (error instanceof HttpError) {
    res.status(error.status).json({ error: error.message });
    return;
  }
  console.error(error);
  res.status(500).json({ error: error instanceof Error ? error.message : "Internal server error" });
};

app.use(errorHandler);
