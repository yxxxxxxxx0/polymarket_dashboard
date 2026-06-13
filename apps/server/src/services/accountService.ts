import { AssetType, COLLATERAL_TOKEN_DECIMALS } from "@polymarket/clob-client-v2";
import { OrderSide } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { config } from "../config.js";
import { fetchOrderBook, getBalanceClobClient } from "./clobService.js";
import { currentMarketProfile } from "./activeMarketService.js";
import { configuredMarket, marketScope, outcomeForToken } from "./singleMarketService.js";

type BalanceAllowancePayload = {
  balance?: string | number | null;
  available?: string | number | null;
  collateral?: string | number | null;
  cash?: string | number | null;
  allowances?: Record<string, string | number | null> | null;
  allowance?: string | number | null;
};

const ACCOUNT_SUMMARY_CACHE_MS = 2_000;

const cachedAccountSummaries = new Map<string, { expiresAt: number; value: Awaited<ReturnType<typeof buildAccountSummary>> }>();
const accountSummaryInFlight = new Map<string, Promise<Awaited<ReturnType<typeof buildAccountSummary>>>>();

function parseTokenAmount(value: string | number | null | undefined, decimals = COLLATERAL_TOKEN_DECIMALS) {
  if (value === null || value === undefined) return null;
  const asString = String(value).trim();
  if (!asString) return null;
  const asNumber = Number(asString);
  if (!Number.isFinite(asNumber)) return null;

  if (asString.includes(".")) return asNumber;
  return asNumber / 10 ** decimals;
}

