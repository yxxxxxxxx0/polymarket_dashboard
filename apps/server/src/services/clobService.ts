import {
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
  type TickSize
} from "@polymarket/clob-client-v2";
import type { ApiKeyCreds } from "@polymarket/clob-client-v2";
import { performance } from "node:perf_hooks";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { balanceSignatureType, config, orderSignatureType } from "../config.js";
import { HttpError } from "../lib/http.js";
import { fetchWithTimeout, withTimeout } from "../lib/timeout.js";
import { createLimiter } from "../lib/concurrency.js";
import { getCachedOrderBook, hasFreshOrderBook, orderBookAgeMs, subscribeTokens, updateCachedOrderBook } from "./orderbookCache.js";
import { assertConfiguredMarket, assertConfiguredToken } from "./singleMarketService.js";
import type { OrderBook } from "../types/domain.js";

let balanceClientPromise: Promise<ClobClient> | null = null;
let tradingClientPromise: Promise<ClobClient> | null = null;
const orderbookFetchLimiter = createLimiter(config.ORDERBOOK_FETCH_CONCURRENCY);

let clobFailureCount = 0;
let clobBlockedUntil = 0;

function assertClobHealthy(operation: string) {
  const now = Date.now();
  if (now < clobBlockedUntil) {
    throw new HttpError(503, `Polymarket CLOB temporarily unhealthy for ${operation}; retry after ${clobBlockedUntil - now}ms`);
  }
}

function recordClobSuccess() {
  clobFailureCount = 0;
  clobBlockedUntil = 0;
}

function recordClobFailure(operation: string, error: unknown) {
  clobFailureCount += 1;
  if (clobFailureCount >= config.CLOB_CIRCUIT_BREAKER_FAILURES) {
    clobBlockedUntil = Date.now() + config.CLOB_CIRCUIT_BREAKER_COOLDOWN_MS;
    console.warn("[clob-circuit-breaker] opened", { operation, failureCount: clobFailureCount, cooldownMs: config.CLOB_CIRCUIT_BREAKER_COOLDOWN_MS, error: error instanceof Error ? error.message : String(error) });
  }
}

async function withClobCircuitBreaker<T>(operation: string, task: () => Promise<T>): Promise<T> {
  assertClobHealthy(operation);
  try {
    const result = await task();
    recordClobSuccess();
    return result;
  } catch (error) {
    recordClobFailure(operation, error);
    throw error;
  }
}

export function clobCircuitBreakerStatus() {
  return {
    failureCount: clobFailureCount,
    blockedUntil: clobBlockedUntil || null,
    blockedForMs: clobBlockedUntil > Date.now() ? clobBlockedUntil - Date.now() : 0
  };
}

export type LiveOrderResponse = {
  success?: boolean;
  error?: string;
  errorMsg?: string;
  status?: string | number;
  orderID?: string;
  transactionsHashes?: string[];
  tradeIDs?: string[];
  takingAmount?: string;
  makingAmount?: string;
};

export function assertLiveOrderAccepted(response: LiveOrderResponse): LiveOrderResponse {
  if (response.error || response.success === false) {
    throw new HttpError(400, response.errorMsg || response.error || "Polymarket rejected the order");
  }

  if (!response.orderID) {
    throw new HttpError(502, `Polymarket did not return an order id: ${JSON.stringify(response)}`);
  }

  return response;
}

function credentialsFromEnv(): ApiKeyCreds | undefined {
  if (!config.POLYMARKET_API_KEY || !config.POLYMARKET_API_SECRET || !config.POLYMARKET_API_PASSPHRASE) {
    return undefined;
  }

  return {
    key: config.POLYMARKET_API_KEY,
    secret: config.POLYMARKET_API_SECRET,
    passphrase: config.POLYMARKET_API_PASSPHRASE
  };
}

async function buildClobClient(signatureType: number): Promise<ClobClient> {
  if (!config.PRIVATE_KEY) {
    throw new HttpError(400, "PRIVATE_KEY is required for live trading");
  }

  const account = privateKeyToAccount(config.PRIVATE_KEY as `0x${string}`);
  const signer = createWalletClient({ account, transport: http(config.POLYGON_RPC_URL) });
  const creds = credentialsFromEnv()
    ?? await withTimeout(
      () => new ClobClient({ host: config.POLYMARKET_CLOB_HOST, chain: 137, signer }).createOrDeriveApiKey(),
      config.POLYMARKET_FETCH_TIMEOUT_MS,
      "Polymarket API key derivation"
    );

  return new ClobClient({
    host: config.POLYMARKET_CLOB_HOST,
    chain: 137,
    signer,
    creds,
    signatureType: signatureType as SignatureTypeV2,
    funderAddress: config.DEPOSIT_WALLET_ADDRESS,
    throwOnError: true
  });
}

