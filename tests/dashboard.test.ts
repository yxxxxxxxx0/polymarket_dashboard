import assert from "node:assert/strict";
import { OrderSide, RuleType, StopLossStatus } from "@prisma/client";
import {
  calculateBreakoutPercentage,
  calculateBuyTriggerPrice,
  calculateStopPercentage,
  calculateStopPrice,
  calculateTrailingPercentage,
  calculateTrailingStopPrice,
  isProfitLocked,
  referencePriceForTrigger,
  shouldTriggerOnce,
  updateHighestPrice,
  updateTrailingStopOnlyUp,
  validateStopLoss
} from "../apps/web/src/lib/stopLossMath";
import {
  calculateRollingOfi,
  calculateRollingOfiWindow,
  classifyRollingOfi,
  trimOfiObservations,
  type OfiObservation,
  type RollingOfiConfig
} from "../apps/server/src/services/ofiLogic";
import { evaluateStopLossConfirmation } from "../apps/server/src/services/stopLossDecision";
import { assertLiveOrderAccepted } from "../apps/server/src/services/clobService";
import { childActivationUpdate, isFullFill, ruleStatusForDisplay, shouldActivateChildren } from "../apps/server/src/services/strategySequenceService";
import { executionPrice, marketableBuyPrice } from "../apps/server/src/services/stopLossService";
import { estimateGapByGameMinute, getAggressiveBreakoutSettings, getAggressiveStopProtectionSettings, getGameMinute } from "../apps/web/src/lib/gameTime";

const ofiConfig: RollingOfiConfig = {
  windowSeconds: 10,
  strongBuyThreshold: 0.30,
  buyThreshold: 0.10,
  sellThreshold: -0.10,
  strongSellThreshold: -0.30
};

function observation(timestampSeconds: number, rawOfi: number): OfiObservation {
  return {
    timestamp: timestampSeconds * 1000,
    rawOfi,
    bidDepth: 1,
    askDepth: 1,
    bestBid: 0.5,
    bestAsk: 0.51
  };
}

assert.equal(calculateStopPrice(0.60, 10), 0.54);
assert.equal(calculateStopPercentage(0.60, 0.51), 15);
assert.equal(calculateTrailingStopPrice(0.80, 10), 0.72);
assert.equal(calculateTrailingPercentage(0.80, 0.68), 15);
assert.equal(updateHighestPrice(0.70, 0.75), 0.75);
assert.equal(updateHighestPrice(0.78, 0.75), 0.78);
assert.equal(updateTrailingStopOnlyUp(0.70, 0.80, 10), 0.72);
assert.equal(updateTrailingStopOnlyUp(0.74, 0.80, 10), 0.74);
assert.equal(isProfitLocked(0.60, 0.61), true);
assert.equal(isProfitLocked(0.60, 0.59), false);
assert.equal(calculateBuyTriggerPrice(0.50, 10), 0.55);
assert.equal(calculateBreakoutPercentage(0.50, 0.575), 15);
const lockedReference = 0.50;
assert.equal(calculateBuyTriggerPrice(lockedReference, 10), 0.55);
assert.equal(calculateBuyTriggerPrice(lockedReference, 10), 0.55);
assert.equal(shouldTriggerOnce(0.56, 0.55, false), true);
assert.equal(shouldTriggerOnce(0.56, 0.55, true), false);
assert.equal(referencePriceForTrigger({
  tokenId: "test",
  bids: [],
  asks: [],
  bestBid: 0.53,
  bestAsk: 0.57,
  midpoint: 0.55,
  spread: 0.04,
  depthImbalance: 0,
  lastTradePrice: 0.54,
  lastUpdateTime: "now"
}, "BEST_BID"), 0.53);
assert.equal(referencePriceForTrigger({
  tokenId: "test",
  bids: [],
  asks: [],
  bestBid: 0.53,
  bestAsk: 0.57,
  midpoint: 0.55,
  spread: 0.04,
  depthImbalance: 0,
  lastTradePrice: 0.54,
  lastUpdateTime: "now"
}, "BEST_ASK"), 0.57);
assert.equal(referencePriceForTrigger({
  tokenId: "test",
  bids: [],
  asks: [],
  bestBid: 0.53,
  bestAsk: 0.57,
  midpoint: 0.55,
  spread: 0.04,
  depthImbalance: 0,
  lastTradePrice: null,
  lastUpdateTime: "now"
}, "MIDPOINT_PRICE"), 0.55);

assert.deepEqual(validateStopLoss({
  entryPrice: 0,
  stopPrice: 1.2,
  stopPercentage: -1,
  positionSize: 1,
  maxSellSize: 2
}), [
  "Entry price must be greater than 0 and less than 1.",
  "Stop price must be greater than 0 and less than 1.",
  "Stop percentage must be greater than 0.",
  "Max sell size cannot exceed position size."
]);