function firstParsedAmount(values: Array<string | number | null | undefined>) {
  for (const value of values) {
    const parsed = parseTokenAmount(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function markPrice(side: OrderSide, entryPrice: number, currentPrice: number | null | undefined, bestBid: number | null, bestAsk: number | null, midpoint: number | null) {
  if (side === OrderSide.SELL) return bestAsk ?? midpoint ?? currentPrice ?? entryPrice;
  return bestBid ?? midpoint ?? currentPrice ?? entryPrice;
}

async function liveBalance() {
  try {
    const client = await getBalanceClobClient();
    const response = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }) as BalanceAllowancePayload;
    const balance = firstParsedAmount([response.balance, response.available, response.collateral, response.cash]);
    const allowances = Object.fromEntries(
      Object.entries(response.allowances ?? {}).map(([key, value]) => [key, parseTokenAmount(value)])
    );
    const numericAllowances = Object.values(allowances).filter((value): value is number => typeof value === "number");
    return {
      available: true,
      cash: balance,
      allowance: numericAllowances.length > 0 ? Math.max(...numericAllowances) : parseTokenAmount(response.allowance),
      raw: response,
      error: null
    };
  } catch (error) {
    return {
      available: false,
      cash: null,
      allowance: null,
      raw: null,
      error: error instanceof Error ? error.message : "Balance unavailable"
    };
  }
}

type LivePosition = {
  proxyWallet?: string;
  asset?: string;
  conditionId?: string;
  eventId?: string;
  size?: number;
  avgPrice?: number;
  initialValue?: number;
  currentValue?: number;
  cashPnl?: number;
  percentPnl?: number;
  totalBought?: number;
  realizedPnl?: number;
  curPrice?: number;
  outcome?: string;
};

async function livePositions(marketId: string) {
  if (!config.DEPOSIT_WALLET_ADDRESS) return [];
  try {
    const params = new URLSearchParams({
      user: config.DEPOSIT_WALLET_ADDRESS,
      market: marketId,
      sizeThreshold: "0",
      limit: "100"
    });
    const response = await fetch(`${config.POLYMARKET_DATA_HOST}/positions?${params.toString()}`, {
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Positions request failed with status ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload) ? payload as LivePosition[] : [];
  } catch {
    return [];
  }
}

export async function accountSummary(options: { force?: boolean } = {}) {
  const now = Date.now();
  const profile = currentMarketProfile();
  const cachedAccountSummary = cachedAccountSummaries.get(profile);
  if (!options.force && cachedAccountSummary && cachedAccountSummary.expiresAt > now) return cachedAccountSummary.value;
  const inFlight = accountSummaryInFlight.get(profile);
  if (!options.force && inFlight) return inFlight;

  const nextInFlight = buildAccountSummary()
    .then((summary) => {
      cachedAccountSummaries.set(profile, { value: summary, expiresAt: Date.now() + ACCOUNT_SUMMARY_CACHE_MS });
      return summary;
    })
    .finally(() => {
      accountSummaryInFlight.delete(profile);
    });

  accountSummaryInFlight.set(profile, nextInFlight);
  return nextInFlight;
}

export function invalidateAccountSummaryCache() {
  cachedAccountSummaries.delete(currentMarketProfile());
}

async function buildAccountSummary() {
  const market = configuredMarket();
  const { marketId, conditionId } = marketScope();
  const [balance, positions, livePositionRows] = await Promise.all([
    liveBalance(),
    prisma.position.findMany({ where: { marketId } }),
    livePositions(marketId)
  ]);

  const books = await Promise.all(market.tokenIds.map((tokenId) => fetchOrderBook(tokenId)));
  const bookByToken = new Map(books.map((book) => [book.tokenId, book]));

  const outcomes = market.tokenIds.map((tokenId, index) => {
    const book = bookByToken.get(tokenId);
    const buyPrice = book?.bestAsk ?? book?.midpoint ?? null;
    const sharesCanBuy = balance.cash !== null && buyPrice && buyPrice > 0 ? balance.cash / buyPrice : null;
    return {
      tokenId,
      outcomeName: market.outcomes[index] ?? outcomeForToken(tokenId),
      buyPrice,
      cashAvailable: balance.cash,
      sharesCanBuy,
      expectedPayoutIfWins: sharesCanBuy,
      expectedProfitIfWins: sharesCanBuy !== null && buyPrice !== null ? sharesCanBuy * (1 - buyPrice) : null
    };
  });

  const localPositionSummaries = positions.map((position) => {
    const book = bookByToken.get(position.tokenId);
    const mark = markPrice(position.side, position.entryPrice, position.currentPrice, book?.bestBid ?? null, book?.bestAsk ?? null, book?.midpoint ?? null);
    const direction = position.side === OrderSide.SELL ? -1 : 1;
    const unrealizedPnl = (mark - position.entryPrice) * position.size * direction;
    const expectedPayoutIfWins = position.side === OrderSide.BUY ? position.size : null;
    const expectedProfitIfWins = position.side === OrderSide.BUY ? position.size * (1 - position.entryPrice) : null;
    return {
      id: position.id,
      tokenId: position.tokenId,
      outcomeName: position.outcomeName,
      side: position.side,
      size: position.size,
      entryPrice: position.entryPrice,
      markPrice: mark,
      unrealizedPnl,
      realizedPnl: 0,
      netPnl: unrealizedPnl,
      expectedPayoutIfWins,
      expectedProfitIfWins,
      tradeMode: position.tradeMode
    };
  });
  const livePositionSummaries = livePositionRows
    .filter((position) => (
      position.asset
      && market.tokenIds.includes(position.asset)
      && (!position.eventId || position.eventId === marketId)
    ))
    .map((position) => ({
      id: `live-${position.asset}`,
      tokenId: String(position.asset),
      outcomeName: outcomeForToken(String(position.asset)),
      side: OrderSide.BUY,
      size: Number(position.size ?? 0),
      entryPrice: Number(position.avgPrice ?? 0),
      markPrice: Number(position.curPrice ?? 0),
      unrealizedPnl: Number(position.cashPnl ?? 0),
      realizedPnl: Number(position.realizedPnl ?? 0),
      netPnl: Number(position.cashPnl ?? 0) + Number(position.realizedPnl ?? 0),
      expectedPayoutIfWins: Number(position.size ?? 0),
      expectedProfitIfWins: Number(position.size ?? 0) - Number(position.initialValue ?? 0),
      tradeMode: "LIVE" as const
    }));

  const livePositionTokens = new Set(livePositionSummaries.map((position) => position.tokenId));
  const positionSummaries = [
    ...livePositionSummaries,
    ...localPositionSummaries.filter((position) => position.tradeMode !== "LIVE" || !livePositionTokens.has(position.tokenId))
  ];

  const positionsMarkedValue = positionSummaries.reduce((sum, position) => sum + position.markPrice * position.size, 0);
  const unrealizedPnl = positionSummaries.reduce((sum, position) => sum + position.unrealizedPnl, 0);
  const realizedPnl = positionSummaries.reduce((sum, position) => sum + position.realizedPnl, 0);
  const netPnl = positionSummaries.reduce((sum, position) => sum + position.netPnl, 0);

  return {
    marketId,
    balance,
    cash: balance.cash,
    allowance: balance.allowance,
    accountValue: balance.cash !== null ? balance.cash + positionsMarkedValue : null,
    positionsMarkedValue,
    unrealizedPnl,
    realizedPnl,
    netPnl,
    outcomes,
    positions: positionSummaries,
    updatedAt: new Date().toISOString()
  };
}