export async function getBalanceClobClient(): Promise<ClobClient> {
  if (!balanceClientPromise) {
    balanceClientPromise = buildClobClient(balanceSignatureType);
  }
  return balanceClientPromise;
}

export async function getTradingClobClient(): Promise<ClobClient> {
  if (!tradingClientPromise) {
    tradingClientPromise = buildClobClient(orderSignatureType);
  }
  return tradingClientPromise;
}

export async function getClobClient(): Promise<ClobClient> {
  return getTradingClobClient();
}

async function withSecondPrecisionTimestamp<T>(fn: () => Promise<T>) {
  const originalNow = Date.now;
  Date.now = () => Math.floor(originalNow() / 1_000);
  try {
    return await fn();
  } finally {
    Date.now = originalNow;
  }
}

export async function fetchOrderBook(tokenId: string, options: { force?: boolean; maxAgeMs?: number } = {}): Promise<OrderBook> {
  assertConfiguredToken(tokenId);
  subscribeTokens([tokenId]);
  if (!options.force && hasFreshOrderBook(tokenId, options.maxAgeMs ?? config.ORDERBOOK_REFRESH_MS)) {
    return getCachedOrderBook(tokenId);
  }
  try {
    const response = await orderbookFetchLimiter(() => withClobCircuitBreaker(
      "fetch orderbook",
      () => fetchWithTimeout(`${config.POLYMARKET_CLOB_HOST}/book?token_id=${encodeURIComponent(tokenId)}`, {
        headers: { accept: "application/json" },
        cache: "no-store"
      }, config.POLYMARKET_ORDERBOOK_TIMEOUT_MS)
    ));
    if (!response.ok) throw new Error(`Order book request failed with status ${response.status}`);
    const raw = await response.json() as { bids?: { price: string; size: string }[]; asks?: { price: string; size: string }[]; market?: string; asset_id?: string; timestamp?: string; hash?: string };
    const book = getCachedOrderBook(tokenId);
    const next = {
      ...book,
      market: raw.market ?? book.market,
      bids: Array.isArray(raw?.bids) ? raw.bids.map((level: { price: string; size: string }) => ({
        price: Number(level.price),
        size: Number(level.size)
      })) : book.bids,
      asks: Array.isArray(raw?.asks) ? raw.asks.map((level: { price: string; size: string }) => ({
        price: Number(level.price),
        size: Number(level.size)
      })) : book.asks,
      lastUpdateTime: new Date().toISOString()
    };
    const bids = [...next.bids].sort((a, b) => b.price - a.price);
    const asks = [...next.asks].sort((a, b) => a.price - b.price);
    const bestBid = bids[0]?.price ?? null;
    const bestAsk = asks[0]?.price ?? null;
    const bidDepth = bids.slice(0, 10).reduce((sum, level) => sum + level.size, 0);
    const askDepth = asks.slice(0, 10).reduce((sum, level) => sum + level.size, 0);
    return updateCachedOrderBook({
      ...next,
      bids,
      asks,
      bestBid,
      bestAsk,
      spread: bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null,
      midpoint: bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null,
      depthImbalance: bidDepth + askDepth > 0 ? (bidDepth - askDepth) / (bidDepth + askDepth) : null
    });
  } catch (error) {
    const cached = getCachedOrderBook(tokenId);
    const age = orderBookAgeMs(cached);
    const fallbackMaxAgeMs = options.maxAgeMs ?? config.ORDERBOOK_STALE_MS;
    if (age !== null && age <= fallbackMaxAgeMs) {
      console.warn("[orderbook] using fresh-enough cached fallback", { tokenId, ageMs: age, maxAgeMs: fallbackMaxAgeMs, error: error instanceof Error ? error.message : String(error) });
      return cached;
    }
    throw new HttpError(503, `Fresh orderbook fetch failed and cache is stale for ${tokenId}: ${age ?? "unknown"}ms old, limit ${fallbackMaxAgeMs}ms`);
  }
}

export async function createLiveOrder(input: {
  marketId?: string;
  tokenId: string;
  side: "BUY" | "SELL";
  price: number;
  size: number;
  tickSize?: TickSize;
  negRisk?: boolean;
}): Promise<LiveOrderResponse> {
  assertConfiguredMarket(input.marketId);
  assertConfiguredToken(input.tokenId);
  const client = await getTradingClobClient();
  const userOrder = {
    tokenID: input.tokenId,
    price: input.price,
    size: input.size,
    side: input.side === "BUY" ? Side.BUY : Side.SELL
  };
  const orderOptions = {
    tickSize: input.tickSize ?? "0.01",
    ...(input.negRisk === undefined ? {} : { negRisk: input.negRisk })
  };
  const response = await withClobCircuitBreaker("submit order", () => orderSignatureType === 3
    ? withTimeout(
      async () => client.postOrder(await withSecondPrecisionTimestamp(() => client.createOrder(userOrder, orderOptions)), OrderType.GTC) as Promise<LiveOrderResponse>,
      config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
      "Polymarket order submit"
    )
    : withTimeout(
      () => client.createAndPostOrder(userOrder, orderOptions, OrderType.GTC) as Promise<LiveOrderResponse>,
      config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
      "Polymarket order submit"
    ));

  return assertLiveOrderAccepted(response);
}

