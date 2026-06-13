import { OrderSide } from "@prisma/client";

export type StopLossDecisionInput = {
  sideHeld: OrderSide;
  referencePrice: number | null;
  stopPrice: number;
  rollingOfi: number;
  previousConfirmationTicks: number;
  requiredConfirmationTicks: number;
  sellThreshold: number;
};

export type StopLossDecision = {
  priceTriggered: boolean;
  ofiConfirmed: boolean;
  confirmationTicks: number;
  shouldExit: boolean;
};

export function isStopPriceTriggered(sideHeld: OrderSide, referencePrice: number | null, stopPrice: number) {
  if (referencePrice === null) return false;
  return sideHeld === OrderSide.BUY ? referencePrice <= stopPrice : referencePrice >= stopPrice;
}

export function evaluateStopLossConfirmation(input: StopLossDecisionInput): StopLossDecision {
  const priceTriggered = isStopPriceTriggered(input.sideHeld, input.referencePrice, input.stopPrice);
  const ofiConfirmed = input.sideHeld === OrderSide.BUY
    ? input.rollingOfi <= input.sellThreshold
    : input.rollingOfi >= Math.abs(input.sellThreshold);
  const confirmationTicks = priceTriggered && ofiConfirmed
    ? input.previousConfirmationTicks + 1
    : 0;

  return {
    priceTriggered,
    ofiConfirmed,
    confirmationTicks,
    shouldExit: confirmationTicks >= input.requiredConfirmationTicks
  };
}
