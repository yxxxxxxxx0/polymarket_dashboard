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
import { childActivationUpdate, fillFromLiveTrades, isFullFill, ruleStatusForDisplay, shouldActivateChildren } from "../apps/server/src/services/strategySequenceService";
import {
  executionAnchorByAction,
  executionPrice,
  getMarketableBuyLimit,
  getMarketableSellLimit,
  marketableBuyPrice,
  resolveEffectiveRiskSettings
} from "../apps/server/src/services/stopLossService";
import { computeEmergencyScore, emergencyBuyLimit, emergencySellLimit, estimateEmergencyGap, getEmergencyParams, shouldEmergencyBreakoutBuy, shouldEmergencyStopLoss } from "../apps/server/src/services/emergencyExecutionModel";
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
assert.deepEqual(getAggressiveStopProtectionSettings(90), { slippageLimit: 0.30, maxSpread: 0.40, disableMaxSpread: true, label: "90'+: stop slippage 30c, max spread disabled or 40c" });
assert.deepEqual(getAggressiveBreakoutSettings(88), { slippageLimit: 0.15, maxSpread: 0.22, disableMaxSpread: false, label: "88'-90': breakout slippage 15c, max spread 22c" });
assert.deepEqual(resolveEffectiveRiskSettings({
  ruleType: RuleType.STOP_LOSS,
  slippageLimit: 0.02,
  maxSpread: 0.03,
  disableMaxSpread: false
}, null), {
  slippageLimit: 0.02,
  maxSpread: 0.03,
  disableMaxSpread: false,
  gameMinute: null,
  dynamic: false,
  label: "Saved rule settings"
});
assert.deepEqual(resolveEffectiveRiskSettings({
  ruleType: RuleType.TRAILING_STOP,
  slippageLimit: 0.02,
  maxSpread: 0.03,
  disableMaxSpread: false
}, 90), {
  slippageLimit: 0.30,
  maxSpread: 0.40,
  disableMaxSpread: true,
  gameMinute: 90,
  dynamic: true,
  label: "Stop gap model: 30.0c slippage, max spread disabled (90'+: stop slippage 30c, max spread disabled or 40c)"
});
assert.deepEqual(resolveEffectiveRiskSettings({
  ruleType: RuleType.BREAKOUT_BUY,
  slippageLimit: 0.02,
  maxSpread: 0.03,
  disableMaxSpread: false
}, 88), {
  slippageLimit: 0.15,
  maxSpread: 0.22,
  disableMaxSpread: false,
  gameMinute: 88,
  dynamic: true,
  label: "Breakout gap model: 15.0c slippage, 22c max spread (88'-90': breakout slippage 15c, max spread 22c)"
});

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
assert.deepEqual(resolveEffectiveRiskSettings({
  ruleType: RuleType.BREAKOUT_BUY,
  slippageLimit: 0.02,
  maxSpread: 0.03,
  disableMaxSpread: false
}, 75, executionBook, undefined, { upMove10Cents: 6 }), {
  slippageLimit: 0.25,
  maxSpread: 0.12,
  disableMaxSpread: false,
  gameMinute: 75,
  dynamic: true,
  label: "Breakout gap model: 25.0c slippage, 12c max spread (75'-88': breakout slippage 8c, max spread 12c)"
});
assert.equal(executionPrice({ executionType: "MARKETABLE_LIMIT", stopPrice: 0.55, slippageLimit: 0.04 }, executionBook), 0.40);
assert.equal(executionPrice({ executionType: "MARKETABLE_LIMIT", stopPrice: 0.55, slippageLimit: 0.04 }, executionBook, true), 0.40);
assert.equal(marketableBuyPrice({ stopPrice: 0.55, slippageLimit: 0.05 }, executionBook), 0.66);
assert.equal(getMarketableSellLimit(0.74, 0.08), 0.66);
assert.equal(getMarketableBuyLimit(0.79, 0.08), 0.87);
assert.equal(getMarketableSellLimit(0.05, 0.08), 0.01);
assert.equal(getMarketableBuyLimit(0.96, 0.08), 0.99);
assert.deepEqual(executionAnchorByAction, {
  STOP_LOSS_SELL: "bestBid",
  TAKE_PROFIT_SELL: "bestBid",
  BREAKOUT_BUY: "bestAsk",
  DIP_BUY: "bestAsk",
  EMERGENCY_STOP_SELL: "bestBid",
  EMERGENCY_BREAKOUT_BUY: "bestAsk"
});
assert.equal(Number(estimateEmergencyGap(90).toFixed(2)) <= 0.75, true);
assert.deepEqual(getEmergencyParams(90), { slippage: 0.30, maxSpread: null, emergencyScoreStop: 0.60, emergencyScoreBreakout: 0.65 });
const emergencyScore = computeEmergencyScore({
  midNow: 0.56,
  mid5sAgo: 0.54,
  mid10sAgo: 0.50,
  spread: 0.12,
  nearDepthNow: 10,
  normalNearDepth: 100,
  gameMinute: 76
});
assert.equal(emergencyScore > 0.60, true);
assert.equal(shouldEmergencyStopLoss({ entryPrice: 0.70, stopPrice: 0.54, triggerReference: 0.555, emergencyScore: 0.80, gameMinute: 76 }), true);
assert.equal(shouldEmergencyStopLoss({ entryPrice: 0.70, stopPrice: 0.54, triggerReference: 0.57, emergencyScore: 0.80, gameMinute: 76 }), false);
assert.equal(shouldEmergencyBreakoutBuy({ breakoutTrigger: 0.58, triggerReference: 0.56, triggerReference5sAgo: 0.54, emergencyScore: 0.72, gameMinute: 76 }), true);
assert.equal(shouldEmergencyBreakoutBuy({ breakoutTrigger: 0.58, triggerReference: 0.54, triggerReference5sAgo: 0.53, emergencyScore: 0.72, gameMinute: 76 }), false);
assert.equal(emergencySellLimit(0.44, 90), 0.14);
assert.equal(emergencyBuyLimit(0.80, 90), 0.99);

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
const makerTradeFill = fillFromLiveTrades("0xparent", [{
  id: "trade-1",
  taker_order_id: "0xtaker",
  price: "0.62",
  size: "10",
  status: "MATCHED",
  maker_orders: [{ order_id: "0xparent", matched_amount: "10", price: "0.62" }]
}], 10);
assert.equal(makerTradeFill?.filledShareAmount, 10);
assert.equal(makerTradeFill?.averageFillPrice, 0.62);
assert.equal(makerTradeFill?.fullFill, true);
const takerTradeFill = fillFromLiveTrades("0xparent", [{
  id: "trade-2",
  taker_order_id: "0xparent",
  price: "0.64",
  size: "4",
  status: "MATCHED",
  maker_orders: []
}], 10);
assert.equal(takerTradeFill?.filledShareAmount, 4);
assert.equal(takerTradeFill?.fullFill, false);

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