export type LiveOrderLatencyStage = {
  name: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
};

export type LiveBuyLatencyTestResult = {
  ok: true;
  tokenId: string;
  side: "BUY";
  usdAmount: number;
  bestAsk: number;
  limitPrice: number;
  size: number;
  orderType: string;
  orderID?: string;
  response: LiveOrderResponse;
  orderLookup?: unknown;
  tradeLookup?: unknown;
  cleanupCancel?: unknown;
  timestamps: Record<string, number>;
  stages: LiveOrderLatencyStage[];
  totalMs: number;
};

function nowMs() {
  return performance.now();
}

function roundMs(value: number) {
  return Math.round(value * 100) / 100;
}

function addStage(stages: LiveOrderLatencyStage[], name: string, startedAtMs: number, endedAtMs: number) {
  stages.push({
    name,
    startedAtMs: roundMs(startedAtMs),
    endedAtMs: roundMs(endedAtMs),
    durationMs: roundMs(endedAtMs - startedAtMs)
  });
}

export async function runLiveBuyLatencyTest(input: {
  marketId?: string;
  tokenId: string;
  usdAmount?: number;
  slippageCents?: number;
  tickSize?: TickSize;
  negRisk?: boolean;
}): Promise<LiveBuyLatencyTestResult> {
  assertConfiguredMarket(input.marketId);
  assertConfiguredToken(input.tokenId);

  const usdAmount = Math.max(0.01, Number(input.usdAmount ?? 1));
  const slippage = Math.max(0.01, Number(input.slippageCents ?? 2) / 100);
  const timestamps: Record<string, number> = {};
  const stages: LiveOrderLatencyStage[] = [];

  timestamps.started = nowMs();

  const bookStart = nowMs();
  const book = await fetchOrderBook(input.tokenId, { force: true, maxAgeMs: config.ORDERBOOK_STALE_MS_EMERGENCY });
  const bookEnd = nowMs();
  addStage(stages, "fresh orderbook fetch", bookStart, bookEnd);
  timestamps.orderbookReceived = bookEnd;

  if (book.bestAsk === null || book.bestAsk === undefined || !Number.isFinite(book.bestAsk)) {
    throw new HttpError(400, "Cannot run buy latency test because this token has no best ask");
  }

  const bestAsk = book.bestAsk;
  const limitPrice = Math.min(0.99, Math.max(0.01, Math.round((bestAsk + slippage) * 100) / 100));
  const size = Math.max(0.000001, Number((usdAmount / limitPrice).toFixed(6)));

  const clientStart = nowMs();
  const client = await getTradingClobClient();
  const clientEnd = nowMs();
  addStage(stages, "get trading CLOB client", clientStart, clientEnd);
  timestamps.clientReady = clientEnd;

  const userOrder = {
    tokenID: input.tokenId,
    price: limitPrice,
    size,
    side: Side.BUY
  };
  const orderOptions = {
    tickSize: input.tickSize ?? "0.01",
    ...(input.negRisk === undefined ? {} : { negRisk: input.negRisk })
  };

  const signStart = nowMs();
  const signedOrder = await withSecondPrecisionTimestamp(() => client.createOrder(userOrder, orderOptions));
  const signEnd = nowMs();
  addStage(stages, "create and sign order", signStart, signEnd);
  timestamps.orderSigned = signEnd;

  const immediateOrderType = (OrderType as unknown as Record<string, OrderType>).FAK ?? OrderType.GTC;
  const postStart = nowMs();
  const response = await withClobCircuitBreaker("latency test submit order", () => withTimeout(
    () => client.postOrder(signedOrder, immediateOrderType) as Promise<LiveOrderResponse>,
    config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
    "Polymarket latency test order submit"
  ));
  const postEnd = nowMs();
  addStage(stages, "post order HTTP round trip", postStart, postEnd);
  timestamps.orderResponse = postEnd;

  assertLiveOrderAccepted(response);

  let orderLookup: unknown;
  if (response.orderID) {
    const lookupStart = nowMs();
    try {
      orderLookup = await withClobCircuitBreaker("latency test order lookup", () => withTimeout(
        () => client.getOrder(response.orderID as string),
        config.POLYMARKET_FETCH_TIMEOUT_MS,
        "Polymarket latency test order lookup"
      ));
    } catch (error) {
      orderLookup = { error: error instanceof Error ? error.message : String(error) };
    }
    const lookupEnd = nowMs();
    addStage(stages, "order status lookup", lookupStart, lookupEnd);
    timestamps.orderLookup = lookupEnd;
  }

  let tradeLookup: unknown;
  if (response.tradeIDs?.length) {
    const tradeId = response.tradeIDs[0];
    const tradeStart = nowMs();
    try {
      tradeLookup = await withClobCircuitBreaker("latency test trade lookup", () => withTimeout(
        () => client.getTrades({ id: tradeId }),
        config.POLYMARKET_FETCH_TIMEOUT_MS,
        "Polymarket latency test trade lookup"
      ));
    } catch (error) {
      tradeLookup = { error: error instanceof Error ? error.message : String(error) };
    }
    const tradeEnd = nowMs();
    addStage(stages, "trade lookup", tradeStart, tradeEnd);
    timestamps.tradeLookup = tradeEnd;
  }

  let cleanupCancel: unknown;
  if (response.orderID && immediateOrderType === OrderType.GTC) {
    const cancelStart = nowMs();
    try {
      cleanupCancel = await withClobCircuitBreaker("latency test cleanup cancel", () => withTimeout(
        () => client.cancelOrder({ orderID: response.orderID as string }),
        config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
        "Polymarket latency test cleanup cancel"
      ));
    } catch (error) {
      cleanupCancel = { error: error instanceof Error ? error.message : String(error) };
    }
    const cancelEnd = nowMs();
    addStage(stages, "cleanup cancel if order rested", cancelStart, cancelEnd);
    timestamps.cleanupCancel = cancelEnd;
  }

  timestamps.finished = nowMs();

  return {
    ok: true,
    tokenId: input.tokenId,
    side: "BUY",
    usdAmount,
    bestAsk,
    limitPrice,
    size,
    orderType: immediateOrderType === OrderType.GTC ? "GTC" : "FAK",
    orderID: response.orderID,
    response,
    orderLookup,
    tradeLookup,
    cleanupCancel,
    timestamps: Object.fromEntries(Object.entries(timestamps).map(([key, value]) => [key, roundMs(value)])),
    stages,
    totalMs: roundMs(timestamps.finished - timestamps.started)
  };
}

