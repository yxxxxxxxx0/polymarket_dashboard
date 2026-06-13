import type { OrderBook } from "./api";

export type StopLossTrigger = "LAST_TRADE_PRICE" | "MIDPOINT_PRICE" | "BEST_BID" | "BEST_ASK";

export type StopLossValidationInput = {
  entryPrice: number;
  currentPrice?: number | null;
  stopPrice: number;
  stopPercentage: number;
  positionSize: number;
  maxSellSize: number;
  slippageLimit?: number;
};

export function roundPrice(value: number) {
  return Number(value.toFixed(3));
}

export function formatPrice(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  return roundPrice(value).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

export function calculateStopPrice(entryPrice: number, stopPercentage: number) {
  return roundPrice(entryPrice * (1 - stopPercentage / 100));
}

export function calculateStopPercentage(entryPrice: number, stopPrice: number) {
  if (entryPrice <= 0) return 0;
  return Number((((entryPrice - stopPrice) / entryPrice) * 100).toFixed(2));
}

export function calculateTrailingStopPrice(highestPrice: number, trailingPercentage: number) {
  return roundPrice(highestPrice * (1 - trailingPercentage / 100));
}

export function calculateTrailingPercentage(highestPrice: number, trailingStopPrice: number) {
  if (highestPrice <= 0) return 0;
  return Number((((highestPrice - trailingStopPrice) / highestPrice) * 100).toFixed(2));
}

export function updateHighestPrice(previousHighest: number, currentPrice: number) {
  if (!Number.isFinite(previousHighest) || previousHighest <= 0) return roundPrice(currentPrice);
  return roundPrice(Math.max(previousHighest, currentPrice));
}

export function updateTrailingStopOnlyUp(previousStop: number, highestPrice: number, trailingPercentage: number) {
  const nextStop = calculateTrailingStopPrice(highestPrice, trailingPercentage);
  if (!Number.isFinite(previousStop) || previousStop <= 0) return nextStop;
  return roundPrice(Math.max(previousStop, nextStop));
}

export function isProfitLocked(entryPrice: number, stopPrice: number) {
  return Number.isFinite(entryPrice) && Number.isFinite(stopPrice) && stopPrice > entryPrice;
}

export function calculateBuyTriggerPrice(referencePrice: number, breakoutPercentage: number) {
  return roundPrice(referencePrice * (1 + breakoutPercentage / 100));
}

export function calculateBreakoutPercentage(referencePrice: number, triggerPrice: number) {
  if (referencePrice <= 0) return 0;
  return Number((((triggerPrice - referencePrice) / referencePrice) * 100).toFixed(2));
}

export function shouldTriggerOnce(currentPrice: number, triggerPrice: number, orderSubmitted: boolean) {
  return !orderSubmitted && Number.isFinite(currentPrice) && Number.isFinite(triggerPrice) && currentPrice >= triggerPrice;
}

export function referencePriceForTrigger(book: OrderBook | null, triggerType: StopLossTrigger) {
  if (!book) return null;
  switch (triggerType) {
    case "BEST_BID":
      return book.bestBid;
    case "BEST_ASK":
      return book.bestAsk;
    case "MIDPOINT_PRICE":
      return book.midpoint;
    case "LAST_TRADE_PRICE":
      return book.lastTradePrice ?? book.midpoint;
  }
}

export function validateStopLoss(input: StopLossValidationInput) {
  const errors: string[] = [];
  if (!Number.isFinite(input.entryPrice) || input.entryPrice <= 0 || input.entryPrice >= 1) errors.push("Entry price must be greater than 0 and less than 1.");
  if (input.currentPrice !== undefined && input.currentPrice !== null && (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0 || input.currentPrice >= 1)) errors.push("Current price must be greater than 0 and less than 1.");
  if (!Number.isFinite(input.stopPrice) || input.stopPrice <= 0 || input.stopPrice >= 1) errors.push("Stop price must be greater than 0 and less than 1.");
  if (!Number.isFinite(input.stopPercentage) || input.stopPercentage <= 0) errors.push("Stop percentage must be greater than 0.");
  if (!Number.isFinite(input.positionSize) || input.positionSize <= 0) errors.push("Position size must be positive.");
  if (!Number.isFinite(input.maxSellSize) || input.maxSellSize <= 0) errors.push("Max sell size must be positive.");
  if (input.maxSellSize > input.positionSize) errors.push("Max sell size cannot exceed position size.");
  if (input.slippageLimit !== undefined && (!Number.isFinite(input.slippageLimit) || input.slippageLimit < 0)) errors.push("Slippage limit cannot be negative.");
  return errors;
}

export function validateBuyStop(input: {
  referencePrice: number;
  currentPrice?: number | null;
  triggerPrice: number;
  breakoutPercentage: number;
  stakeAmount: number;
  slippageLimit: number;
}) {
  const errors: string[] = [];
  if (!Number.isFinite(input.referencePrice) || input.referencePrice <= 0 || input.referencePrice >= 1) errors.push("Reference price must be greater than 0 and less than 1.");
  if (input.currentPrice !== undefined && input.currentPrice !== null && (!Number.isFinite(input.currentPrice) || input.currentPrice <= 0 || input.currentPrice >= 1)) errors.push("Current price must be greater than 0 and less than 1.");
  if (!Number.isFinite(input.triggerPrice) || input.triggerPrice <= 0 || input.triggerPrice >= 1) errors.push("Buy trigger price must be greater than 0 and less than 1.");
  if (!Number.isFinite(input.breakoutPercentage) || input.breakoutPercentage <= 0) errors.push("Breakout percentage must be greater than 0.");
  if (!Number.isFinite(input.stakeAmount) || input.stakeAmount <= 0) errors.push("Stake amount must be positive.");
  if (!Number.isFinite(input.slippageLimit) || input.slippageLimit < 0) errors.push("Slippage limit cannot be negative.");
  return errors;
}
