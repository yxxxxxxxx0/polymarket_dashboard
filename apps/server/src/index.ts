import http from "http";
import { config } from "./config.js";
import { app } from "./app.js";
import { getActiveMarket } from "./services/activeMarketService.js";
import { startConfiguredOrderBooks } from "./services/orderbookCache.js";
import { startStopLossMonitor } from "./services/stopLossService.js";
import { reconcileStrategySequences } from "./services/strategySequenceService.js";
import { attachDashboardWebSocket } from "./ws/dashboardWs.js";

await getActiveMarket();

const server = http.createServer(app);
attachDashboardWebSocket(server);

server.listen(config.PORT, () => {
  startConfiguredOrderBooks();
  reconcileStrategySequences().catch((error) => console.error("Strategy sequence recovery error", error));
  startStopLossMonitor();
  console.log(`Polymarket dashboard API listening on http://localhost:${config.PORT}`);
  console.log(`Dashboard WebSocket listening on ws://localhost:${config.PORT}/ws/dashboard`);
});
