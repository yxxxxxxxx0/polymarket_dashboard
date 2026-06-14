import { config } from "./config.js";
import { app } from "./app.js";
import { getActiveMarket } from "./services/activeMarketService.js";
import { startConfiguredOrderBooks } from "./services/orderbookCache.js";
import { startStopLossMonitor } from "./services/stopLossService.js";
import { reconcileStrategySequences } from "./services/strategySequenceService.js";

await getActiveMarket();

app.listen(config.PORT, () => {
  startConfiguredOrderBooks();
  reconcileStrategySequences().catch((error) => console.error("Strategy sequence recovery error", error));
  startStopLossMonitor();
  console.log(`Polymarket dashboard API listening on http://localhost:${config.PORT}`);
});
