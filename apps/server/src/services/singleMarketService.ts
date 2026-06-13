import { HttpError } from "../lib/http.js";
import type { MarketSummary } from "../types/domain.js";
import { currentActiveMarket } from "./activeMarketService.js";

export type Outcome = string;

export type ConfiguredOutcome = {
  outcome: Outcome;
  tokenId: string;
};

export function configuredOutcomes(): ConfiguredOutcome[] {
  return currentActiveMarket().outcomes.map((item) => ({
    outcome: item.name,
    tokenId: item.tokenId
  }));
}

export function configuredMarket(): MarketSummary {
  const outcomes = configuredOutcomes();
  const activeMarket = currentActiveMarket();
  return {
    id: activeMarket.marketId,
    conditionId: activeMarket.conditionId,
    title: activeMarket.title,
    event: activeMarket.title,
    outcomes: outcomes.map((item) => item.outcome),
    tokenIds: outcomes.map((item) => item.tokenId),
    volume: 0,
    liquidity: 0,
    active: true,
    closed: false,
    raw: null
  };
}

export function configuredTokenIds() {
  return configuredOutcomes().map((item) => item.tokenId);
}

export function outcomeForToken(tokenId: string): Outcome {
  const outcome = configuredOutcomes().find((item) => item.tokenId === tokenId);
  if (outcome) return outcome.outcome;
  throw new HttpError(400, "Unknown tokenId for configured market");
}

export function isConfiguredToken(tokenId: string): boolean {
  return configuredOutcomes().some((item) => item.tokenId === tokenId);
}

export function assertConfiguredToken(tokenId: string): string {
  outcomeForToken(tokenId);
  return tokenId;
}

export function assertConfiguredMarket(marketId?: string | null) {
  const activeMarket = currentActiveMarket();
  if (marketId && marketId !== activeMarket.marketId) {
    throw new HttpError(400, "Unknown marketId for configured market");
  }
  return activeMarket.marketId;
}

export function marketScope() {
  const activeMarket = currentActiveMarket();
  return {
    marketId: activeMarket.marketId,
    conditionId: activeMarket.conditionId,
    tokenIds: configuredTokenIds()
  };
}