const firstWindow = [
  observation(0, 0.20),
  observation(2, -0.10),
  observation(4, -0.30)
];
const firstRolling = calculateRollingOfi(firstWindow, ofiConfig);
assert.equal(Number(firstRolling.rollingRawOfi.toFixed(4)), -0.20);
assert.equal(Number(firstRolling.rollingOfi.toFixed(4)), -0.3333);
assert.equal(firstRolling.signal, "Strong Sell Flow");

const trimmed = trimOfiObservations([
  ...firstWindow,
  observation(12, 0.50)
], 12_000, 10);
assert.deepEqual(trimmed.map((item) => item.timestamp / 1000), [2, 4, 12]);
const trimmedRolling = calculateRollingOfi(trimmed, ofiConfig);
assert.equal(Number(trimmedRolling.rollingRawOfi.toFixed(4)), 0.10);
assert.equal(Number(trimmedRolling.rollingOfi.toFixed(4)), 0.1111);
assert.equal(trimmedRolling.signal, "Buy Flow");

const separateWindows = [
  observation(0, 0.8),
  observation(20, -0.2),
  observation(40, -0.4),
  observation(60, -0.4)
];
const ofi30s = calculateRollingOfiWindow(separateWindows, 60_000, { ...ofiConfig, windowSeconds: 30 });
const ofi2m = calculateRollingOfiWindow(separateWindows, 60_000, { ...ofiConfig, windowSeconds: 120 });
assert.deepEqual(trimOfiObservations(separateWindows, 60_000, 30).map((item) => item.timestamp / 1000), [40, 60]);
assert.deepEqual(trimOfiObservations(separateWindows, 60_000, 120).map((item) => item.timestamp / 1000), [0, 20, 40, 60]);
assert.equal(Number(ofi30s.rollingOfi.toFixed(4)), -1);
assert.equal(Number(ofi2m.rollingOfi.toFixed(4)), -0.1111);

assert.equal(classifyRollingOfi(-0.31, ofiConfig), "Strong Sell Flow");
assert.equal(classifyRollingOfi(-0.20, ofiConfig), "Sell Flow");
assert.equal(classifyRollingOfi(0, ofiConfig), "Neutral");
assert.equal(classifyRollingOfi(0.20, ofiConfig), "Buy Flow");
assert.equal(classifyRollingOfi(0.31, ofiConfig), "Strong Buy Flow");

const noisySpike = evaluateStopLossConfirmation({
  sideHeld: OrderSide.BUY,
  referencePrice: 0.53,
  stopPrice: 0.54,
  rollingOfi: 0,
  previousConfirmationTicks: 0,
  requiredConfirmationTicks: 2,
  sellThreshold: -0.10
});
assert.equal(noisySpike.priceTriggered, true);
assert.equal(noisySpike.ofiConfirmed, false);
assert.equal(noisySpike.shouldExit, false);

const firstConfirmingTick = evaluateStopLossConfirmation({
  sideHeld: OrderSide.BUY,
  referencePrice: 0.53,
  stopPrice: 0.54,
  rollingOfi: -0.20,
  previousConfirmationTicks: 0,
  requiredConfirmationTicks: 2,
  sellThreshold: -0.10
});
assert.equal(firstConfirmingTick.confirmationTicks, 1);
assert.equal(firstConfirmingTick.shouldExit, false);

const secondConfirmingTick = evaluateStopLossConfirmation({
  sideHeld: OrderSide.BUY,
  referencePrice: 0.53,
  stopPrice: 0.54,
  rollingOfi: -0.20,
  previousConfirmationTicks: firstConfirmingTick.confirmationTicks,
  requiredConfirmationTicks: 2,
  sellThreshold: -0.10
});
assert.equal(secondConfirmingTick.confirmationTicks, 2);
assert.equal(secondConfirmingTick.shouldExit, true);

const hardStopWithoutOfi = evaluateStopLossConfirmation({
  sideHeld: OrderSide.BUY,
  referencePrice: 0.49,
  stopPrice: 0.50,
  rollingOfi: 0.25,
  previousConfirmationTicks: 0,
  requiredConfirmationTicks: 2,
  sellThreshold: -0.10
});
assert.equal(hardStopWithoutOfi.priceTriggered, true);
assert.equal(hardStopWithoutOfi.ofiConfirmed, false);

const softStopNeedsOfi = evaluateStopLossConfirmation({
  sideHeld: OrderSide.BUY,
  referencePrice: 0.53,
  stopPrice: 0.54,
  rollingOfi: 0.25,
  previousConfirmationTicks: 0,
  requiredConfirmationTicks: 2,
  sellThreshold: -0.10
});
assert.equal(softStopNeedsOfi.priceTriggered, true);
assert.equal(softStopNeedsOfi.shouldExit, false);

assert.throws(
  () => assertLiveOrderAccepted({ error: "invalid POLY_1271 signature: signature does not match order hash", status: 400 }),
  /invalid POLY_1271 signature/
);
assert.throws(
  () => assertLiveOrderAccepted({ success: false, errorMsg: "not enough balance", orderID: "" }),
  /not enough balance/
);
assert.equal(assertLiveOrderAccepted({ success: true, orderID: "0xabc", status: "open" }).orderID, "0xabc");

