import cors from "cors";
import express, { type ErrorRequestHandler } from "express";
import helmet from "helmet";
import morgan from "morgan";
import { ZodError } from "zod";
import { config, webOrigins } from "./config.js";
import { HttpError } from "./lib/http.js";
import { activeMarketRouter } from "./routes/activeMarket.js";
import { geoRouter } from "./routes/geo.js";
import { killSwitchRouter } from "./routes/killSwitch.js";
import { settingsRouter } from "./routes/settings.js";
import { singleMarketRouter, streamRouter } from "./routes/singleMarket.js";
import { stopLossRouter } from "./routes/stopLoss.js";
import { strategySequenceRouter } from "./routes/strategySequences.js";
import { tradingRouter } from "./routes/trading.js";
import { withMarketProfile } from "./services/activeMarketService.js";
import { accountCacheStatus } from "./services/accountService.js";
import { orderBookCacheStatus } from "./services/orderbookCache.js";
import { clobCircuitBreakerStatus } from "./services/clobService.js";
import { evaluatorDiagnostics } from "./services/stopLossService.js";

export const app = express();

app.use(helmet());
app.use(cors({ origin: webOrigins, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use((req, res, next) => {
  const started = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - started;
    if (ms > 2_000) {
      console.warn(`[slow-route] ${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
    }
  });
  next();
});
app.use((req, res, next) => {
  if (req.path.startsWith("/api/stream")) {
    next();
    return;
  }

  let timedOut = false;
  const originalJson = res.json.bind(res);
  const originalSend = res.send.bind(res);
  res.json = ((body: unknown) => timedOut && res.headersSent ? res : originalJson(body)) as typeof res.json;
  res.send = ((body?: unknown) => timedOut && res.headersSent ? res : originalSend(body)) as typeof res.send;
  req.setTimeout(config.API_ROUTE_TIMEOUT_MS);
  res.setTimeout(config.API_ROUTE_TIMEOUT_MS, () => {
    timedOut = true;
    if (!res.headersSent) {
      res.status(504);
      originalJson({
        ok: false,
        error: "Request timeout",
        path: req.path
      });
    }
  });
  next();
});

function selectedProfile(req: express.Request) {
  const urlProfile = new URL(req.originalUrl, "http://localhost").searchParams.get("profile");
  return urlProfile ?? req.body?.profile ?? req.header("x-market-profile");
}

function profiled(router: express.Router) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    withMarketProfile(selectedProfile(req), () => router(req, res, next));
  };
}

function healthPayload() {
  return {
    ok: true,
    serverTime: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    evaluator: evaluatorDiagnostics(),
    accountCache: accountCacheStatus(),
    orderbookCache: orderBookCacheStatus(),
    clobCircuitBreaker: clobCircuitBreakerStatus()
  };
}

app.get("/health", (_req, res) => res.json(healthPayload()));
app.get("/api/health", (_req, res) => res.json(healthPayload()));
app.use("/api/active-market", profiled(activeMarketRouter));
app.use("/api/geo", geoRouter);
app.use("/api", profiled(singleMarketRouter));
app.use("/api/stream", profiled(streamRouter));
app.use("/api", profiled(tradingRouter));
app.use("/api/stop-loss", profiled(stopLossRouter));
app.use("/api/strategy-sequences", profiled(strategySequenceRouter));
app.use("/api/settings", settingsRouter);
app.use("/api/kill-switch", killSwitchRouter);

const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
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