export async function cancelLiveOrder(orderId: string) {
  const client = await getTradingClobClient();
  return withClobCircuitBreaker("cancel order", () => withTimeout(() => client.cancelOrder({ orderID: orderId }), config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS, "Polymarket order cancel"));
}

export async function cancelLiveMarketOrders(marketId: string) {
  assertConfiguredMarket(marketId);
  const client = await getTradingClobClient();
  if (typeof (client as unknown as { cancelMarketOrders?: unknown }).cancelMarketOrders === "function") {
    return withClobCircuitBreaker("cancel market orders", () => withTimeout(
      () => (client as unknown as { cancelMarketOrders: (market: string) => Promise<unknown> }).cancelMarketOrders(marketId),
      config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS,
      "Polymarket market order cancel"
    ));
  }
  const orders = await withClobCircuitBreaker("get open orders", () => withTimeout(() => client.getOpenOrders(), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket open orders"));
  const ids = (Array.isArray(orders) ? orders : [])
    .filter((order: { market?: string; marketId?: string }) => order.market === marketId || order.marketId === marketId)
    .map((order: { id?: string; orderID?: string }) => order.id ?? order.orderID)
    .filter((id): id is string => typeof id === "string");
  if (ids.length === 0) return { cancelled: 0 };
  const cancelOrders = (client as unknown as { cancelOrders?: (ids: string[]) => Promise<unknown> }).cancelOrders;
  return cancelOrders ? withClobCircuitBreaker("cancel order batch", () => withTimeout(() => cancelOrders(ids), config.POLYMARKET_ORDER_SUBMIT_TIMEOUT_MS, "Polymarket order cancel batch")) : undefined;
}

export async function getLiveOpenOrders() {
  const client = await getTradingClobClient();
  return withClobCircuitBreaker("get open orders", () => withTimeout(() => client.getOpenOrders(), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket open orders"));
}

export async function getLiveOrder(orderId: string) {
  const client = await getTradingClobClient();
  return withClobCircuitBreaker("get order", () => withTimeout(() => client.getOrder(orderId), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket order lookup"));
}

export async function getLiveTrades(params?: { id?: string; maker_address?: string; market?: string; asset_id?: string; before?: string; after?: string }) {
  const client = await getTradingClobClient();
  return withClobCircuitBreaker("get trades", () => withTimeout(() => client.getTrades(params), config.POLYMARKET_FETCH_TIMEOUT_MS, "Polymarket trades"));
}