assert.equal(getGameMinute("2026-06-14T12:00:00.000Z", new Date("2026-06-14T12:30:00.000Z")), 30);
assert.equal(getGameMinute("2026-06-14T12:00:00.000Z", new Date("2026-06-14T11:59:00.000Z")), 0);
assert.equal(Number(estimateGapByGameMinute(10).toFixed(2)) >= 0.12, true);
assert.deepEqual(getAggressiveStopProtectionSettings(90), { slippageLimit: 0.25, maxSpread: 0.40, disableMaxSpread: true, label: "90'+: slippage 25c, max spread disabled or 40c" });
assert.deepEqual(getAggressiveBreakoutSettings(88), { slippageLimit: 0.12, maxSpread: 0.25, disableMaxSpread: false, label: "88'+: breakout slippage 12c, max spread 25c" });

const executionBook = {
  tokenId: "test",
  bids: [],
  asks: [],
  bestBid: 0.44,
  bestAsk: 0.61,
  spread: 0.17,
  midpoint: 0.525,
  depthImbalance: 0,
  lastTradePrice: null,
  lastUpdateTime: "now"
};
assert.equal(executionPrice({ executionType: "MARKETABLE_LIMIT", stopPrice: 0.55, slippageLimit: 0.04 }, executionBook), 0.51);
assert.equal(executionPrice({ executionType: "MARKETABLE_LIMIT", stopPrice: 0.55, slippageLimit: 0.04 }, executionBook, true), 0.40);
assert.equal(marketableBuyPrice({ stopPrice: 0.55, slippageLimit: 0.05 }, executionBook), 0.66);

assert.equal(ruleStatusForDisplay(StopLossStatus.ARMED), "active");
assert.equal(ruleStatusForDisplay(StopLossStatus.ORDER_SUBMITTED), "order_submitted");
assert.equal(ruleStatusForDisplay(StopLossStatus.FILLED), "filled");
assert.equal(ruleStatusForDisplay(StopLossStatus.CANCELLED), "cancelled");
assert.equal(ruleStatusForDisplay(StopLossStatus.FAILED), "failed");
assert.equal(ruleStatusForDisplay(StopLossStatus.INACTIVE_WAITING_FOR_PARENT), "inactive_waiting_for_parent");
assert.equal(isFullFill({ filledShareAmount: 0, averageFillPrice: 0.62, expectedShareAmount: 25, fullFill: false }), false);
assert.equal(isFullFill({ filledShareAmount: 12, averageFillPrice: 0.62, expectedShareAmount: 25 }), false);
assert.equal(isFullFill({ filledShareAmount: 25, averageFillPrice: 0.62, expectedShareAmount: 25 }), true);
assert.equal(shouldActivateChildren({ activationCondition: "FULL_FILL_ONLY", minFilledShares: null }, { filledShareAmount: 12, averageFillPrice: 0.62, expectedShareAmount: 25 }), false);
assert.equal(shouldActivateChildren({ activationCondition: "PARTIAL_FILL_ALLOWED", minFilledShares: null }, { filledShareAmount: 12, averageFillPrice: 0.62, expectedShareAmount: 25 }), true);
assert.equal(shouldActivateChildren({ activationCondition: "MIN_FILLED_SHARES", minFilledShares: 15 }, { filledShareAmount: 12, averageFillPrice: 0.62, expectedShareAmount: 25 }), false);
assert.equal(shouldActivateChildren({ activationCondition: "MIN_FILLED_SHARES", minFilledShares: 15 }, { filledShareAmount: 15, averageFillPrice: 0.62, expectedShareAmount: 25 }), true);

const submittedParentStatus = ruleStatusForDisplay(StopLossStatus.ORDER_SUBMITTED);
assert.equal(submittedParentStatus, "order_submitted");
assert.notEqual(submittedParentStatus, "filled");

const stopActivation = childActivationUpdate({
  ruleType: RuleType.STOP_LOSS,
  stopPrice: 0.50,
  stopPercentage: 8,
  trailingPercentage: null,
  referencePrice: null
}, {
  filledShareAmount: 25,
  averageFillPrice: 0.625,
  expectedShareAmount: 25
});
assert.equal(stopActivation.positionSize, 25);
assert.equal(stopActivation.maxSellSize, 25);
assert.equal(Number(stopActivation.stopPrice.toFixed(4)), 0.575);
assert.equal(stopActivation.status, StopLossStatus.ACTIVE);

const trailingActivation = childActivationUpdate({
  ruleType: RuleType.TRAILING_STOP,
  stopPrice: 0.50,
  stopPercentage: 10,
  trailingPercentage: 10,
  referencePrice: 0.70
}, {
  filledShareAmount: 25,
  averageFillPrice: 0.625,
  expectedShareAmount: 25
});
assert.equal(trailingActivation.positionSize, 25);
assert.equal(trailingActivation.maxSellSize, 25);
assert.equal(Number(trailingActivation.stopPrice.toFixed(4)), 0.63);
assert.equal(trailingActivation.highestPriceSinceEntry, 0.70);

console.log("dashboard behavior tests passed");
