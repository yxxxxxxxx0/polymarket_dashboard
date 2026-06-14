export const API_BASE = "";
export const STREAM_BASE = process.env.NEXT_PUBLIC_STREAM_BASE ?? "http://localhost:4000";
function positiveEnvNumber(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const API_TIMEOUT_MS = positiveEnvNumber(process.env.NEXT_PUBLIC_API_TIMEOUT_MS, 10_000);
export const UI_REFRESH_MS = positiveEnvNumber(process.env.NEXT_PUBLIC_UI_REFRESH_MS, 10_000);
export const ORDERBOOK_POLL_MS = positiveEnvNumber(process.env.NEXT_PUBLIC_ORDERBOOK_POLL_MS, 1_000);
export const DEFAULT_MARKET_PROFILE = "football";

export function profileFromPath(pathname: string | null | undefined) {
  return pathname?.startsWith("/mlb") ? "mlb" : DEFAULT_MARKET_PROFILE;
}

export function withProfile(path: string, profile?: string) {
  if (!profile || profile === DEFAULT_MARKET_PROFILE) return path;
  const [pathname, query = ""] = path.split("?");
  const params = new URLSearchParams(query);
  params.set("profile", profile);
  const nextQuery = params.toString();
  return nextQuery ? `${pathname}?${nextQuery}` : pathname;
}

export function streamUrl(path: string, profile?: string) {
  const url = new URL(path, STREAM_BASE);
  if (profile && profile !== DEFAULT_MARKET_PROFILE) url.searchParams.set("profile", profile);
  return url.toString();
}

export type MarketSummary = {
  id: string;
  conditionId?: string;
  title: string;
  outcomes: string[];
  tokenIds: string[];
  volume?: number;
  liquidity?: number;
};

export type MarketStats = {
  marketId: string;
  volume: number;
  liquidity: number;
  updatedAt: string;
};

export type ActiveMarketConfig = {
  marketId: string;
  conditionId: string;
  title: string;
  outcomes: {
    name: string;
    envKey: string;
    tokenId: string;
  }[];
};

export type SavedMarketConfig = ActiveMarketConfig & {
  sourceIndex: number;
};

export type GameTimeSetting = {
  marketId: string;
  kickoffTimeIso: string | null;
  timezone: string;
  gameMinute: number;
  status: "Waiting for kickoff" | "Live" | "Finished" | string;
  estimatedGap: number;
  paused?: boolean;
  pausedGameMinute?: number | null;
  phase?: "FIRST_HALF" | "HALF_TIME" | "SECOND_HALF";
  secondHalfStartedAtIso?: string | null;
};

export type GapModelTier = {
  startMinute: number;
  label: string;
  slippageCents: number;
  maxSpreadCents: number;
  disableMaxSpread: boolean;
  lateAddCents: number;
};

export type DirectionalGapModel = {
  minSlippageCents: number;
  maxSlippageCents: number;
  spreadCoefficient: number;
  moveCoefficient: number;
  thinDepthThresholdShares: number;
  thinDepthAddCents: number;
  extremePriceLow: number;
  extremePriceHigh: number;
  extremePriceAddCents: number;
  tiers: GapModelTier[];
};

export type GapModelConfig = {
  breakout: DirectionalGapModel;
  stopLoss: DirectionalGapModel;
};

export type OrderBook = {
  tokenId: string;
  market?: string;
  bids: { price: number; size: number }[];
  asks: { price: number; size: number }[];
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  midpoint: number | null;
  depthImbalance: number | null;
  lastTradePrice: number | null;
  lastUpdateTime: string | null;
  ofi?: {
    rawOfi: number;
    rollingRawOfi30s: number;
    rollingOfi30s: number;
    signal30s: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
    rollingRawOfi2m: number;
    rollingOfi2m: number;
    signal2m: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
    windows: {
      "30s": {
        rollingRawOfi: number;
        rollingOfi: number;
        windowSeconds: number;
        signal: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
      };
      "2m": {
        rollingRawOfi: number;
        rollingOfi: number;
        windowSeconds: number;
        signal: "Strong Buy Flow" | "Buy Flow" | "Neutral" | "Sell Flow" | "Strong Sell Flow";
      };
    };
  };
};

export type AccountOutcomeSummary = {
  tokenId: string;
  outcomeName: string;
  buyPrice: number | null;
  cashAvailable: number | null;
  sharesCanBuy: number | null;
  expectedPayoutIfWins: number | null;
  expectedProfitIfWins: number | null;
};

export type AccountPositionSummary = {
  id: string;
  tokenId: string;
  outcomeName: string;
  side: "BUY" | "SELL";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  realizedPnl: number;
  netPnl: number;
  expectedPayoutIfWins: number | null;
  expectedProfitIfWins: number | null;
  tradeMode: "PAPER" | "LIVE";
};

export type AccountSummaryResponse = {
  marketId: string;
  balance: {
    available: boolean;
    cash: number | null;
    allowance: number | null;
    error: string | null;
  };
  cash: number | null;
  allowance: number | null;
  accountValue: number | null;
  positionsMarkedValue: number;
  unrealizedPnl: number;
  realizedPnl: number;
  netPnl: number;
  outcomes: AccountOutcomeSummary[];
  positions: AccountPositionSummary[];
  updatedAt: string;
};

export type RuleDisplayStatus =
  | "pending"
  | "active"
  | "order_submitted"
  | "filled"
  | "cancelled"
  | "failed"
  | "inactive_waiting_for_parent";

export type StrategySequenceRule = {
  id: string;
  ruleType: "STOP_LOSS" | "TRAILING_STOP" | "BUY_STOP" | "BREAKOUT_BUY";
  strategySequenceId: string | null;
  parentRuleId: string | null;
  childRuleIds: string[];
  activationCondition: string | null;
  outcomeName: string;
  positionSize: number;
  entryPrice: number;
  stopPrice: number;
  trailingPercentage: number | null;
  breakoutPrice: number | null;
  filledShareAmount: number | null;
  averageFillPrice: number | null;
  activatedAt: string | null;
  filledAt: string | null;
  cancelledAt: string | null;
  status: string;
  displayStatus: RuleDisplayStatus;
  enabled: boolean;
};

export type StrategySequence = {
  id: string;
  marketId: string;
  conditionId: string | null;
  tokenId: string;
  outcomeName: string;
  status: string;
  displayStatus: RuleDisplayStatus;
  activationCondition: string;
  createdAt: string;
  updatedAt: string;
  rules: StrategySequenceRule[];
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const requestUrl = `${API_BASE}${path}`;
  const timeout = globalThis.setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(requestUrl, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      },
      cache: "no-store",
      signal: controller.signal
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Request failed with ${response.status}`);
    return body as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`Request to ${requestUrl} timed out after ${API_TIMEOUT_MS}ms. Check that the dashboard API is running and reachable.`);
    }
    throw error;
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function post<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "POST", body: JSON.stringify(body) });
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
}
